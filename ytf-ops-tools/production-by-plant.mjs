#!/usr/bin/env node
// production-by-plant.mjs — REAL per-plant tyre production, parsed from the per-plant workbooks the
// crawler downloaded into data/drive-cache/scan/. Only the standard "Monthly Tyre Production" layout
// is parsed (same as production.mjs); other layouts (Plant B "Daily Conclusion", defect runs) are
// reported as available-but-unparsed rather than guessed — honesty over fabricated splits.
//
// Output: out/production-by-plant.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSheet } from './lib/read-sheet.mjs';
import { parseNum } from './lib/num.mjs';
import { parseTyreSize } from './lib/tyre-size.mjs';

// owner email → plant (ground truth). Bilin = Plant B (radial/MC); Yangon QC/PD/SPT = Plant A (bias/ag).
function ownerPlant(owner) {
  const o = String(owner || '').toLowerCase();
  if (o.includes('yangontyrefactory.bilin')) return 'plant-b';
  if (o.includes('ytqc2019') || o.includes('ytpdoffice01') || o.includes('yangontyrefactory.spt')) return 'plant-a';
  return null;
}

// AI fallback: when the regex parser can't read a layout (bias .xls, daily-conclusion, etc.),
// let Claude read the actual cell grid and return clean per-size production. Layout-agnostic.
async function aiParseProduction(sheets, fileName) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: 'no AI key' };
  // compact the workbook to a token-bounded TSV (biggest/summary sheets first)
  const ordered = [...sheets].sort((a, b) => (/total|summary|year|annual/i.test(b.name) ? 1e6 : b.rows.length) - (/total|summary|year|annual/i.test(a.name) ? 1e6 : a.rows.length));
  let budget = 9000; const parts = [];
  for (const s of ordered.slice(0, 3)) {
    if (budget <= 0) break;
    const rows = s.rows.slice(0, 70).map((r) => (r || []).slice(0, 16).map((c) => String(c == null ? '' : c).slice(0, 18)).join('\t'));
    const blk = `# Sheet: ${s.name}\n${rows.join('\n')}`.slice(0, budget);
    parts.push(blk); budget -= blk.length;
  }
  const prompt = `Read this tyre-factory production workbook ("${fileName}") and return ONLY JSON with the TOTAL tyres produced by size for the period it covers:
{"period":"e.g. Jan-May 2026 / 2026 YTD / null","total_produced":number,"grade_a_pct":number|null,"sizes":[{"size":"e.g. 8.25/9.00-16 or 145R12C","total":number,"grade_a":number|null}]}
Rules: read Burmese. "A"=grade-A(good), "B"=grade-B, "R"=reject. total = A+B+R per size if not given. Sum only real production rows (skip headers/subtotals/percentage rows). grade_a_pct = 100*sumA/sumTotal. If you cannot find a production table, return {"total_produced":0,"sizes":[]}. Numbers only, no commas/units.

WORKBOOK:
${parts.join('\n\n')}`;
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.PROD_AI_MODEL || 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch (e) { return { error: 'ai fetch: ' + e.message }; }
  if (!res.ok) return { error: `ai ${res.status}` };
  const j = await res.json();
  const t = (j.content || []).map((c) => c.text || '').join('');
  const m = t.match(/\{[\s\S]*\}/); if (!m) return { error: 'ai no json' };
  let d; try { d = JSON.parse(m[0]); } catch { return { error: 'ai parse' }; }
  const sizes = (d.sizes || []).filter((s) => s.size && Number(s.total) > 0);
  const produced = Number(d.total_produced) || sizes.reduce((a, s) => a + (Number(s.total) || 0), 0);
  if (!produced) return { error: 'ai found no production' };
  const gradeA = d.grade_a_pct != null ? Number(d.grade_a_pct) : null;
  if (gradeA != null && (gradeA < 40 || gradeA > 100)) return { error: `ai implausible grade ${gradeA}%` };
  const radialVol = sizes.filter((s) => parseTyreSize(s.size).construction === 'radial').reduce((a, s) => a + (Number(s.total) || 0), 0);
  const biasVol = sizes.filter((s) => parseTyreSize(s.size).construction === 'bias').reduce((a, s) => a + (Number(s.total) || 0), 0);
  return {
    ai: true,
    period_hint: d.period || null,
    totals: { produced, grade_a_pct: gradeA, active_sizes: sizes.length, total_weight_mt: 0 },
    construction_mix: { radial: radialVol, bias: biasVol, dominant: radialVol >= biasVol ? 'radial' : 'bias' },
    top_sizes: sizes.map((s) => ({ size: s.size, total: Number(s.total) || 0, a: Number(s.grade_a) || 0, b: 0, r: 0, weight_kg: 0 })).sort((a, b) => b.total - a.total).slice(0, 12),
  };
}

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });

const invPath = path.join(DIR, 'data', 'drive-inventory.json');
if (!fs.existsSync(invPath)) { console.error('production-by-plant: no drive-inventory.json. Skipping.'); process.exit(0); }
const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();
const n = (v) => parseNum(v, 0);

// reusable: map a production header row → column indexes (mirrors production.mjs)
function mapHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const row = rows[i].map(lc);
    const sizeCol = row.findIndex((h) => h.includes('size'));
    if (sizeCol < 0) continue;
    const cols = { size: sizeCol };
    row.forEach((h, j) => {
      if (h === 'a') cols.a ??= j;
      else if (h === 'b') cols.b ??= j;
      else if (h === 'r') cols.r ??= j;
      else if (h === 'total' && cols.total == null) cols.total = j;
      else if (h.includes('total') && h.includes('weight')) cols.weight ??= j;
    });
    if (cols.total != null || (cols.a != null && cols.b != null)) return { headerRow: i, cols };
  }
  return null;
}

async function parseProduction(file) {
  let sheets;
  try { ({ sheets } = await readSheet(file)); } catch (e) { return { error: 'read failed: ' + e.message }; }
  const annual = sheets.find((s) => /to\s*dec.*produc|jan.*dec.*produc|year/i.test(s.name));
  const candidates = annual ? [annual, ...sheets] : sheets;
  let sheet = null, hdr = null;
  for (const s of candidates) { const m = mapHeader(s.rows); if (m) { sheet = s; hdr = m; break; } }
  if (!sheet) return { error: 'no production table header (unrecognised layout)' };
  const { headerRow, cols } = hdr;

  let sectionEnd = sheet.rows.length;
  for (let i = headerRow + 1; i < sheet.rows.length; i++) {
    if (/^(MC|Bias|Motor|Nylon|Tube|Flap)\s*Production\b/i.test(norm(sheet.rows[i][0]))) { sectionEnd = i; break; }
  }
  const items = [];
  for (let i = headerRow + 1; i < sectionEnd; i++) {
    const row = sheet.rows[i];
    const size = norm(row[cols.size]);
    if (!size || /total|grand|sub-?total|percentage/i.test(size)) continue;
    const a = cols.a != null ? n(row[cols.a]) : 0, b = cols.b != null ? n(row[cols.b]) : 0, r = cols.r != null ? n(row[cols.r]) : 0;
    let total = cols.total != null ? n(row[cols.total]) : a + b + r; if (!total) total = a + b + r;
    const weight = cols.weight != null ? n(row[cols.weight]) : 0;
    if (total === 0 && a === 0 && b === 0) continue;
    items.push({ size, a, b, r, total, weight_kg: Math.round(weight) });
  }
  if (!items.length) return { error: 'header found but no data rows' };
  const sum = (f) => items.reduce((s, x) => s + f(x), 0);
  const produced = sum((x) => x.total), gA = sum((x) => x.a), gB = sum((x) => x.b), gR = sum((x) => x.r), wkg = sum((x) => x.weight_kg);
  const pct = (v) => (produced ? +(100 * v / produced).toFixed(1) : 0);
  // construction mix is the REAL plant arbiter: radial/MC = Plant B (Bilin), bias = Plant A (Yangon)
  const radialVol = items.filter((x) => parseTyreSize(x.size).construction === 'radial').reduce((s, x) => s + x.total, 0);
  const biasVol = items.filter((x) => parseTyreSize(x.size).construction === 'bias').reduce((s, x) => s + x.total, 0);
  const gradeApct = pct(gA);
  // PLAUSIBILITY GUARD — a real production sheet has high grade-A (typically 95%+). A grade-A under
  // ~55% means the A/B/R columns were misread (e.g. an ABR/QC weekly with a different layout). Reject
  // rather than ship a wrong number (this is what produced the bogus "856 @ 9.7%").
  if (gA + gB + gR > 0 && gradeApct < 55) return { error: `implausible grade-A ${gradeApct}% — likely misread columns` };
  return {
    totals: {
      produced, grade_a: gA, grade_b: gB, reject: gR,
      grade_a_pct: gradeApct, off_grade_pct: +(pct(gB) + pct(gR)).toFixed(1),
      active_sizes: items.filter((x) => x.total > 0).length, total_weight_mt: +(wkg / 1000).toFixed(1),
    },
    construction_mix: { radial: radialVol, bias: biasVol, dominant: radialVol >= biasVol ? 'radial' : 'bias' },
    top_sizes: [...items].sort((a, b) => b.total - a.total).slice(0, 12),
  };
}

const result = { generated_at: new Date().toISOString(), plants: {}, note: 'Plant is decided by the file OWNER (Bilin=Plant B, Yangon=Plant A); every size in a plant\'s own file counts for that plant — Plant A makes some radial too. Construction is only a fallback when owner is unknown.' };
const cacheRoot = path.join(DIR, 'data', 'drive-cache');
const yearOf = (s) => { const m = String(s).match(/20(2\d|1\d)/); return m ? +m[0] : 0; };
const JUNK = /\bsample\b|\bcopy of\b|_not order_|\btemplate\b|\btest\b|draft|\bold\b|backup|government/i;
// full-period files (yearly/monthly summaries) beat weekly/daily/ABR partials for the headline figure
const coverage = (n) => /yearly|annual|jan.*dec|monthly tyre|with wt/i.test(n) ? 3 : /monthly/i.test(n) ? 2 : /\babr\b|week|daily/i.test(n) ? 0 : 1;

// parse EVERY downloaded production file; route by OWNER first, construction as fallback
const parsedFiles = [];
for (const f of (inv.files || [])) {
  if (f.category !== 'production' || !f.cache || JUNK.test(f.name)) continue;
  const full = path.join(cacheRoot, f.cache.replace(/^scan[\\/]/, 'scan/'));
  if (!fs.existsSync(full)) continue;
  let p = await parseProduction(full);
  if (p.error || !p.totals || !p.totals.produced) {
    // structured parser failed (unrecognised layout / .xls) → AI fallback reads the grid
    let sheets = null; try { ({ sheets } = await readSheet(full)); } catch {}
    if (sheets) { const ai = await aiParseProduction(sheets, f.name); if (!ai.error && ai.totals?.produced) p = ai; }
  }
  if (p.error || !p.totals || !p.totals.produced) { if (p.error) console.error(`  · skip ${f.name.slice(0,40)}: ${p.error}`); continue; }
  const plant = ownerPlant(f.owner) || (p.construction_mix.dominant === 'radial' ? 'plant-b' : 'plant-a');
  parsedFiles.push({ name: f.name, modified: f.modifiedTime, year: yearOf(f.name), cover: coverage(f.name), plant, method: p.ai ? 'AI-read' : 'parsed', ...p });
}

for (const plant of ['plant-a', 'plant-b']) {
  const cands = parsedFiles.filter((f) => f.plant === plant)
    // prefer full-period, then latest year, then freshest
    .sort((a, b) => b.cover - a.cover || b.year - a.year || (b.modified || '').localeCompare(a.modified || ''));
  if (!cands.length) { result.plants[plant] = { parsed: false, available: 0, reason: 'no reliable production file (unreadable or implausible parse)' }; continue; }
  const best = cands[0];
  const period = best.period_hint || (best.cover >= 3 ? `full-year ${best.year || ''}`.trim() : best.cover === 2 ? `monthly ${best.year || ''}`.trim() : 'latest report');
  result.plants[plant] = { parsed: true, source: best.name, period, method: best.method || 'parsed', modified: (best.modified || '').slice(0, 10), totals: best.totals, construction_mix: best.construction_mix, top_sizes: best.top_sizes, available: cands.length };
}

fs.writeFileSync(path.join(outDir, 'production-by-plant.json'), JSON.stringify(result, null, 2) + '\n');
console.log('production-by-plant — done');
for (const [p, v] of Object.entries(result.plants)) {
  if (v.parsed) console.log(`  ${p}: ${v.totals.produced.toLocaleString()} tyres · ${v.totals.active_sizes} sizes · ${v.totals.grade_a_pct}% A  (${v.source})`);
  else console.log(`  ${p}: NOT parsed — ${v.reason} (${v.available} production files available)`);
}
console.log('  ->', path.join('out', 'production-by-plant.json'));
