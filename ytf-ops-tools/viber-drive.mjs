#!/usr/bin/env node
// viber-drive.mjs — REAL, autonomous Viber ingestion with zero owner setup.
// The factory's PC auto-syncs Viber media to Google Drive ("ViberDownloads", 16k+ images, live daily).
// The service account already reads it. This generator pulls the RECENT images, has Claude classify
// each (order form / production report / claim / delivery / stock / chat screenshot / other) and
// extract structured ops records — then writes out/viber-intel.json for the feed.
//
// Cost-bounded: only images newer than VIBER_SINCE_DAYS, capped at VIBER_MAX, cached by fileId so
// each image is processed once. Runs in CI/cron — fully cloud, no factory automation, no fake data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken, searchFiles, downloadDriveFile } from './lib/google-sa.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
const dataDir = path.join(DIR, 'data');
fs.mkdirSync(outDir, { recursive: true });

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.VIBER_VISION_MODEL || 'claude-sonnet-4-6';
const SINCE_DAYS = Number(process.env.VIBER_SINCE_DAYS || 14);
const MAX = Number(process.env.VIBER_MAX || 24);            // images processed per run (cost cap)
const CACHE_PATH = path.join(dataDir, 'drive-cache', 'viber-extract-cache.json');
// the live Viber media folder (service-account readable); add more folder IDs here as discovered
const VIBER_FOLDERS = (process.env.VIBER_FOLDERS || '1wXsux-swtGlsZ1l2gW6L1hM-wiJSRYmg').split(',');

// group/plant hints — maps the evidenced real groups onto the cockpit's plant/ledger keys
const GROUP_KEYS = { 'order': 'orders', 'nylon': 'orders', 'radial': 'orders', 'bilin': 'plant-a', 'plant a': 'plant-a', 'spt': 'plant-b', 'plant b': 'plant-b', 'container': 'raw-material', 'hm ': 'procurement' };

if (!KEY) { console.error('viber-drive: ANTHROPIC_API_KEY not set. Skipping.'); process.exit(0); }
let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch {}

const sinceIso = (() => { const d = new Date(Date.now() - SINCE_DAYS * 86400000); return d.toISOString(); })();

const PROMPT = `You are reading a Viber image shared in a Yangon Tyre Factory group. First CLASSIFY it, then extract only what you can read with confidence. Many images are NOT operational (marketing, personal, blurry) — for those return type "other" with empty records. Return ONLY JSON:
{"type":"order_form|production_report|claim|delivery|stock|payment|chat_screenshot|other","plant_hint":"bilin|spt|null","date":"YYYY-MM-DD or null","summary":"one English sentence","records":[{"kind":"order|production|claim|delivery|stock|payment|other","what":"English description","fields":{"dealer":null,"tyre_size":null,"qty":null,"amount_kyat":null,"ref":null}}],"confidence":0.0}
Rules: tyre sizes look like 175R13C / 2.50-17 / 145R12C. Read Burmese. Order forms have dealer + sizes + quantities. Production reports have daily made/cured counts by size. Only emit records for real operational content. If it's a photo of a tyre/defect with no numbers, type "claim" or "other" with a short summary and no invented numbers.`;

async function vision(b64, media) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: media, data: b64 } },
      { type: 'text', text: PROMPT },
    ] }] }),
  });
  if (!res.ok) return { error: `claude ${res.status}: ${(await res.text()).slice(0, 120)}` };
  const j = await res.json();
  const t = (j.content || []).map((c) => c.text || '').join('');
  const m = t.match(/\{[\s\S]*\}/); if (!m) return { error: 'no json' };
  try { return JSON.parse(m[0]); } catch (e) { return { error: 'parse: ' + e.message }; }
}
const mediaOf = (name) => /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';

const main = async () => {
  const token = await getAccessToken();
  // gather recent images across the Viber folders, newest first
  let imgs = [];
  for (const folder of VIBER_FOLDERS) {
    try {
      const q = `'${folder}' in parents and trashed=false and (mimeType='image/jpeg' or mimeType='image/png' or mimeType='image/webp') and modifiedTime > '${sinceIso}'`;
      imgs.push(...await searchFiles(q, token, { pageSize: 120, orderBy: 'modifiedTime desc' }));
    } catch (e) { console.error('  search', folder, e.message); }
  }
  // dedupe by fileId, drop already-cached, cap
  const seen = new Set();
  const fresh = imgs.filter((f) => { if (seen.has(f.id) || cache[f.id]) return false; seen.add(f.id); return true; })
    .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))
    .slice(0, MAX);

  console.log(`viber-drive — ${imgs.length} recent images (since ${sinceIso.slice(0, 10)}), ${fresh.length} new to process (cap ${MAX})`);

  const items = [];
  let ops = 0;
  for (const f of fresh) {
    try {
      const buf = await downloadDriveFile(f.id, token);
      if (buf.length > 5 * 1024 * 1024) { cache[f.id] = { skipped: 'too big' }; continue; }
      const ex = await vision(buf.toString('base64'), mediaOf(f.name));
      cache[f.id] = { at: new Date().toISOString(), type: ex.type, conf: ex.confidence };
      if (ex.error) { console.log('  ✗', f.name.slice(0, 20), ex.error); continue; }
      const plant = ex.plant_hint === 'bilin' ? 'plant-a' : ex.plant_hint === 'spt' ? 'plant-b' : 'company';
      const rec = { fileId: f.id, modified: (f.modifiedTime || '').slice(0, 10), date: ex.date || (f.modifiedTime || '').slice(0, 10), type: ex.type, plant, summary: ex.summary, confidence: ex.confidence, records: (ex.records || []) };
      if (ex.type !== 'other' && (ex.records || []).length) ops++;
      items.push(rec);
      console.log(`  ✓ ${(ex.type || '?').padEnd(17)} ${(ex.records?.length || 0)} rec  ${(ex.summary || '').slice(0, 56)}`);
    } catch (e) { cache[f.id] = { error: e.message }; console.log('  ✗', f.name.slice(0, 20), e.message); }
  }

  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  // aggregate by type for the cockpit (orders/production/claims are the high-value ledgers)
  const byType = {};
  for (const it of items) { if (it.type === 'other' || !it.records.length) continue; (byType[it.type] = byType[it.type] || []).push(it); }
  const out = {
    generated_at: new Date().toISOString(),
    source: 'Viber media synced to Google Drive (autonomous)',
    window_days: SINCE_DAYS,
    recent_images: imgs.length,
    processed: fresh.length,
    operational: ops,
    by_type: byType,
    items: items.filter((it) => it.type !== 'other' && it.records.length).slice(0, 60),
  };
  fs.writeFileSync(path.join(outDir, 'viber-intel.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`viber-drive — ${ops}/${fresh.length} operational; types: ${Object.keys(byType).map((k) => k + ':' + byType[k].length).join(' ') || 'none'} → out/viber-intel.json`);
};

main().catch((e) => { console.error('viber-drive failed:', e.message); process.exit(0); });
