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
import { readXlsx } from './lib/xlsx-lite.mjs';
import { parseNum } from './lib/num.mjs';

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

function parseProduction(file) {
  let sheets;
  try { ({ sheets } = readXlsx(file)); } catch (e) { return { error: 'read failed: ' + e.message }; }
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
  return {
    totals: {
      produced, grade_a: gA, grade_b: gB, reject: gR,
      grade_a_pct: pct(gA), off_grade_pct: +(pct(gB) + pct(gR)).toFixed(1),
      active_sizes: items.filter((x) => x.total > 0).length, total_weight_mt: +(wkg / 1000).toFixed(1),
    },
    top_sizes: [...items].sort((a, b) => b.total - a.total).slice(0, 12),
  };
}

const result = { generated_at: new Date().toISOString(), plants: {}, note: '' };
const cacheRoot = path.join(DIR, 'data', 'drive-cache');

for (const plant of ['plant-a', 'plant-b']) {
  const yearOf = (s) => { const m = String(s).match(/20(2\d|1\d)/); return m ? +m[0] : 0; };
  const prodFiles = (inv.files || [])
    .filter((f) => f.plant === plant && f.category === 'production' && f.cache)
    // latest YEAR in the filename first, then most recently modified
    .sort((a, b) => yearOf(b.name) - yearOf(a.name) || (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  // prefer the standard monthly layout (latest year)
  const standard = prodFiles.filter((f) => /monthly tyre production/i.test(f.name))
    .sort((a, b) => yearOf(b.name) - yearOf(a.name))[0] || prodFiles[0];
  if (!standard) { result.plants[plant] = { available: prodFiles.length, parsed: false, reason: 'no production workbook downloaded' }; continue; }
  const full = path.join(cacheRoot, standard.cache.replace(/^scan[\\/]/, 'scan/'));
  const parsed = fs.existsSync(full) ? parseProduction(full) : { error: 'cache file missing' };
  if (parsed.error) {
    result.plants[plant] = { available: prodFiles.length, parsed: false, source: standard.name, reason: parsed.error, other_files: prodFiles.slice(0, 6).map((f) => f.name) };
  } else {
    result.plants[plant] = { parsed: true, source: standard.name, modified: (standard.modifiedTime || '').slice(0, 10), ...parsed, available: prodFiles.length };
  }
}

fs.writeFileSync(path.join(outDir, 'production-by-plant.json'), JSON.stringify(result, null, 2) + '\n');
console.log('production-by-plant — done');
for (const [p, v] of Object.entries(result.plants)) {
  if (v.parsed) console.log(`  ${p}: ${v.totals.produced.toLocaleString()} tyres · ${v.totals.active_sizes} sizes · ${v.totals.grade_a_pct}% A  (${v.source})`);
  else console.log(`  ${p}: NOT parsed — ${v.reason} (${v.available} production files available)`);
}
console.log('  ->', path.join('out', 'production-by-plant.json'));
