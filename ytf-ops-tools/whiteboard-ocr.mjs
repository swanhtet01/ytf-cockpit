#!/usr/bin/env node
// whiteboard-ocr.mjs — turn PHOTOS of physical whiteboards / handwritten reports into structured
// operational records, with an LLM vision pass. This is a SEPARATE ingestion step (it uses an API
// key) — the cockpit itself stays no-AI/no-key. Flow:
//   data/captures/*.{jpg,png}  --(Claude vision)-->  data/manual-entries/ocr-<img>.json
//   then refresh.mjs folds manual-entries into the ledgers -> cockpit shows them -> insights -> actions.
//
// Auth: set ANTHROPIC_API_KEY (or OPENAI_API_KEY — Anthropic path implemented here). Model via OCR_MODEL
// (default claude-haiku-4-5-20251001 — cheap + good at this). Idempotent: skips images already extracted.
//
// Usage: ANTHROPIC_API_KEY=... node whiteboard-ocr.mjs   [capturesDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const capDir = process.argv[2] || path.join(DIR, 'data', 'captures');
const outDir = path.join(DIR, 'data', 'manual-entries');
fs.mkdirSync(capDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.OCR_MODEL || 'claude-haiku-4-5-20251001';
if (!KEY) { console.error('whiteboard-ocr: set ANTHROPIC_API_KEY (this is the only AI step; the cockpit stays no-AI). Skipping.'); process.exit(0); }

const MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const images = fs.existsSync(capDir) ? fs.readdirSync(capDir).filter((f) => MEDIA[path.extname(f).toLowerCase()]) : [];
if (!images.length) { console.log(`whiteboard-ocr: no images in ${path.relative(DIR, capDir)}/ — nothing to do.`); process.exit(0); }

const PROMPT = `You are reading a photo of a factory whiteboard or a handwritten/printed operational report from a tyre factory (Yangon Tyre). Extract every distinct operational record you can read.
Return ONLY a JSON object: {"records":[ {"kind": one of "claim|production|sale|5w1h|downtime|incident|stock|other", "date":"YYYY-MM-DD or null", "fields": { ...key:value pairs you read... }, "confidence": 0..1, "source_text": "the raw text you based this on" } ]}.
Conventions: warranty claim ids look like #YGN-R<no>-<yy> or #YGN-MC-...; tyre sizes like 175 R 13 C or 2.50-17; materials like Carbon Black N330, Nylon Cord, Natural Rubber; downtime in minutes with a machine + reason; 5W1H = what/why/where/who/when/how + countermeasure. Keep numbers as numbers. If a cell is unreadable, omit it (do not guess). If the image has no operational data, return {"records":[]}.`;

async function extract(file) {
  const buf = fs.readFileSync(path.join(capDir, file));
  const media = MEDIA[path.extname(file).toLowerCase()];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 2000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } },
        { type: 'text', text: PROMPT },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = (json.content || []).map((c) => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model reply');
  return JSON.parse(m[0]).records || [];
}

const main = async () => {
  let ok = 0, total = 0;
  for (const file of images) {
    const outFile = path.join(outDir, `ocr-${file.replace(/\.[^.]+$/, '')}.json`);
    if (fs.existsSync(outFile)) { console.log(`  · ${file} — already extracted, skip`); continue; }
    try {
      const records = await extract(file);
      const stamped = records.map((r) => ({ ...r, kind: r.kind || 'other', captured_via: 'whiteboard-ocr', image: file }));
      fs.writeFileSync(outFile, JSON.stringify({ image: file, model: MODEL, records: stamped }, null, 2) + '\n');
      ok++; total += stamped.length;
      console.log(`  ✓ ${file} — ${stamped.length} record(s) -> ${path.basename(outFile)}`);
    } catch (e) { console.error(`  ✗ ${file} — ${e.message}`); }
  }
  console.log(`whiteboard-ocr — ${ok}/${images.length} images, ${total} records into data/manual-entries/. Run refresh.mjs to fold them in.`);
};
main().catch((e) => { console.error('whiteboard-ocr failed:', e.message); process.exit(1); });
