#!/usr/bin/env node
// crawl-drive.mjs — recursively walk the whole "Yangon Tyre" Drive tree (resolving shortcuts),
// catalogue EVERY file, tag each by the Plant folder it lives under, and download the recognised
// spreadsheets into data/drive-cache/scan/ for the plant-aware generators.
//
// This replaces the old "5 hardcoded fileIds" model: the pipeline now sees the entire Drive.
// Auth: GOOGLE_SA_KEY (raw JSON) or GOOGLE_SA_KEY_FILE (path). The "Yangon Tyre" folder is shared
// (read) with the service account, and that share cascades to every subfolder + shortcut target.
//
// Output:
//   data/drive-inventory.json   — full manifest (consumed by drive-sources.mjs + sites.mjs)
//   data/drive-cache/scan/*.xlsx — downloaded spreadsheets (plant-prefixed names)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken, listFolder, downloadDriveFile, exportDriveFile } from './lib/google-sa.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'data', 'drive-cache', 'scan');
const DATA = path.join(DIR, 'data');
fs.mkdirSync(CACHE, { recursive: true });

const ROOT = process.env.YTF_DRIVE_ROOT || '1lvNk73XNxIdPIagwal7YKEzlCtAkk-yv'; // "Yangon Tyre"
// Seed from the operational subtrees with plant pre-assigned. Crawling from these (instead of the
// noisy root) is faster and tags plant reliably even when shortcuts resolve to folders named "2026".
const SEEDS = [
  { id: '1t94diZCYNQsXzoIhSJCwxRhoMeduARoH', path: ['Plant A'], plant: 'plant-a' },
  { id: '1CalHBhFysubqSx7-AbRBqaFIUxCI07cO', path: ['Plant B'], plant: 'plant-b' },
  { id: '1dIOhd04trNsMYn4OPrrj1K3qQwRCDP5E', path: ['CEO data'], plant: 'company' },
];
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

// folders we don't care about for operations data (catalogued shallowly, not deep-crawled)
const SKIP_DEEP = /archived|industry literature|catalog|interview|recipe|^video|memory stip|^[a-z]:$|appdata|^onedrive|node_modules|^\.|program files|windows\b|roaming/i;
const MAX_DEPTH = 4;
const MAX_NODES = 1800;      // folders+shortcuts visited
const MAX_DOWNLOADS = 80;    // spreadsheets fetched per run
const PER_BUCKET = 4;        // freshest N per (plant, category) to download

// only catalogue operational file types — skip the thousands of Viber JPGs / videos / CAD
const DOC_MIMES = new Set([
  'application/pdf', 'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

// classify a file by its name → category the app understands
function categorize(name) {
  const n = name.toLowerCase();
  if (/daily.*(production|conclusion)|conclusion/.test(n)) return 'daily-production';
  if (/production|pcr|\bpe\b/.test(n)) return 'production';
  if (/claim|defective|defect|reject|waste|durabilit|qc\b/.test(n)) return 'quality';
  if (/stock|inventory|closing balance|grn|raw.*(material|stock)|consumption/.test(n)) return 'stock';
  if (/profit|loss|p&l|cash|costing|salary|payroll|finance/.test(n)) return 'finance';
  if (/order|sales|receivab|invoice|outstanding/.test(n)) return 'sales';
  if (/retailer|dealer|promotion address/.test(n)) return 'retailers';
  if (/curing|machine|maintenance|target/.test(n)) return 'operations';
  return 'other';
}
// plant is seeded at the root and INHERITED; a clear in-path marker can still set it.
function refinePlant(parts, inherited) {
  const joined = parts.join('/').toLowerCase();
  if (/plant a\b|\/bilin\b/.test(joined)) return 'plant-a';
  if (/plant b\b|\/spt\b/.test(joined)) return 'plant-b';
  return inherited || 'company';
}
const isSpreadsheet = (mime) => mime === XLSX_MIME || mime === SHEET_MIME;
const safeName = (s) => s.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);

const manifest = [];
const mediaCounts = {}; // plant -> {images, videos} (evidence indicators, not catalogued individually)
const seen = new Set();
let nodes = 0;

async function crawl(folderId, parts, plantCtx, token, depth) {
  if (depth > MAX_DEPTH || nodes > MAX_NODES) return;
  if (seen.has(folderId)) return; // avoid shortcut loops / duplicate mirrors
  seen.add(folderId);
  nodes++;
  let children;
  try { children = await listFolder(folderId, token); }
  catch (e) { console.error(`  ✗ list ${parts.join('/')}: ${e.message}`); return; }

  for (const c of children) {
    let { mimeType, id, name } = c;
    let resolved = false;
    if (mimeType === SHORTCUT_MIME && c.shortcutTargetId) {
      id = c.shortcutTargetId; mimeType = c.shortcutTargetMime || mimeType; resolved = true;
    }
    const childParts = [...parts, name];
    const plant = refinePlant(childParts, plantCtx);

    if (mimeType === FOLDER_MIME) {
      if (SKIP_DEEP.test(name)) continue;
      await crawl(id, childParts, plant, token, depth + 1);
      continue;
    }
    if (mimeType === SHORTCUT_MIME) continue; // dangling shortcut

    // tally media as evidence counts, don't catalogue each one
    if (/^image\//.test(mimeType) || /^video\//.test(mimeType)) {
      const k = plant; mediaCounts[k] = mediaCounts[k] || { images: 0, videos: 0 };
      if (mimeType.startsWith('image/')) mediaCounts[k].images++; else mediaCounts[k].videos++;
      continue;
    }

    const category = categorize(name);
    const sheet = isSpreadsheet(mimeType);
    // catalogue: all spreadsheets; docs/pdfs only when they're in a real ops category
    if (!sheet && !(DOC_MIMES.has(mimeType) && category !== 'other')) continue;
    if (/^~\$/.test(name)) continue; // Office lock files

    manifest.push({
      fileId: id, name, plant, category,
      path: childParts.join('/'),
      mimeType, modifiedTime: c.modifiedTime || '', owner: c.owner || '',
      spreadsheet: sheet, shortcut: resolved,
    });
  }
}

const main = async () => {
  const token = await getAccessToken();
  console.log(`crawl-drive — walking operational subtrees …`);
  // top-level company sheets (shallow — don't recurse the noisy root)
  try {
    for (const c of await listFolder(ROOT, token)) {
      if (isSpreadsheet(c.mimeType) && !/^~\$/.test(c.name)) {
        manifest.push({ fileId: c.id, name: c.name, plant: 'company', category: categorize(c.name),
          path: `Yangon Tyre/${c.name}`, mimeType: c.mimeType, modifiedTime: c.modifiedTime || '', owner: c.owner || '', spreadsheet: true, shortcut: false });
      }
    }
  } catch (e) { console.error('  ✗ root list:', e.message); }
  // operational subtrees, plant pre-assigned + inherited
  for (const s of SEEDS) {
    const before = manifest.length;
    await crawl(s.id, ['Yangon Tyre', ...s.path], s.plant, token, 1);
    console.log(`  ${s.path.join('/').padEnd(10)} → +${manifest.length - before} files`);
  }
  console.log(`  catalogued ${manifest.length} files (${nodes} folders visited)`);

  // download recognised spreadsheets — freshest N per (plant, category) bucket so each plant
  // gets coverage (a per-plant production file beats a fresher company sales file).
  const want = new Set(['production', 'daily-production', 'quality', 'stock', 'finance', 'sales', 'retailers']);
  const buckets = {};
  for (const m of manifest) {
    if (!m.spreadsheet || !want.has(m.category)) continue;
    const k = `${m.plant}/${m.category}`;
    (buckets[k] = buckets[k] || []).push(m);
  }
  const toGet = [];
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
    toGet.push(...buckets[k].slice(0, PER_BUCKET));
  }
  toGet.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
  toGet.splice(MAX_DOWNLOADS);

  let ok = 0;
  for (const m of toGet) {
    const fname = `${m.plant}__${m.category}__${safeName(m.name).replace(/\.(xlsx|xls)$/i, '')}.xlsx`;
    const dest = path.join(CACHE, fname);
    try {
      const bytes = m.mimeType === SHEET_MIME
        ? await exportDriveFile(m.fileId, XLSX_MIME, token)
        : await downloadDriveFile(m.fileId, token);
      if (bytes.slice(0, 2).toString('hex') !== '504b') throw new Error('not xlsx');
      fs.writeFileSync(dest, bytes);
      m.cache = path.join('scan', fname);
      ok++;
      console.log(`  ✓ ${m.plant.padEnd(8)} ${m.category.padEnd(16)} ${(bytes.length / 1024).toFixed(0).padStart(5)}KB  ${m.name.slice(0, 50)}`);
    } catch (e) {
      console.error(`  ✗ ${m.name.slice(0, 50)}: ${e.message}`);
    }
  }

  // summary by plant + category for quick sanity
  const by = {};
  for (const m of manifest) { const k = `${m.plant}/${m.category}`; by[k] = (by[k] || 0) + 1; }

  const inv = {
    generated_at: new Date().toISOString(),
    drive_root: ROOT,
    total: manifest.length,
    downloaded: ok,
    folders_visited: nodes,
    by_plant_category: by,
    media_counts: mediaCounts,
    files: manifest,
  };
  fs.writeFileSync(path.join(DATA, 'drive-inventory.json'), JSON.stringify(inv, null, 2));
  console.log(`crawl-drive — ${ok}/${toGet.length} spreadsheets downloaded; manifest → data/drive-inventory.json`);
  if (manifest.length === 0) process.exit(1);
};

main().catch((e) => { console.error('crawl-drive failed:', e.message); process.exit(1); });
