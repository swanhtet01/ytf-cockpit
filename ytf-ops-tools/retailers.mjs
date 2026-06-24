#!/usr/bin/env node
// retailers.mjs — the structured form of the YTF Retailer Database + dealer rebate sheets.
//
// "Doc as a tool": instead of reading a 300-row Burmese spreadsheet by hand, this turns
// the dealer rebate ledger into distribution intelligence — total dealers, sales by region,
// top dealers, the Nylon vs Radial product mix, and rebate-tier bands.
//
// Input : data/retailers.sample.json  (or a live pull: { dealers: [ {code,region,township,
//         shop, nylon_qty, nylon_amount, radial_qty, radial_amount} ] })
// Output: out/retailers.json
//
// Usage : node retailers.mjs [path/to/retailers.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const inPath = process.argv[2] || path.join(DIR, 'data', 'retailers.sample.json');
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });

const doc = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const dealers = (doc.dealers || []).map((d) => ({
  ...d,
  total_qty: (Number(d.nylon_qty) || 0) + (Number(d.radial_qty) || 0),
  total_amount: (Number(d.nylon_amount) || 0) + (Number(d.radial_amount) || 0),
}));

// Myanmar region/state from the dealer-code prefix (first 3 letters).
const REGION = {
  YGN: 'Yangon', MDY: 'Mandalay', MGY: 'Magway', MON: 'Mon', SHN: 'Shan',
  BGO: 'Bago', SGG: 'Sagaing', AYY: 'Ayeyarwady', NPT: 'Naypyitaw', KCN: 'Kachin',
  KYN: 'Kayin', KYH: 'Kayah', CHN: 'Chin', TNI: 'Tanintharyi', RKE: 'Rakhine',
};
const regionName = (d) => REGION[d.region] || REGION[String(d.code || '').slice(0, 3)] || d.region || 'Other';

// Rebate tier from the 6-month total amount, in lakh (သိန်း = 100,000 Kyat).
const LAKH = 100000;
function rebateTier(amountKyat) {
  const lakh = amountKyat / LAKH;
  if (lakh >= 9000) return { pct: 3.0, band: '9000+ lakh' };
  if (lakh >= 6000) return { pct: 2.75, band: '6000-9000 lakh' };
  if (lakh >= 4500) return { pct: 2.5, band: '4500-6000 lakh' };
  if (lakh >= 2250) return { pct: 2.25, band: '2250-4500 lakh' };
  return { pct: 2.0, band: '<2250 lakh' };
}

const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

const enriched = dealers
  .map((d) => ({ ...d, region_name: regionName(d), ...rebateTier(d.total_amount) }))
  .map((d) => ({ ...d, est_rebate: Math.round((d.total_amount * d.pct) / 100) }))
  .sort((a, b) => b.total_amount - a.total_amount);

// --- aggregates ---
const totals = {
  dealers: enriched.length,
  nylon_qty: sum(enriched, (d) => d.nylon_qty),
  radial_qty: sum(enriched, (d) => d.radial_qty),
  total_qty: sum(enriched, (d) => d.total_qty),
  nylon_amount: sum(enriched, (d) => d.nylon_amount),
  radial_amount: sum(enriched, (d) => d.radial_amount),
  total_amount: sum(enriched, (d) => d.total_amount),
  est_rebate: sum(enriched, (d) => d.est_rebate),
};
totals.nylon_share_pct = totals.total_qty ? Math.round((100 * totals.nylon_qty) / totals.total_qty) : 0;
totals.radial_share_pct = 100 - totals.nylon_share_pct;

const groupBy = (key) => {
  const m = new Map();
  for (const d of enriched) {
    const k = d[key];
    const g = m.get(k) || { key: k, dealers: 0, total_qty: 0, total_amount: 0 };
    g.dealers++; g.total_qty += d.total_qty; g.total_amount += d.total_amount;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.total_amount - a.total_amount);
};

const tierBands = enriched.reduce((a, d) => ((a[d.band] = (a[d.band] || 0) + 1), a), {});

const out = {
  generated_at: new Date().toISOString(),
  source: doc._source || inPath,
  period: doc._period || '',
  sample: /sample/i.test(inPath) || !!doc._note,
  note: doc._note || '',
  totals,
  by_region: groupBy('region_name'),
  by_tier: tierBands,
  top_dealers: enriched.slice(0, 15).map((d) => ({
    code: d.code, shop: d.shop, township: d.township, region: d.region_name,
    nylon_qty: d.nylon_qty, radial_qty: d.radial_qty, total_qty: d.total_qty,
    total_amount: d.total_amount, rebate_pct: d.pct, est_rebate: d.est_rebate,
  })),
};
fs.writeFileSync(path.join(outDir, 'retailers.json'), JSON.stringify(out, null, 2) + '\n');

const fmtB = (n) => (n / 1e9).toFixed(2) + 'B';
console.log('retailers — done' + (out.sample ? '  (SAMPLE — full Retailer DB pull pending)' : ''));
console.log('  dealers      :', totals.dealers);
console.log('  total units  :', totals.total_qty, `(${totals.nylon_share_pct}% nylon / ${totals.radial_share_pct}% radial)`);
console.log('  total sales  :', fmtB(totals.total_amount), 'Kyat  ·  est. rebate', fmtB(totals.est_rebate));
console.log('  regions      :', out.by_region.map((r) => `${r.key}:${r.dealers}`).join(', '));
console.log('  top dealer   :', out.top_dealers[0]?.shop, `(${out.top_dealers[0]?.region})`, fmtB(out.top_dealers[0]?.total_amount || 0));
console.log('  ->', path.join('out', 'retailers.json'));
