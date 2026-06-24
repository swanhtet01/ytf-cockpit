#!/usr/bin/env node
// insights.mjs — cross-module intelligence layer (the "beyond ERP" bit).
//
// An ERP shows you tables. This READS the structured modules (stock / daily production /
// production / finance / distribution) and DERIVES decision signals an ERP won't compute:
//   - days-to-stockout per material (sharper than "months cover")
//   - June month-end production projection vs target (from MTD pace)
//   - quality trend (off-grade now vs YTD)
//   - margin facts + dealer/region concentration risk
// Output: a single severity-ranked signal feed (critical > high > watch > ok).
//
// Output: out/insights.json    Usage: node insights.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')); } catch { return null; } };

const stock = rd('stock-balance.json');
const daily = rd('daily-production.json');
const prod = rd('production.json');
const finance = rd('finance.json');
const retailers = rd('retailers.json');
const orders = rd('orders.json');

const SEV = { critical: 0, high: 1, watch: 2, ok: 3 };
const signals = [];
const add = (area, severity, title, detail, metric) => signals.push({ area, severity, title, detail, metric: metric || null });
const bn = (n) => (n == null ? '—' : (n / 1e9).toFixed(1) + 'B');

// ---- 1. days-to-stockout (stock closing ÷ daily consumption) ----
// scale consumption by current production pace if we have it (more production => faster burn)
let paceFactor = 1;
if (daily?.mtd?.attainment_pct) paceFactor = Math.max(0.5, Math.min(1.5, daily.mtd.attainment_pct / 100));
if (stock?.materials) {
  // weight by consumption VOLUME — a 13kg/mo consumable hitting 0 isn't an exec signal; a
  // 59,000kg/mo core input running low is. Tiny-consumption items are dropped from the feed.
  const runway = stock.materials
    .filter((m) => m.monthly_consumption > 0 && m.closing >= 0)
    .map((m) => {
      const perDay = (m.monthly_consumption / 30) * paceFactor;
      return { material: m.material.trim(), unit: m.unit, closing: m.closing, monthly: m.monthly_consumption, days: perDay > 0 ? Math.round(m.closing / perDay) : null };
    })
    .filter((m) => m.days != null && m.days <= 45)
    .sort((a, b) => a.days - b.days);
  let shown = 0;
  for (const m of runway) {
    const big = m.monthly >= 1000, mid = m.monthly >= 300;
    let sev = null;
    if (m.days <= 7 && big) sev = 'critical';
    else if ((m.days <= 18 && big) || (m.days <= 7 && mid)) sev = 'high';
    else if (m.days <= 30 && big) sev = 'watch';
    if (!sev || shown >= 8) continue;
    shown++;
    add('inventory', sev, `${m.material} — ~${m.days} day${m.days === 1 ? '' : 's'} to stockout`,
      `${m.closing.toLocaleString()} ${m.unit} on hand, burning ~${Math.round(m.monthly / 30).toLocaleString()}/day${paceFactor !== 1 ? ` (adj. for ${daily.mtd.attainment_pct}% production pace)` : ''}. ${m.days <= 7 ? 'Expedite / reorder NOW.' : 'Reorder this week.'}`,
      { days: m.days, closing: m.closing, monthly_consumption: m.monthly });
  }
}

// ---- 2. June production: month-end projection from MTD pace ----
if (daily?.mtd?.produced && daily?.days_reported) {
  const m = daily.mtd;
  const DIM = 30; // working-day proxy; report is honest about being a projection
  const projected = Math.round(m.avg_per_day * DIM);
  const targetFull = m.target && daily.days_reported ? Math.round((m.target / daily.days_reported) * DIM) : null;
  const onPace = m.attainment_pct;
  const sev = onPace != null && onPace < 90 ? 'high' : onPace != null && onPace < 100 ? 'watch' : 'ok';
  add('production', sev, `June on pace for ~${onPace}% of target`,
    `${m.produced.toLocaleString()} tyres in ${daily.days_reported} days (${m.avg_per_day.toLocaleString()}/day). At this pace, projected month ≈ ${projected.toLocaleString()}${targetFull ? ` vs ~${targetFull.toLocaleString()} target` : ''}. Grade-A ${m.grade_a_pct}%.`,
    { mtd: m.produced, attainment_pct: onPace, projected });
}

// ---- 3. quality trend: off-grade June vs YTD ----
if (daily?.mtd?.off_grade_pct != null && prod?.totals?.off_grade_pct != null) {
  const now = daily.mtd.off_grade_pct, ytd = prod.totals.off_grade_pct;
  const delta = +(now - ytd).toFixed(1);
  const sev = now > 2 ? 'high' : now > ytd + 0.3 ? 'watch' : 'ok';
  add('quality', sev, `Off-grade ${now}% (June) vs ${ytd}% YTD ${delta <= 0 ? '— improving' : '— rising'}`,
    `Rejects+B-grade running ${now}% of June output vs ${ytd}% Jan–May. ${delta > 0.3 ? 'Watch curing/QC.' : 'Quality stable/strong.'}`,
    { june_off_grade: now, ytd_off_grade: ytd, delta });
}

// ---- 4. finance facts (margin / cash) ----
if (finance?.pl?.revenue) {
  const f = finance.pl;
  add('finance', 'ok', `Net margin ${f.net_margin_pct}% · revenue ${bn(f.revenue)} (${finance.as_of || finance.period})`,
    `Gross ${f.gross_margin_pct}% → net ${f.net_margin_pct}% (${bn(f.net_profit)} on ${bn(f.revenue)}). Cash & bank ${bn(finance.cash?.balance)}. NOTE: latest CONSOLIDATED P&L — newer half-years not yet in Excel.`,
    { net_margin_pct: f.net_margin_pct, revenue: f.revenue });
}

// ---- 5. distribution concentration risk ----
if (retailers?.top_dealers?.length && retailers?.totals?.total_amount) {
  const top = retailers.top_dealers[0];
  const topShare = +(100 * top.total_amount / retailers.totals.total_amount).toFixed(1);
  const top5 = retailers.top_dealers.slice(0, 5).reduce((a, d) => a + d.total_amount, 0);
  const top5Share = +(100 * top5 / retailers.totals.total_amount).toFixed(1);
  const sev = top5Share > 60 ? 'watch' : 'ok';
  add('distribution', sev, `Top 5 dealers = ${top5Share}% of sales`,
    `#1 ${top.shop || top.code} (${top.region}) alone is ${topShare}%. ${top5Share > 60 ? 'High concentration — revenue depends on a few dealers.' : 'Reasonably spread.'} (H2-2024 sample.)`,
    { top5_share_pct: top5Share, top_dealer_share_pct: topShare });
}

// ---- receivables: overdue dealer credit (from Galaxy iStock) ----
if (orders?.receivables?.totals) {
  const t = orders.receivables.totals, m90 = (t.aging && t.aging['90+']) || 0;
  if (t.overdue_60plus > 0) {
    const worst = (orders.receivables.by_dealer || [])[0];
    add('receivables', m90 > 0 ? 'high' : 'watch',
      `${(t.overdue_60plus / 1e6).toFixed(1)}M Kyat overdue 60+ days`,
      `${(t.outstanding / 1e6).toFixed(1)}M outstanding across ${t.dealers} dealers; ${(m90 / 1e6).toFixed(1)}M is 90+ days.${worst ? ` Worst: ${worst.dealer} (${(worst.balance / 1e6).toFixed(1)}M, ${worst.oldest_days}d).` : ''}`,
      { overdue_60plus: t.overdue_60plus, outstanding: t.outstanding });
  }
}

signals.sort((a, b) => SEV[a.severity] - SEV[b.severity]);

// insights -> ACTIONS: attach a concrete recommended next step per signal (the operator's "do this now").
const recommend = (s) => {
  const t = (s.title + ' ' + (s.detail || '')).toLowerCase();
  if (s.area === 'inventory' || s.area === 'stock' || /stockout|reorder|out of stock|cover/.test(t)) {
    if (/in[- ]?transit|eta|arriv/.test(t)) return 'Expedite the in-transit shipment; confirm ETA with the supplier (TFT/KIIC).';
    return 'Raise a purchase order now (TFT/KIIC) and check for any in-transit stock to expedite.';
  }
  if (s.area === 'production' || /attainment|target|pace|momentum/.test(t)) return 'Review line downtime + changeovers vs plan; rebalance the schedule to hit target.';
  if (s.area === 'quality' || /claim|reject|off-grade|dppm|capa|ncr/.test(t)) return 'Open a CAPA (5W1H → root cause) on the top defect; reply to the rejected/partial claims.';
  if (s.area === 'receivables' || /overdue|outstanding|receivabl|credit/.test(t)) return 'Chase the overdue dealers; pause further credit until paid; agree a payment plan on the 90+ accounts.';
  if (s.area === 'distribution' || /dealer|concentration/.test(t)) return 'Diversify dealer base; secure the top dealers with rebate/credit terms.';
  if (s.area === 'finance' || /margin|cost|profit/.test(t)) return 'Review the cost driver behind the move; confirm pricing vs landed cost.';
  return 'Review in the daily ops meeting and assign an owner.';
};
for (const s of signals) { if (s.severity !== 'ok') s.recommendation = recommend(s); }   // don't prescribe action on non-problems

const tally = signals.reduce((a, s) => ((a[s.severity] = (a[s.severity] || 0) + 1), a), {});

const out = {
  generated_at: new Date().toISOString(),
  counts: { critical: tally.critical || 0, high: tally.high || 0, watch: tally.watch || 0, ok: tally.ok || 0 },
  signals,
};
fs.writeFileSync(path.join(outDir, 'insights.json'), JSON.stringify(out, null, 2) + '\n');

console.log('insights — done');
console.log('  signals    :', signals.length, JSON.stringify(out.counts));
signals.filter((s) => s.severity === 'critical' || s.severity === 'high').forEach((s) => console.log(`  [${s.severity}] ${s.title}`));
console.log('  ->', path.join('out', 'insights.json'));
