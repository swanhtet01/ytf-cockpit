#!/usr/bin/env node
// drive-sources.mjs — the CURRENT YTF data-source catalog, built from a LIVE Drive crawl.
//
// REPLACES the stale "data sources" Google Doc (1YYve...), which was outdated (old thida.mwa P&L
// links, missing the 2025 H1 P&L + 2026 production/stock files). The truth now lives in
// data/drive-inventory.json — re-crawl the Drive and update that file when sources change.
//
// Output: out/drive-sources.json  (consumed by ../supermega-remote/pipeline.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });

const invPath = path.join(DIR, 'data', 'drive-inventory.json');
if (!fs.existsSync(invPath)) {
  console.error(`drive-sources: no data/drive-inventory.json (the live crawl). Skipping.`);
  process.exit(0);
}
const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));

const linkFor = (s) => {
  if (s.kind === 'folder') return `https://drive.google.com/drive/folders/${s.fileId}`;
  if (s.kind === 'sheet') return `https://docs.google.com/spreadsheets/d/${s.fileId}`;
  if (s.kind === 'doc') return `https://docs.google.com/document/d/${s.fileId}`;
  return `https://drive.google.com/file/d/${s.fileId}`;
};
const ownerShort = (o) => String(o || '').split('@')[0];

const sources = (inv.sources || []).map((s) => ({
  key: s.key,
  name: s.title,
  kind: s.kind,
  category: s.role,
  id: s.fileId,
  owner: ownerShort(s.owner),
  modified: s.modified,
  as_of: s.as_of || '',     // the period the data actually covers (currency)
  status: s.status,         // live | available | stale | archived
  canonical: !!s.canonical,
  tool: s.tool,
  url: linkFor(s),
}));

const tally = (key) => sources.reduce((a, s) => ((a[s[key]] = (a[s[key]] || 0) + 1), a), {});

const out = {
  generated_at: new Date().toISOString(),
  basis: `live Drive crawl (${inv.crawled_at}) — supersedes stale doc 1YYve...`,
  drive_folder: inv.drive_folder,
  total: sources.length,
  canonical: sources.filter((s) => s.canonical).length,
  by_status: tally('status'),
  by_owner: tally('owner'),
  sources,
};
fs.writeFileSync(path.join(outDir, 'drive-sources.json'), JSON.stringify(out, null, 2) + '\n');

console.log('drive-sources — done (from live inventory)');
console.log('  sources :', out.total, JSON.stringify(out.by_status));
console.log('  canonical:', out.canonical, '· owners:', JSON.stringify(out.by_owner));
console.log('  ->', path.join('out', 'drive-sources.json'));
