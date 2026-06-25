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
  { id: '1Fewjoh89sofTi0JDHYIvznaWOFc0rZMY', path: ['Showroom PC'], plant: 'company' }, // sales/showroom mirror
];
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

// folders we don't care about for operations data (catalogued shallowly, not deep-crawled)
const SKIP_DEEP = /archived|industry literature|catalog|interview|recipe|^video|memory stip|^[a-z]:$|appdata|^onedrive|node_modules|^\.|program files|windows\b|roaming/i;
const MAX_DEPTH = 6;         // reach deep subfolders (claims, sales, finance, daily)
const MAX_NODES = 4000;      // folders+shortcuts visited
const MAX_DOWNLOADS = 160;   // spreadsheets fetched per run
const PER_BUCKET = 6;        // best N per (plant, category) to download

// only catalogue operational file types — skip the thousands of Viber JPGs / videos / CAD
const DOC_MIMES = new Set([
  'application/pdf', 'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

// classify a file by its name → category the app understands.
// Order matters: more-specific rules first so e.g. "consumption" isn't swallowed by "production".
function categorize(name) {
  const n = name.toLowerCase();
  if (/consumption/.test(n)) return 'stock';                          // consumption = material use, not production
  if (/\bpe\b|oee|performance eval/.test(n)) return 'operations';     // 2026 PE = perf-eval, not production
  // daily PRODUCTION reports / shift conclusions — must be production-flavoured (anchor on production
  // words) so "Daily Sales/Finance/Stock Report" don't get swallowed here
  if (/daily.*(production|conclusion|tyre|output|cure|curing)|(production|tyre|shift).*conclusion|shift.*(production|output)|\bday.?book\b/.test(n)) return 'daily-production';
  // Plant A (Yangon) reports as ABR / Bias / Nylon — catch these as production
  if (/bias.*production|yearly bias|\babr\b|nylon.*production|tyre production|production.*(wt|with wt)|monthly tyre|pcr.*production/.test(n)) return 'production';
  // quality / claims / defects / waste / scrap — claim books are first-class quality records
  if (/claim|defective|defect|reject|\bscrap\b|\bwaste\b|wastage|durabilit|\bqc\b|quality|complain|returned goods|warrant/.test(n)) return 'quality';
  if (/stock|inventory|closing balance|\bgrn\b|raw.*(material|stock)|\bbom\b|store.*ledger|godown/.test(n)) return 'stock';
  // finance: cash books, profit/loss, costing, payroll, expenses, bank, ledgers (anchor 'account'/'loss')
  if (/profit|\bp&l\b|profit.*loss|cash.?book|\bcash\b|costing|salary|payroll|finance|expense|\bbank\b|voucher|\bledger\b|\baccount\b|petty/.test(n)) return 'finance';
  // sales: sale invoices, orders, receivables, dispatch, delivery (anchor 'order' so "work/production order" stays out)
  if (/sale.?invoice|\binvoice\b|sales?.?order|dealer.?order|\bsales?\b|receivab|outstanding|dispatch|\bdelivery\b|showroom|\bcustomer\b/.test(n)) return 'sales';
  if (/retailer|dealer|distributor|promotion address|\bagent\b/.test(n)) return 'retailers';
  if (/curing|machine|maintenance|\btarget\b|breakdown|downtime|utili[sz]ation/.test(n)) return 'operations';
  if (/\bproduction\b|\boutput\b/.test(n)) return 'production';
  return 'other';
}
// Plant identity (owner ground-truth): Plant A = YANGON (bias/nylon/agricultural),
// Plant B = BILIN (radial/MC). Folder location != data origin (SPT PC syncs Bilin's
// radial reports into the "Plant A" Drive folder), so OWNER + content decide, not path.
function refinePlant(parts, inherited, owner = '') {
  const o = String(owner).toLowerCase();
  if (o.includes('yangontyrefactory.bilin')) return 'plant-b';                       // Bilin = Plant B
  if (o.includes('yangontyrefactory.spt') || o.includes('ytqc2019') || o.includes('ytpdoffice01')) return 'plant-a'; // Yangon = Plant A
  const joined = parts.join('/').toLowerCase();
  if (/\bplant[ -]?b\b|\/bilin\b/.test(joined)) return 'plant-b';
  if (/\bplant[ -]?a\b/.test(joined)) return 'plant-a';
  return inherited || 'company';
}
const isSpreadsheet = (mime) => mime === XLSX_MIME || mime === SHEET_MIME;
const safeName = (s) => s.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);

// Prefer full-period source files (yearly/monthly/annual rollups) over weekly/daily partials —
// downstream generators get a richer base when they parse a full-period workbook. Higher = better.
function periodScore(name) {
  const n = name.toLowerCase();
  if (/\byear(ly)?\b|\bannual\b|\bfy\s?\d|full.?period|whole.?year|\b12.?months?\b|jan\w*\s*[-–to]+\s*dec/.test(n)) return 3;
  if (/\bmonth(ly)?\b|\bmtd\b/.test(n)) return 2;
  if (/\bweek(ly)?\b|\bdaily\b|\bday\b/.test(n)) return 0; // partials — deprioritise vs a full-period file
  return 1;
}

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
    const plant = refinePlant(childParts, plantCtx, c.owner || '');

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
  // Cloud-safe: if no service-account key is configured, this is a no-op (exit 0), not a failure —
  // the crawl simply can't run without Drive auth (e.g. a preview deploy with no secret set).
  if (!process.env.GOOGLE_SA_KEY && !process.env.GOOGLE_SA_KEY_FILE) {
    console.log('crawl-drive — no GOOGLE_SA_KEY / GOOGLE_SA_KEY_FILE set; skipping crawl (exit 0).');
    return;
  }
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
    // within a bucket: prefer full-period files, then freshest — so a yearly rollup beats a daily partial
    buckets[k].sort((a, b) =>
      (periodScore(b.name) - periodScore(a.name)) ||
      (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
    toGet.push(...buckets[k].slice(0, PER_BUCKET));
  }
  // global cap: keep the FRESHEST across all buckets (period preference already applied per-bucket
  // above, so full-period files are at each bucket's top). Sorting period-primary here would let
  // stale yearly files (1006 candidates >> 160 cap) displace fresh monthly/daily files at the cut.
  toGet.sort((a, b) =>
    (b.modifiedTime || '').localeCompare(a.modifiedTime || '') ||
    (periodScore(b.name) - periodScore(a.name)));
  toGet.splice(MAX_DOWNLOADS);

  let ok = 0;
  for (const m of toGet) {
    try {
      const bytes = m.mimeType === SHEET_MIME
        ? await exportDriveFile(m.fileId, XLSX_MIME, token)
        : await downloadDriveFile(m.fileId, token);
      const magic = bytes.slice(0, 4).toString('hex');
      const isZip = magic.startsWith('504b');      // .xlsx (zip)
      const isOle = magic === 'd0cf11e0';          // legacy .xls (OLE2) — SheetJS reads it
      if (!isZip && !isOle) throw new Error('not a spreadsheet (' + magic + ')');
      const ext = isOle ? 'xls' : 'xlsx';
      const fname = `${m.plant}__${m.category}__${safeName(m.name).replace(/\.(xlsx|xls)$/i, '')}.${ext}`;
      const dest = path.join(CACHE, fname);
      fs.writeFileSync(dest, bytes);
      m.cache = path.join('scan', fname);
      ok++;
      console.log(`  ✓ ${m.plant.padEnd(8)} ${m.category.padEnd(16)} ${(bytes.length / 1024).toFixed(0).padStart(5)}KB  ${m.name.slice(0, 50)}`);
    } catch (e) {
      console.error(`  ✗ ${m.name.slice(0, 50)}: ${e.message}`);
    }
  }

  // flat "plant/category" -> count (kept for backward compatibility with existing consumers)
  const by = {};
  for (const m of manifest) { const k = `${m.plant}/${m.category}`; by[k] = (by[k] || 0) + 1; }

  // richer nested summary: plant -> { total, spreadsheets, downloaded, categories:{cat:count} }
  // so downstream generators can read coverage per plant without re-scanning the full manifest.
  const summary = {};
  for (const m of manifest) {
    const s = summary[m.plant] = summary[m.plant] || { total: 0, spreadsheets: 0, downloaded: 0, categories: {} };
    s.total++;
    if (m.spreadsheet) s.spreadsheets++;
    if (m.cache) s.downloaded++;
    s.categories[m.category] = (s.categories[m.category] || 0) + 1;
  }

  // per (plant, category) freshest-file list — the single BEST source per category, so a generator
  // can pick the right workbook without guessing. "best" = full-period first, then freshest, then
  // prefer ones we actually downloaded (have a local cache). Top 3 per bucket.
  const freshest_by_plant_category = {};
  const fbpc = {};
  for (const m of manifest) {
    if (!want.has(m.category)) continue; // operational categories only — skip 'other'/'operations' noise
    const k = `${m.plant}/${m.category}`;
    (fbpc[k] = fbpc[k] || []).push(m);
  }
  for (const k of Object.keys(fbpc)) {
    freshest_by_plant_category[k] = fbpc[k]
      .sort((a, b) =>
        (Number(!!b.cache) - Number(!!a.cache)) ||
        (periodScore(b.name) - periodScore(a.name)) ||
        (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))
      .slice(0, 3)
      .map((m) => ({
        fileId: m.fileId, name: m.name, category: m.category, plant: m.plant,
        modifiedTime: m.modifiedTime || '', spreadsheet: m.spreadsheet,
        cache: m.cache || null, period_score: periodScore(m.name),
      }));
  }

  const inv = {
    generated_at: new Date().toISOString(),
    drive_root: ROOT,
    total: manifest.length,
    downloaded: ok,
    folders_visited: nodes,
    by_plant_category: by,
    summary,
    freshest_by_plant_category,
    media_counts: mediaCounts,
    files: manifest,
  };
  fs.writeFileSync(path.join(DATA, 'drive-inventory.json'), JSON.stringify(inv, null, 2));
  for (const [p, s] of Object.entries(summary)) {
    const cats = Object.entries(s.categories).filter(([c]) => c !== 'other').map(([c, v]) => `${c}:${v}`).join(' ');
    console.log(`  ${p.padEnd(9)} ${String(s.total).padStart(4)} files · ${s.spreadsheets} sheets · ${s.downloaded} cached · ${cats}`);
  }
  console.log(`crawl-drive — ${ok}/${toGet.length} spreadsheets downloaded; manifest → data/drive-inventory.json`);
  if (manifest.length === 0) process.exit(1);
};

main().catch((e) => { console.error('crawl-drive failed:', e.message); process.exit(1); });
