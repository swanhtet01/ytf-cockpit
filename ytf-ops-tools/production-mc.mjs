#!/usr/bin/env node
// production-mc.mjs — MOTORCYCLE (MC) tyre production, the line the PCR/Radial report omits.
// The "Monthly Tyre Production" workbook's annual sheet has a second section ("MC Production")
// below the PCR table. This parses that section so the cockpit shows the WHOLE factory output,
// not just car/radial. Output: out/production-mc.json (same shape as production.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './lib/xlsx-lite.mjs';
import { parseNum } from './lib/num.mjs';
import { parseTyreSize } from './lib/tyre-size.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const n = (v) => parseNum(v, 0);

function findInput() {
  if (process.argv[2]) return process.argv[2];
  const roots = [path.join(DIR, 'data', 'drive-cache'), path.join(DIR, 'data'), path.join(DIR, '..')];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const hit = fs.readdirSync(r).filter((f) => /Monthly Tyre Production.*\.xlsx$/i.test(f)).sort().reverse()[0];
    if (hit) return path.join(r, hit);
  }
  return null;
}
const inPath = findInput();
if (!inPath || !fs.existsSync(inPath)) { console.error('production-mc: no Monthly Tyre Production workbook found. Skipping.'); process.exit(0); }

let sheets = [];
try { ({ sheets } = readXlsx(inPath)); } catch (e) { console.error('production-mc: could not read workbook (' + e.message + ').'); process.exit(0); }

// annual summary sheet holds both PCR and MC sections
const annual = sheets.find((s) => /to\s*dec.*produc|jan.*dec.*produc/i.test(s.name)) || sheets[0];
const rows = annual.rows;
const mcStart = rows.findIndex((r) => /^\s*MC Production/i.test(norm(r[0])));
if (mcStart < 0) { console.error('production-mc: no "MC Production" section in the annual sheet. Skipping.'); process.exit(0); }

// header within the next few rows: find the row that has "tyre size" + A/B/R/Total
let hdr = -1, cols = null;
for (let i = mcStart; i < Math.min(mcStart + 6, rows.length); i++) {
  const lc = rows[i].map((c) => norm(c).toLowerCase());
  const size = lc.findIndex((h) => h.includes('size'));
  if (size < 0) continue;
  const c = { size };
  lc.forEach((h, j) => {
    if (h === 'a') c.a ??= j; else if (h === 'b') c.b ??= j; else if (h === 'r') c.r ??= j;
    else if (h === 'total' && c.total == null) c.total = j;
    else if (h.includes('total') && h.includes('weight')) c.weight ??= j;
  });
  if (c.total != null && c.a != null) { hdr = i; cols = c; break; }
}
if (hdr < 0) { console.error('production-mc: could not map the MC table header. Skipping.'); process.exit(0); }

const items = [];
const grandCandidates = [];
for (let i = hdr + 1; i < rows.length; i++) {
  const row = rows[i];
  const size = norm(row[cols.size]);
  // stop if we hit a different product section
  if (/^[A-Za-z].*Production\b/i.test(size) && !/mc/i.test(size)) break;
  const a = n(row[cols.a]), b = n(row[cols.b]), r = n(row[cols.r]);
  let total = cols.total != null ? n(row[cols.total]) : a + b + r;
  if (!total) total = a + b + r;
  const weight = cols.weight != null ? n(row[cols.weight]) : 0;
  if (!size && a > 0 && total > 1000) { grandCandidates.push({ a, b, r, total }); continue; } // total row (blank size)
  if (!size || /total|grand|percentage/i.test(size)) continue;
  if (total === 0 && a === 0 && b === 0) continue;
  items.push({ size, a, b, r, total, weight_kg: Math.round(weight) });
}

const sum = (f) => items.reduce((s, x) => s + f(x), 0);
const parsed = sum((x) => x.total), parsedA = sum((x) => x.a), parsedB = sum((x) => x.b), parsedR = sum((x) => x.r);
// the MC grand-total row is the one closest to our per-size sum (avoids a combined PCR+MC row)
const grand = grandCandidates.length
  ? grandCandidates.sort((x, y) => Math.abs(x.total - parsed) - Math.abs(y.total - parsed))[0]
  : null;
const produced = grand ? grand.total : parsed;
const gA = grand ? grand.a : parsedA, gB = grand ? grand.b : parsedB, gR = grand ? grand.r : parsedR;
const pct = (v) => (produced ? +(100 * v / produced).toFixed(1) : 0);
const tol = grand ? Math.max(20, Math.round(produced * 0.005)) : 0;

// reuse production.json's period if present (same workbook coverage), else derive year
let period = null, as_of = null;
try { const p = JSON.parse(fs.readFileSync(path.join(outDir, 'production.json'), 'utf8')); period = p.period; as_of = p.as_of; } catch {}

const out = {
  generated_at: new Date().toISOString(),
  source: path.basename(inPath),
  product_line: 'Motorcycle (MC)',
  period: period || 'YTD',
  as_of,
  totals: {
    produced,
    grade_a: gA, grade_b: gB, reject: gR,
    grade_a_pct: pct(gA), grade_b_pct: pct(gB), reject_pct: pct(gR),
    off_grade_pct: +(pct(gB) + pct(gR)).toFixed(1),
    active_sizes: items.filter((x) => x.total > 0).length,
    total_weight_mt: +(sum((x) => x.weight_kg) / 1000).toFixed(1),
  },
  reconciliation: {
    headline_from: grand ? 'sheet grand-total row' : 'parsed per-size sum',
    reported_total: grand ? grand.total : null,
    parsed_sum: parsed,
    variance: grand ? parsed - grand.total : null,
    reconciled: grand ? Math.abs(parsed - grand.total) <= tol : null,
  },
  top_sizes: [...items].sort((a, b) => b.total - a.total).slice(0, 15),
  scrap_pareto: items.filter((x) => x.total >= 100).map((x) => ({
    size: x.size, construction: parseTyreSize(x.size).construction,
    off: (x.b || 0) + (x.r || 0), total: x.total,
    off_pct: +(100 * ((x.b || 0) + (x.r || 0)) / x.total).toFixed(1),
  })).sort((a, b) => b.off_pct - a.off_pct).slice(0, 12),
};
fs.writeFileSync(path.join(outDir, 'production-mc.json'), JSON.stringify(out, null, 2) + '\n');
console.log('production-mc — done');
console.log('  produced     :', produced.toLocaleString(), 'MC tyres ·', out.totals.active_sizes, 'sizes ·', out.totals.total_weight_mt, 'mt');
console.log('  grade mix    :', `A ${out.totals.grade_a_pct}% / off-grade ${out.totals.off_grade_pct}%`);
console.log('  reconcile    :', grand ? `reported ${grand.total.toLocaleString()} vs parsed ${parsed.toLocaleString()} (${out.reconciliation.reconciled ? 'OK' : 'CHECK'})` : 'parsed sum');
console.log('  ->', path.join('out', 'production-mc.json'));
