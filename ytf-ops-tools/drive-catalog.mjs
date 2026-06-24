#!/usr/bin/env node
// drive-catalog.mjs — turn the full crawl manifest (data/drive-inventory.json) into a COMPACT,
// plant-grouped catalog the app can show. Proves the platform sees the whole Drive, organised by
// Plant A / Plant B / Company and by data category — without shipping the 8k-row raw manifest.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });

const invPath = path.join(DIR, 'data', 'drive-inventory.json');
if (!fs.existsSync(invPath)) {
  console.error('drive-catalog: no data/drive-inventory.json (run crawl-drive.mjs first). Skipping.');
  process.exit(0);
}
const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));
const files = inv.files || [];

const PLANTS = ['plant-a', 'plant-b', 'company'];
const CAT_LABEL = {
  production: 'Production', 'daily-production': 'Daily production', quality: 'Quality / claims',
  stock: 'Stock & materials', finance: 'Finance', sales: 'Sales & orders',
  retailers: 'Dealers', operations: 'Operations', other: 'Other',
};

function plantBlock(plant) {
  const fs_ = files.filter((f) => f.plant === plant);
  const byCat = {};
  for (const f of fs_) byCat[f.category] = (byCat[f.category] || 0) + 1;
  const freshest = [...fs_]
    .filter((f) => f.category !== 'other')
    .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))
    .slice(0, 8)
    .map((f) => ({ name: f.name, category: f.category, cat_label: CAT_LABEL[f.category] || f.category, modified: (f.modifiedTime || '').slice(0, 10), parsed: !!f.cache }));
  return {
    total: fs_.length,
    spreadsheets: fs_.filter((f) => f.spreadsheet).length,
    by_category: byCat,
    freshest,
  };
}

const catalog = {
  generated_at: new Date().toISOString(),
  crawled_at: inv.generated_at || null,
  drive_root: inv.drive_root || null,
  total_files: inv.total || files.length,
  downloaded: inv.downloaded || files.filter((f) => f.cache).length,
  folders_visited: inv.folders_visited || null,
  media_counts: inv.media_counts || {},
  by_plant: Object.fromEntries(PLANTS.map((p) => [p, plantBlock(p)])),
  // a single "what's freshest across the whole factory" feed for the data-sources card
  recent: [...files]
    .filter((f) => f.category !== 'other')
    .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))
    .slice(0, 30)
    .map((f) => ({ name: f.name, plant: f.plant, category: f.category, cat_label: CAT_LABEL[f.category] || f.category, modified: (f.modifiedTime || '').slice(0, 10) })),
};

fs.writeFileSync(path.join(outDir, 'drive-catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log('drive-catalog — done');
for (const p of PLANTS) {
  const b = catalog.by_plant[p];
  console.log(`  ${p.padEnd(9)} ${String(b.total).padStart(4)} files · ${b.spreadsheets} sheets · ${Object.entries(b.by_category).filter(([k])=>k!=='other').map(([k,v])=>k+':'+v).join(' ')}`);
}
console.log('  ->', path.join('out', 'drive-catalog.json'));
