#!/usr/bin/env node
// brief-agent.mjs — AI-generated daily ops brief for Yangon Tyre Factory.
// Reads the structured data from other pipeline stages and asks Claude to
// produce a short, actionable brief in plain language.
// Output: out/ai-brief.json  {generated_at, brief_text, action_items, signals_used}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR    = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
const rd     = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')); } catch { return fb; } };

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.warn('[brief-agent] ANTHROPIC_API_KEY not set — skipping.'); process.exit(0); }

// --- gather data snapshot ---
const daily    = rd('daily-production.json');
const stock    = rd('stock-balance.json');
const insights = rd('insights.json');
const finance  = rd('finance.json');
const inventory= rd('inventory.json');
const quality  = rd('quality.json');
const copq     = rd('copq.json');
const trends   = rd('trends.json');

const today = new Date().toISOString().slice(0, 10);

const snapshot = {
  date: today,
  production_mtd: daily?.mtd
    ? { produced: daily.mtd.produced, target_attainment_pct: daily.mtd.attainment_pct, avg_per_day: daily.mtd.avg_per_day, grade_a_pct: daily.mtd.grade_a_pct, off_grade_pct: daily.mtd.off_grade_pct }
    : null,
  stock_alerts: (stock?.low_cover || []).slice(0, 6).map(m => ({ material: m.material, months_cover: m.months_cover, closing: m.closing, unit: m.unit })),
  critical_signals: (insights?.signals || []).filter(s => s.severity === 'critical').map(s => ({ title: s.title, detail: s.detail, recommendation: s.recommendation })),
  high_signals:     (insights?.signals || []).filter(s => s.severity === 'high').map(s => ({ title: s.title, detail: s.detail, recommendation: s.recommendation })),
  watch_signals:    (insights?.signals || []).filter(s => s.severity === 'watch').slice(0, 3).map(s => ({ title: s.title })),
  in_transit: inventory?.totals ? { shipments: inventory.totals.in_transit_shipments, mt: inventory.totals.in_transit_mt } : null,
  copq_today: copq?.totals ? { total_kyat: copq.totals.total_kyat, scrap_pct: copq.totals.scrap_pct } : null,
  quality_score: quality?.scorecard?.overall_score ?? null,
};

const SYSTEM = `You are the AI ops agent for Yangon Tyre Factory (YTF), a Myanmar tyre maker with two plants: Plant A = Yangon (bias + agricultural tyres), Plant B = Bilin (radial + motorcycle). You tell the director what needs attention RIGHT NOW.

Write a SHORT, punchy daily brief a busy director reads in 15 seconds. Rules:
- Lead with the single most urgent thing.
- brief_text = MAX 3 crisp sentences (or 3 short bullet lines), each with a hard number. No filler, no "In conclusion", no restating the headline.
- Each action item = one verb-led sentence with the owner in parentheses. Max 4.
- Plain units (tyres, kyat, days, %). Get the plant names right (A=Yangon, B=Bilin).
- If all is on-target, say so in ONE sentence and stop.`;

const USER = `Today: ${today}

Here is the live data snapshot:
${JSON.stringify(snapshot, null, 2)}

Write the brief as JSON:
{
  "headline": "one punchy sentence, the #1 thing to act on today",
  "brief_text": "MAX 3 crisp sentences/bullets, each with a hard number",
  "action_items": ["verb-led sentence (owner)", ...],
  "status": "critical|caution|ok"
}`;

let result;
try {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{ role: 'user', content: USER }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = (j.content || []).map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in Claude response');
  result = JSON.parse(m[0]);
} catch (err) {
  console.warn('[brief-agent] Claude call failed:', err.message);
  // fallback: rule-based brief from insights
  const criticals = (insights?.signals || []).filter(s => s.severity === 'critical');
  const highs     = (insights?.signals || []).filter(s => s.severity === 'high');
  result = {
    headline: criticals[0]?.title || highs[0]?.title || 'Operations running normally.',
    brief_text: [
      daily?.mtd ? `Production MTD: ${daily.mtd.produced.toLocaleString()} tyres (${daily.mtd.attainment_pct}% of target). Grade-A: ${daily.mtd.grade_a_pct}%.` : '',
      criticals.length ? `Critical: ${criticals.map(s => s.title).join('; ')}.` : '',
      highs.length ? `High priority: ${highs.map(s => s.title).join('; ')}.` : '',
    ].filter(Boolean).join('\n\n'),
    action_items: [...criticals, ...highs].slice(0, 5).map(s => s.recommendation || s.title),
    status: criticals.length ? 'critical' : highs.length ? 'caution' : 'ok',
  };
}

const out = {
  generated_at: new Date().toISOString(),
  date: today,
  status: result.status || 'ok',
  headline: result.headline || '',
  brief_text: result.brief_text || '',
  action_items: result.action_items || [],
  signals_used: { critical: snapshot.critical_signals.length, high: snapshot.high_signals.length, watch: snapshot.watch_signals.length },
};

fs.writeFileSync(path.join(outDir, 'ai-brief.json'), JSON.stringify(out, null, 2) + '\n');
console.log('[brief-agent] done —', out.status, '|', out.headline?.slice(0, 80));
console.log('  action items:', out.action_items.length);
console.log('  ->', path.join('out', 'ai-brief.json'));
