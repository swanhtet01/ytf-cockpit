#!/usr/bin/env node
// ai-extract.mjs — AI-native extraction of the messy real spreadsheets the crawler downloaded.
// Instead of brittle per-file regex parsers, feed each sheet's cell grid to Claude and get back
// structured operational metrics. Robust to Burmese headers + idiosyncratic layouts. Cached by
// fileId+modifiedTime so steady-state cost is ~0 (only changed files re-extract).
//
// Output: out/ai-extracts.json  (consumed by pipeline.mjs → feed.ai_extracts)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './lib/xlsx-lite.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
const dataDir = path.join(DIR, 'data');
fs.mkdirSync(outDir, { recursive: true });

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_EXTRACT_MODEL || 'claude-sonnet-4-6';
// under drive-cache/ so the CI actions/cache persists it across runs (steady-state cost ~0)
const CACHE_PATH = path.join(dataDir, 'drive-cache', 'ai-extract-cache.json');
const MAX_FILES = Number(process.env.AI_EXTRACT_MAX || 14); // cap Claude calls per run

const invPath = path.join(dataDir, 'drive-inventory.json');
if (!fs.existsSync(invPath)) { console.error('ai-extract: no drive-inventory.json. Skipping.'); process.exit(0); }
if (!KEY) { console.error('ai-extract: ANTHROPIC_API_KEY not set. Skipping.'); process.exit(0); }
const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));
let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch {}

// pick the freshest 1-2 downloaded files per (plant, category) for the categories that drive the
// "empty/zero" screens. These are the ones whose numbers the app shows.
const TARGET_CATS = { sales: 2, quality: 2, finance: 2, production: 1, 'daily-production': 1, stock: 1 };
const buckets = {};
for (const f of inv.files || []) {
  if (!f.cache || !f.spreadsheet) continue;
  if (!(f.category in TARGET_CATS)) continue;
  const k = `${f.plant}/${f.category}`;
  (buckets[k] = buckets[k] || []).push(f);
}
let picks = [];
for (const [k, arr] of Object.entries(buckets)) {
  const cat = k.split('/')[1];
  arr.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  picks.push(...arr.slice(0, TARGET_CATS[cat]));
}
picks = picks.slice(0, MAX_FILES);

// compact a workbook into a token-bounded TSV the model can read
function compact(file) {
  const full = path.join(dataDir, 'drive-cache', file.cache.replace(/^scan[\\/]/, 'scan/'));
  if (!fs.existsSync(full)) return null;
  let sheets; try { ({ sheets } = readXlsx(full)); } catch { return null; }
  const parts = [];
  let budget = 9000;
  // prefer sheets that look like summaries/totals or the latest month
  const ordered = [...sheets].sort((a, b) => scoreSheet(b) - scoreSheet(a));
  for (const s of ordered.slice(0, 4)) {
    if (budget <= 0) break;
    const rows = s.rows.slice(0, 60).map((r) => r.slice(0, 14).map((c) => String(c == null ? '' : c).slice(0, 22)).join('\t'));
    const block = `# Sheet: ${s.name}\n${rows.join('\n')}`;
    parts.push(block.slice(0, budget));
    budget -= block.length;
  }
  return parts.join('\n\n');
}
function scoreSheet(s) {
  const n = (s.name || '').toLowerCase();
  let sc = s.rows.length;
  if (/total|summary|annual|year|grand|conclusion/.test(n)) sc += 5000;
  if (/jun|june|may|2026/.test(n)) sc += 2000;
  return sc;
}

const PROMPT = (file) => `You are extracting structured operational metrics from a Yangon Tyre Factory spreadsheet (may contain Burmese). File: "${file.name}" · plant: ${file.plant} · category: ${file.category}.
Return ONLY a JSON object with what you can confidently read:
{"headline":"one-sentence English summary of what this file shows","period":"e.g. 2026 / Jan-Jun 2026 / null","metrics":[{"label":"English metric name","value":number,"unit":"pcs|kg|MMK|%|null"}],"breakdown":[{"key":"size/dealer/section/status name","value":number,"unit":"..."}],"confidence":0.0}
Rules: numbers as numbers (strip commas/units). Only include metrics you actually see — never invent. If the sheet is unreadable/empty, return {"headline":"unreadable","metrics":[],"breakdown":[],"confidence":0}. Max 8 metrics, max 12 breakdown rows (the largest).

SPREADSHEET:
${compact(file)}`;

async function extract(file) {
  const body = compact(file);
  if (!body) return { error: 'cache missing' };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: PROMPT(file) }] }),
  });
  if (!res.ok) return { error: `claude ${res.status}: ${(await res.text()).slice(0, 150)}` };
  const j = await res.json();
  const t = (j.content || []).map((c) => c.text || '').join('');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return { error: 'no json' };
  try { return JSON.parse(m[0]); } catch (e) { return { error: 'parse: ' + e.message }; }
}

const results = [];
let calls = 0, hits = 0;
for (const f of picks) {
  const ck = `${f.fileId}:${f.modifiedTime}`;
  if (cache[ck] && !cache[ck].error) { results.push({ ...meta(f), ...cache[ck] }); hits++; continue; }
  const ex = await extract(f);
  cache[ck] = ex;
  calls++;
  results.push({ ...meta(f), ...ex });
  console.log(`  ${ex.error ? '✗' : '✓'} ${f.plant.padEnd(8)} ${f.category.padEnd(14)} ${(ex.headline || ex.error || '').slice(0, 60)}`);
}
function meta(f) { return { name: f.name, plant: f.plant, category: f.category, modified: (f.modifiedTime || '').slice(0, 10) }; }

fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

// aggregate by category + plant for the app
const byCat = {};
for (const r of results) {
  if (r.error || !r.metrics) continue;
  (byCat[r.category] = byCat[r.category] || []).push(r);
}
const out = {
  generated_at: new Date().toISOString(),
  model: MODEL,
  extracted: results.filter((r) => !r.error).length,
  files: results,
  by_category: byCat,
};
fs.writeFileSync(path.join(outDir, 'ai-extracts.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`ai-extract — ${out.extracted}/${picks.length} files (${calls} new calls, ${hits} cached) → out/ai-extracts.json`);
