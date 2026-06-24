#!/usr/bin/env node
// sites.mjs — the SITE dimension for YTF. Maps the real data owners → the 4 physical sites
// (Factory A / Factory B / Showroom / Head Office) so the cockpit can segment by location and
// so Galaxy iStock Enterprise (per-site stock) plugs into a known structure.
//
// Output: out/sites.json   (consumed by ../supermega-remote/pipeline.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });

// canonical sites + which Drive owners report for them (derived from the live data flows)
const SITES = [
  { key: 'factory-a', name: 'Factory A — Bilin', kind: 'factory', city: 'Bilin',
    owners: ['yangontyrefactory.bilin@gmail.com'],
    produces: ['tyre production', 'stock balance', 'warranty claims (CTD)'],
    galaxy: 'Galaxy iStock — Plant A warehouse (raw + WIP + finished)' },
  { key: 'factory-b', name: 'Factory B — SPT', kind: 'factory', city: 'SPT',
    owners: ['yangontyrefactory.spt@gmail.com', 'ytpdoffice01@gmail.com'],
    produces: ['tyre production', 'raw stock detail', 'overtime', 'salary'],
    galaxy: 'Galaxy iStock — Plant B warehouse (raw + WIP + finished)' },
  { key: 'showroom', name: 'Showroom & Marketing', kind: 'sales', city: 'Yangon/Mandalay',
    owners: ['showroom.yangontyre@gmail.com'],
    produces: ['sales (nylon/radial/MC)', 'dealer movement', 'GBP reviews'],
    galaxy: 'Galaxy iStock — Showroom outlet stock + POS/sales' },
  { key: 'head-office', name: 'Head Office', kind: 'ho', city: 'Yangon (Bayintnaung)',
    owners: ['thida.mwa@gmail.com', 'htinkyawoo@yangontyre.com', 'swannyhtet@gmail.com', 'theswanhtet@gmail.com', 'evergreenmyanmar@gmail.com'],
    produces: ['P&L / finance', 'procurement (KIIC/Junky)', 'claim decisions', 'retailer master', 'logistics'],
    galaxy: 'Galaxy iStock — consolidation (all sites roll up here for group P&L + inventory valuation)' },
];

const ownerToSite = {};
SITES.forEach((s) => s.owners.forEach((o) => (ownerToSite[o.toLowerCase()] = s.key)));

// attach the live Drive sources (from drive-inventory.json) to each site by owner
let inv = null;
try { inv = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'drive-inventory.json'), 'utf8')); } catch {}
const sources = inv?.sources || [];
const unmapped = [];
const sites = SITES.map((s) => ({ ...s, sources: [] }));
const byKey = Object.fromEntries(sites.map((s) => [s.key, s]));
for (const src of sources) {
  const key = ownerToSite[String(src.owner || '').toLowerCase()];
  const entry = { role: src.role, title: src.title, status: src.status, as_of: src.as_of };
  if (key && byKey[key]) byKey[key].sources.push(entry);
  else unmapped.push({ ...entry, owner: src.owner });
}

const out = {
  generated_at: new Date().toISOString(),
  model: 'Factory A (Bilin) + Factory B (SPT) + Showroom + Head Office; Galaxy iStock per-site → HO consolidation',
  sites: sites.map((s) => ({ ...s, source_count: s.sources.length })),
  unmapped,
};
fs.writeFileSync(path.join(outDir, 'sites.json'), JSON.stringify(out, null, 2) + '\n');

console.log('sites — done');
sites.forEach((s) => console.log(`  ${s.name.padEnd(22)} ${s.sources.length} sources · ${s.produces.slice(0, 2).join(', ')}`));
if (unmapped.length) console.log('  unmapped owners:', [...new Set(unmapped.map((u) => u.owner))].join(', '));
console.log('  ->', path.join('out', 'sites.json'));
