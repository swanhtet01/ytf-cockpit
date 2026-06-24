#!/usr/bin/env node
// stock-balance.mjs — real raw-material on-hand stock + months-of-cover, parsed straight
// from YTF's "Monthly Stock Balance" workbook (the file the factory emails every month).
//
// This is the on-hand half of the inventory picture (inventory.mjs is the in-transit half,
// from supplier email). Together: on-hand + in-transit = true stock position, with cover.
//
// Input : a "Monthly Stock Balance" .xlsx (argv[2], or auto-find in repo root / data/)
// Output: out/stock-balance.json
//
// Usage : node stock-balance.mjs ["../( 8H )Monthly Stock Balance 2023.xlsx"]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './lib/xlsx-lite.mjs';
import { parseNum } from './lib/num.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });

// resolve input: argv, else the bundled/known stock-balance workbook
function findInput() {
  if (process.argv[2]) return process.argv[2];
  // prefer the LIVE Drive cache (pulled from the Yangon Tyre folder), then archived fallbacks
  const cacheDir = path.join(DIR, 'data', 'drive-cache');
  if (fs.existsSync(cacheDir)) {
    const hit = fs.readdirSync(cacheDir)
      .filter((f) => /Monthly Stock Balance.*\.xlsx$/i.test(f) && !/raw/i.test(f))
      .sort().reverse()[0];
    if (hit) return path.join(cacheDir, hit);
  }
  const candidates = [
    path.join(DIR, 'data', 'stock-balance.xlsx'),
    path.join(DIR, '..', '( 8H )Monthly Stock Balance 2023.xlsx'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}
const inPath = findInput();
if (!fs.existsSync(inPath)) {
  console.error(`stock-balance: no input workbook (looked for ${inPath}). Pass a path or drop one in data/.`);
  process.exit(0); // soft-exit so the pipeline still runs
}

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();
const num = (v) => parseNum(v, 0);

const { sheets } = readXlsx(inPath);

// map a sheet's header row -> column indices (needs desc + closing-W/H; consumption prefers "Total")
function mapHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const row = rows[i].map(lc);
    if (!row.some((c) => c.includes('description'))) continue;
    const cols = {};
    let firstCons = null, totalCons = null; const consCols = [];
    row.forEach((h, j) => {
      if (h.includes('description')) cols.desc ??= j;
      else if (h.includes('unit')) cols.unit ??= j;
      else if (h.includes('opening')) cols.opening ??= j;
      else if (h.includes('received')) cols.received ??= j;
      else if (h.includes('consumption')) { consCols.push(j); if (firstCons == null) firstCons = j; if (h.includes('total')) totalCons = j; }
      else if ((h.includes('w/h') || (h.includes('closing') && h.includes('balance'))) && !h.includes('plant')) cols.closing ??= j;
    });
    cols.consumption = totalCons ?? firstCons ?? null;
    // component consumption columns (e.g. "for bilin" + "for compound") — used when "Total Consumption" is blank
    cols.consParts = consCols.filter((j) => j !== totalCons);
    if (cols.desc != null && cols.closing != null) return { headerRow: i, cols };
  }
  return null;
}

// some workbooks are a single yearly sheet (consumption = annual), others are 12 monthly sheets
// (consumption = that month). Pick the yearly summary if present, else the LATEST monthly sheet with data.
const isYearly = (name) => /to\s*dec|year|jan.*dec/i.test(name);
const mapped = sheets.map((s) => ({ s, m: mapHeader(s.rows) })).filter((x) => x.m);
if (!mapped.length) { console.error(`stock-balance: no stock-balance sheet in ${path.basename(inPath)}.`); process.exit(0); }
const hasData = (x) => x.s.rows.slice(x.m.headerRow + 1).some((r) => Number(String(r[x.m.cols.closing]).replace(/,/g, '')) > 0);
const pick = mapped.find((x) => isYearly(x.s.name)) || [...mapped].reverse().find(hasData) || mapped[mapped.length - 1];
const sheet = pick.s, headerRow = pick.m.headerRow, cols = pick.m.cols;
const periodType = isYearly(sheet.name) ? 'yearly' : 'monthly';

// material grouping for the dashboard
const groupOf = (d) => {
  const t = lc(d);
  if (/rss|tsr|msr|reclaim|kbr|br-?150|sbr|rubber/.test(t)) return 'rubber';
  if (/carbon|n-?\s*(220|330|550|660)/.test(t)) return 'carbon black';
  if (/zinc|stearin|aromatic|oil|tmq|ppd|antilux|anti-?ozone|wax|resin|sulphur|sulfur|accelerator|chemical/.test(t)) return 'chemicals';
  return 'other';
};

const materials = [];
for (let i = headerRow + 1; i < sheet.rows.length; i++) {
  const row = sheet.rows[i];
  const desc = norm(row[cols.desc]);
  if (!desc || !Number.isFinite(Number(row[0]))) continue;           // line items have a numeric No.
  if (/total|sub-?total|balance for/i.test(desc)) continue;
  const closing = Math.round(num(row[cols.closing])); // kill float noise (e.g. -1e-12)
  // consumption: prefer the "Total Consumption" col, but it's often blank — fall back to summing components
  let consumption = cols.consumption != null ? num(row[cols.consumption]) : 0;
  if (!(consumption > 0) && cols.consParts?.length) consumption = cols.consParts.reduce((s, j) => s + num(row[j]), 0);
  const received = cols.received != null ? num(row[cols.received]) : 0;
  const opening = cols.opening != null ? num(row[cols.opening]) : 0;
  if (closing === 0 && consumption === 0 && received === 0 && opening === 0) continue; // empty line
  const monthly = periodType === 'yearly' ? consumption / 12 : consumption; // monthly sheets already report the month's usage
  const months_cover = monthly > 0 ? +(closing / monthly).toFixed(1) : null;
  materials.push({
    material: desc, group: groupOf(desc), unit: norm(row[cols.unit]) || 'Kg',
    opening, received, consumption, closing,
    monthly_consumption: Math.round(monthly),
    months_cover,
    // 'out' only when actually consuming but empty (real stockout); a 0/0 line is dormant, not a problem
    status: (closing <= 0 && monthly > 0) ? 'out' : (months_cover != null && months_cover < 1.5) ? 'low' : 'ok',
  });
}

const byGroup = (g) => materials.filter((m) => m.group === g);
const sumClosing = (arr) => arr.reduce((a, m) => a + m.closing, 0);
const low = materials.filter((m) => m.status === 'low' || m.status === 'out')
  .sort((a, b) => (a.months_cover ?? 99) - (b.months_cover ?? 99));

const out = {
  generated_at: new Date().toISOString(),
  source: path.basename(inPath),
  period: norm(sheet.rows[1]?.[0]) || sheet.name,
  sheet: sheet.name,
  totals: {
    materials: materials.length,
    low_or_out: low.length,
    groups: { rubber: byGroup('rubber').length, 'carbon black': byGroup('carbon black').length, chemicals: byGroup('chemicals').length },
    closing_by_group_kg: {
      rubber: Math.round(sumClosing(byGroup('rubber'))),
      'carbon black': Math.round(sumClosing(byGroup('carbon black'))),
      chemicals: Math.round(sumClosing(byGroup('chemicals'))),
    },
  },
  low_cover: low.slice(0, 10),
  materials: materials.sort((a, b) => (a.months_cover ?? 999) - (b.months_cover ?? 999)),
};
fs.writeFileSync(path.join(outDir, 'stock-balance.json'), JSON.stringify(out, null, 2) + '\n');

console.log('stock-balance — done');
console.log('  source       :', out.source, '·', out.period);
console.log('  materials    :', materials.length, '·', low.length, 'low/out');
console.log('  low cover    :', low.slice(0, 6).map((m) => `${m.material.trim()}:${m.months_cover ?? '∞'}mo`).join(', ') || 'none');
console.log('  ->', path.join('out', 'stock-balance.json'));
