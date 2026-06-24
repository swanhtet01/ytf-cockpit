#!/usr/bin/env node
// galaxy-istock.mjs — adapter: Galaxy iStock Enterprise stock export (per site) -> cockpit schema.
//
// Galaxy iStock becomes the system-of-record for inventory at each site. Export its Stock /
// Stock-Ledger report to Excel and run this — it maps Galaxy's columns (Item Code/Name, Unit,
// Opening, Inward/Receipt, Outward/Issue, Closing, Value) into the SAME shape stock-balance.mjs
// emits, tagged by --site, so the existing inventory + insights (days-to-stockout) just work.
//
// Input : a Galaxy iStock stock export .xlsx/.csv (argv[2])
//         --site=factory-a|factory-b|showroom|head-office   (default: from filename or "unknown")
// Output: out/galaxy-<site>.json
//
// Usage : node galaxy-istock.mjs "Galaxy Stock - Plant A (June).xlsx" --site=factory-a

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx, densify } from './lib/xlsx-lite.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const inPath = args.find((a) => !a.startsWith('--'));
const site = (args.find((a) => a.startsWith('--site=')) || '').replace('--site=', '') ||
  (/(plant|factory)\s*a|bilin/i.test(inPath || '') ? 'factory-a'
    : /(plant|factory)\s*b|spt/i.test(inPath || '') ? 'factory-b'
    : /showroom/i.test(inPath || '') ? 'showroom' : 'unknown');

if (!inPath || !fs.existsSync(inPath)) {
  console.error('galaxy-istock: pass a Galaxy iStock export path. Usage: node galaxy-istock.mjs <export.xlsx> --site=factory-a');
  process.exit(1);
}

const lc = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const num = (v) => { const x = Number(String(v).replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };

// Galaxy/iStock column synonyms -> our fields
const COLMAP = [
  ['code', (h) => /item\s*code|product\s*code|sku|^code$/.test(h)],
  ['name', (h) => /item\s*name|description|particular|product\s*name|stock\s*name/.test(h)],
  ['unit', (h) => /unit|uom/.test(h)],
  ['opening', (h) => /opening|op\.?\s*bal|b\/?f/.test(h)],
  ['inward', (h) => /inward|receipt|received|purchase|in\b|grn/.test(h)],
  ['outward', (h) => /outward|issue|issued|sale|consumption|out\b/.test(h)],
  ['closing', (h) => /closing|clos\.?\s*bal|balance|c\/?f|on\s*hand/.test(h)],
  ['value', (h) => /value|amount|stock\s*value/.test(h)],
];

const { sheets } = readXlsx(inPath, { densify: true });
// pick the sheet + header row that maps the most fields
let best = null;
for (const s of sheets) {
  for (let i = 0; i < Math.min(s.rows.length, 15); i++) {
    const row = s.rows[i].map(lc);
    if (!row.some((c) => /item|description|particular|stock\s*name/.test(c))) continue;
    const cols = {};
    row.forEach((h, j) => { for (const [field, test] of COLMAP) if (cols[field] == null && test(h)) cols[field] = j; });
    const score = Object.keys(cols).length;
    if ((cols.name != null || cols.code != null) && cols.closing != null && (!best || score > best.score)) best = { sheet: s, headerRow: i, cols, score };
  }
}
if (!best) { console.error(`galaxy-istock: could not find a stock table (need Item + Closing columns) in ${path.basename(inPath)}.`); process.exit(1); }

const { sheet, headerRow, cols } = best;
const groupOf = (d) => {
  const t = lc(d);
  if (/rss|tsr|msr|reclaim|kbr|br-?150|sbr|rubber/.test(t)) return 'rubber';
  if (/carbon|n-?\s*\d{3}/.test(t)) return 'carbon black';
  if (/tyre|tire|tube|flap|radial|nylon|\bmc\b/.test(t)) return 'finished goods';
  if (/zinc|stearin|oil|tmq|ppd|wax|resin|sulphur|sulfur|chemical|accelerator/.test(t)) return 'chemicals';
  return 'other';
};

const materials = [];
for (let i = headerRow + 1; i < sheet.rows.length; i++) {
  const r = sheet.rows[i];
  const name = String(r[cols.name] ?? r[cols.code] ?? '').replace(/\s+/g, ' ').trim();
  if (!name || /total|grand|sub-?total/i.test(name)) continue;
  const closing = Math.round(num(r[cols.closing]));
  const outward = cols.outward != null ? num(r[cols.outward]) : 0;
  const inward = cols.inward != null ? num(r[cols.inward]) : 0;
  const opening = cols.opening != null ? num(r[cols.opening]) : 0;
  if (closing === 0 && outward === 0 && inward === 0 && opening === 0) continue;
  // Galaxy export is typically a period (often a month) — treat outward as the period consumption
  const months_cover = outward > 0 ? +(closing / outward).toFixed(1) : null;
  materials.push({
    code: cols.code != null ? String(r[cols.code] ?? '').trim() : '',
    material: name, group: groupOf(name), unit: cols.unit != null ? String(r[cols.unit] ?? '').trim() : '',
    opening, inward, outward, closing,
    value: cols.value != null ? Math.round(num(r[cols.value])) : null,
    months_cover,
    status: (closing <= 0 && outward > 0) ? 'out' : (months_cover != null && months_cover < 1.5) ? 'low' : 'ok',
  });
}

const low = materials.filter((m) => m.status === 'low' || m.status === 'out').sort((a, b) => (a.months_cover ?? 99) - (b.months_cover ?? 99));
const out = {
  generated_at: new Date().toISOString(),
  source: path.basename(inPath),
  system: 'Galaxy iStock Enterprise',
  site,
  sheet: sheet.name,
  totals: {
    items: materials.length,
    low_or_out: low.length,
    closing_value: materials.some((m) => m.value != null) ? materials.reduce((a, m) => a + (m.value || 0), 0) : null,
  },
  low_cover: low.slice(0, 12),
  materials: materials.sort((a, b) => (a.months_cover ?? 999) - (b.months_cover ?? 999)),
};
fs.writeFileSync(path.join(outDir, `galaxy-${site}.json`), JSON.stringify(out, null, 2) + '\n');

console.log('galaxy-istock — done');
console.log('  site       :', site, '· source', out.source, '· sheet', sheet.name);
console.log('  mapped cols:', JSON.stringify(cols));
console.log('  items      :', materials.length, '·', low.length, 'low/out', out.totals.closing_value != null ? `· value ${(out.totals.closing_value / 1e9).toFixed(2)}B` : '');
console.log('  ->', path.join('out', `galaxy-${site}.json`));
