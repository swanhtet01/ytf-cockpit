#!/usr/bin/env node
// production.mjs — finished-goods (tyre) production from the "Monthly Tyre Production" workbook.
//
// Closes the inventory loop: stock-balance.mjs = raw materials on hand, inventory.mjs = materials
// in transit, and THIS = finished tyres produced (by size, by grade A/B/R, with weight). Grade mix
// (B + R share) is a live quality signal; top sizes show the product mix.
//
// Input : a "Monthly Tyre Production" .xlsx (argv[2], or auto-find). Reads the annual summary sheet.
// Output: out/production.json
//
// Usage : node production.mjs ["path/to/Monthly Tyre Production 2025.xlsx"]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './lib/xlsx-lite.mjs';
import { parseNum } from './lib/num.mjs';
import { parseTyreSize } from './lib/tyre-size.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });

function findInput() {
  if (process.argv[2]) return process.argv[2];
  // prefer the LIVE Drive cache, then data/, then archived OneDrive locations
  const roots = [path.join(DIR, 'data', 'drive-cache'), path.join(DIR, 'data'), path.join(DIR, '..'), path.join(DIR, '..', '_tmp_ytf_ai_platform_20260324', 'data', 'extracted')];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const hit = fs.readdirSync(r).filter((f) => /Monthly Tyre Production.*\.xlsx$/i.test(f)).sort().reverse()[0];
    if (hit) return path.join(r, hit);
  }
  return path.join(DIR, 'data', 'tyre-production.xlsx');
}
const inPath = findInput();
if (!fs.existsSync(inPath)) {
  console.error(`production: no Monthly Tyre Production workbook found (looked near repo root + data/). Skipping.`);
  process.exit(0);
}

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();
const n = (v) => parseNum(v, 0);

let readErr = null, sheets = [];
try { ({ sheets } = readXlsx(inPath)); } catch (e) { readErr = e; }
if (readErr) { console.error(`production: could not read ${path.basename(inPath)} (${readErr.message}). Likely a OneDrive online-only stub — hydrate it.`); process.exit(0); }

// prefer the annual summary sheet ("Jan to December ... Production"); else first sheet with the right header
const annual = sheets.find((s) => /to\s*dec.*produc|jan.*dec.*produc|year/i.test(s.name)) ;
const candidates = annual ? [annual, ...sheets] : sheets;

function mapHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i].map(lc);
    const sizeCol = row.findIndex((h) => h.includes('tyre size') || h === 'size' || h.includes('size'));
    if (sizeCol < 0) continue;
    const cols = { size: sizeCol };
    row.forEach((h, j) => {
      if (h === 'a') cols.a ??= j;
      else if (h === 'b') cols.b ??= j;
      else if (h === 'r') cols.r ??= j;
      else if (h === 'total' && cols.total == null) cols.total = j;        // qty total (first standalone "Total")
      else if (h.includes('total') && h.includes('weight')) cols.weight ??= j;
    });
    if (cols.total != null || (cols.a != null && cols.b != null)) return { headerRow: i, cols };
  }
  return null;
}

let sheet = null, hdr = null;
for (const s of candidates) { const m = mapHeader(s.rows); if (m) { sheet = s; hdr = m; break; } }
if (!sheet) { console.error('production: could not find a production table header.'); process.exit(0); }
const { headerRow, cols } = hdr;

// product line from the sheet's title cell (e.g. "PCR Production")
const titleCell = norm(sheet.rows[0]?.[0]) || '';
const productLine = /pcr|radial/i.test(titleCell) ? 'PCR / Radial' : /nylon/i.test(titleCell) ? 'Nylon' : /\bmc\b|motor\s*cycle/i.test(titleCell) ? 'Motorcycle' : (titleCell.replace(/production.*/i, '').trim() || 'Tyres');

// The annual sheet stacks PCR then MC (then sometimes others). Bound this generator to the FIRST
// product section only — production-mc.mjs handles the MC section. Stop when we hit "MC Production"
// or any other "X Production" header. Without this we mix sections and the 249,121 grand-total ends
// up being PCR+MC combined while still labeled PCR (the 2026-06-23 audit flagged this).
let sectionEnd = sheet.rows.length;
for (let i = headerRow + 1; i < sheet.rows.length; i++) {
  const c0 = norm(sheet.rows[i][0]);
  if (/^(MC|Bias|Motor|Nylon|Tube|Flap)\s*Production\b/i.test(c0)) { sectionEnd = i; break; }
}

const items = [];
for (let i = headerRow + 1; i < sectionEnd; i++) {
  const row = sheet.rows[i];
  const size = norm(row[cols.size]);
  if (!size || /total|grand|sub-?total|percentage/i.test(size)) continue;
  const a = cols.a != null ? n(row[cols.a]) : 0;
  const b = cols.b != null ? n(row[cols.b]) : 0;
  const r = cols.r != null ? n(row[cols.r]) : 0;
  let total = cols.total != null ? n(row[cols.total]) : a + b + r;
  if (!total) total = a + b + r;
  const weight = cols.weight != null ? n(row[cols.weight]) : 0;
  if (total === 0 && a === 0 && b === 0) continue;
  items.push({ size, a, b, r, total, weight_kg: Math.round(weight) });
}

const sum = (f) => items.reduce((s, x) => s + f(x), 0);
const parsedA = sum((x) => x.a), parsedB = sum((x) => x.b), parsedR = sum((x) => x.r), parsed = sum((x) => x.total);
const wkg = sum((x) => x.weight_kg);

// The workbook states its OWN subtotals + grand total (size cell blank, A & Total numeric).
// This sheet has multiple product sub-tables; trust the grand-total row for the headline figure,
// and flag if our per-size parse drifts (so insights are reconciled, not silently wrong).
const totalRows = [];
for (let i = headerRow + 1; i < sectionEnd; i++) {                          // PCR section only
  const row = sheet.rows[i];
  const sz = norm(row[cols.size]);
  const ta = cols.a != null ? n(row[cols.a]) : 0;
  const tt = cols.total != null ? n(row[cols.total]) : 0;
  if (!sz && ta > 0 && tt > 1000) totalRows.push({ a: ta, b: cols.b != null ? n(row[cols.b]) : 0, r: cols.r != null ? n(row[cols.r]) : 0, total: tt });
}
// pick the grand-total row closest to our per-size sum (avoids any composite "PCR+MC" row at the end)
const grand = totalRows.length ? totalRows.sort((x, y) => Math.abs(x.total - parsed) - Math.abs(y.total - parsed))[0] : null;
const reported = grand ? grand.total : null;
const produced = reported != null ? reported : parsed;
const gA = grand ? grand.a : parsedA, gB = grand ? grand.b : parsedB, gR = grand ? grand.r : parsedR;
const pct = (v) => (produced ? +(100 * v / produced).toFixed(1) : 0);
const tol = reported != null ? Math.max(20, Math.round(reported * 0.005)) : 0;

// honest period: the annual sheet's title says "Jan to December" but it only sums the months that
// actually have data. Derive the real coverage from the monthly sheet names in the workbook.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// only the per-month DATA sheets ("Monthly Jan;26 A+AA"), NOT the annual/summary/weight sheets
const monthSet = new Set();
for (const s of sheets) {
  const mm = /^\s*monthly\s+([a-z]{3})/i.exec(s.name);
  if (mm && MONTHS.includes(mm[1].toLowerCase())) monthSet.add(mm[1].toLowerCase());
}
const monthsPresent = MONTHS.filter((m) => monthSet.has(m));
const yr = (norm(sheet.rows[1]?.[0]).match(/20\d\d/) || [])[0] || '2026';
const lastMonth = monthsPresent.length ? monthsPresent[monthsPresent.length - 1] : null;
const period = lastMonth ? `Jan–${lastMonth[0].toUpperCase() + lastMonth.slice(1)} ${yr} YTD (last closed: ${lastMonth[0].toUpperCase() + lastMonth.slice(1)})` : (norm(sheet.rows[1]?.[0]) || sheet.name);

const out = {
  generated_at: new Date().toISOString(),
  source: path.basename(inPath),
  period,
  as_of: lastMonth ? `${yr}-${String(MONTHS.indexOf(lastMonth) + 1).padStart(2, '0')}` : null,
  product_line: productLine,
  totals: {
    produced,
    grade_a: gA, grade_b: gB, reject: gR,
    grade_a_pct: pct(gA), grade_b_pct: pct(gB), reject_pct: pct(gR),
    off_grade_pct: +(pct(gB) + pct(gR)).toFixed(1),   // B+R = not first-grade (quality signal)
    active_sizes: items.filter((x) => x.total > 0).length,
    total_weight_mt: +(wkg / 1000).toFixed(1),
  },
  reconciliation: {
    headline_from: reported != null ? 'sheet grand-total row' : 'parsed per-size sum (no total row found)',
    reported_total: reported,
    parsed_sum: parsed,
    variance: reported != null ? parsed - reported : null,
    reconciled: reported != null ? Math.abs(parsed - reported) <= tol : null,
  },
  top_sizes: [...items].sort((a, b) => b.total - a.total).slice(0, 15),
  // scrap Pareto: which sizes WASTE THE MOST RUBBER on a quality basis (off-grade %), with a volume
  // floor so a freak 50% scrap on 4 tyres doesn't beat a 2% scrap on 10,000. Tells QC where to focus.
  scrap_pareto: items.filter((x) => x.total >= 100).map((x) => ({
    size: x.size, construction: parseTyreSize(x.size).construction,
    off: (x.b || 0) + (x.r || 0), total: x.total,
    off_pct: +(100 * ((x.b || 0) + (x.r || 0)) / x.total).toFixed(1),
  })).sort((a, b) => b.off_pct - a.off_pct).slice(0, 12),
};
fs.writeFileSync(path.join(outDir, 'production.json'), JSON.stringify(out, null, 2) + '\n');

console.log('production — done');
console.log('  source       :', out.source, '·', out.product_line, '·', out.period);
console.log('  produced     :', produced.toLocaleString(), 'tyres ·', out.totals.active_sizes, 'sizes ·', out.totals.total_weight_mt, 'mt');
console.log('  grade mix    :', `A ${out.totals.grade_a_pct}% / B ${out.totals.grade_b_pct}% / R ${out.totals.reject_pct}%  (off-grade ${out.totals.off_grade_pct}%)`);
console.log('  reconcile    :', reported != null ? `reported ${reported.toLocaleString()} vs parsed ${parsed.toLocaleString()} (Δ${out.reconciliation.variance}, ${out.reconciliation.reconciled ? 'OK' : 'CHECK'})` : 'no total row found — used parsed sum');
console.log('  top size     :', out.top_sizes[0]?.size, out.top_sizes[0]?.total.toLocaleString());
console.log('  ->', path.join('out', 'production.json'));
