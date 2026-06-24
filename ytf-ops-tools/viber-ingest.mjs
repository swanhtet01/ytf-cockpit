#!/usr/bin/env node
// viber-ingest.mjs — turn pasted Viber chat text (per group) into structured records the cockpit reads.
//
// The realistic path (per VIBER-INTEGRATION.md): the Viber Desktop DB is SQLCipher-encrypted and the
// official API can't read group history. So we let the user PASTE chat text per group — long-press a
// message → Copy → drop the text into `data/captures/viber/<group-key>.txt` (or use entry.html's
// upcoming Viber paste box). This script extracts the records via the same Claude pass we use for
// whiteboard photos.
//
// Group keys MUST match the `groups` arrays in PANEL_USERS (see api/control.js redactForRole) — a
// `viber-groups.json` maps display name -> canonical key so renames don't break scoping.
//
// Output: data/manual-entries/viber-<group>.json  ->  manual-entries.mjs folds it -> redactForRole scopes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const capDir = path.join(DIR, 'data', 'captures', 'viber');
const outDir = path.join(DIR, 'data', 'manual-entries');
const mapFile = path.join(DIR, 'viber-groups.json');
fs.mkdirSync(capDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.OCR_MODEL || 'claude-haiku-4-5-20251001';

// Load group display→key mapping if present (e.g. {"Plant A daily":"plant-a","YTF Dealers":"dealers-yangon"})
let GROUP_MAP = {};
try { GROUP_MAP = JSON.parse(fs.readFileSync(mapFile, 'utf8')); } catch { /* ok */ }
const keyOf = (name) => GROUP_MAP[name] || String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const PROMPT = `You're reading Viber chat text from Yangon Tyre business groups (dealer orders, payments, claims, deliveries, plant chatter). Extract every distinct operational item. Return JSON ONLY:
{"records":[{"kind":"order|payment|claim|delivery|stock|complaint|other","date":"YYYY-MM-DD or null","fields":{...you read from the text...},"confidence":0..1,"sender":"...","source_text":"the original line(s)"}]}
Conventions: tyre sizes look like 175 R 13 C / 2.50-17 / 145 R 12 C (6-PR); claim ids #YGN-R<no>-<yy>; payment usually has Kyat amount + transfer/bank ref; orders have dealer + size + qty. Keep numbers numeric. If unreadable, omit. If no operational items, return {"records":[]}. Burmese/Myanmar script is fine; preserve it verbatim in source_text and translate the key field (size/qty/amount) only.`;

async function extract(text) {
  if (!KEY) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT + '\n\n---\n' + text.slice(0, 30000) }] }] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const t = (j.content || []).map((c) => c.text || '').join('');
  const m = t.match(/\{[\s\S]*\}/); if (!m) throw new Error('no JSON in model reply');
  return JSON.parse(m[0]).records || [];
}

const main = async () => {
  if (!KEY) { console.error('viber-ingest: set ANTHROPIC_API_KEY (same key as whiteboard-ocr). Skipping.'); process.exit(0); }
  const files = fs.existsSync(capDir) ? fs.readdirSync(capDir).filter((f) => /\.(txt|md)$/i.test(f)) : [];
  if (!files.length) { console.log(`viber-ingest: drop chat text into ${path.relative(DIR, capDir)}/<group>.txt — empty now. Skipping.`); process.exit(0); }
  let totalRows = 0;
  for (const f of files) {
    const groupName = path.parse(f).name;                              // filename (without ext) IS the group display
    const group = keyOf(groupName);
    const text = fs.readFileSync(path.join(capDir, f), 'utf8');
    try {
      const records = (await extract(text)) || [];
      const tagged = records.map((r) => ({ kind: r.kind || 'viber', group, date: r.date || null, via: 'viber', confidence: r.confidence ?? null, summary: String(r.source_text || JSON.stringify(r.fields || {})).slice(0, 120), fields: { ...(r.fields || {}), sender: r.sender || null, group_name: groupName }, source_text: r.source_text }));
      fs.writeFileSync(path.join(outDir, `viber-${group}.json`), JSON.stringify({ group, group_name: groupName, generated_at: new Date().toISOString(), records: tagged }, null, 2) + '\n');
      totalRows += tagged.length;
      console.log(`  ✓ ${groupName.padEnd(24)} ${tagged.length} record(s) -> manual-entries/viber-${group}.json`);
    } catch (e) { console.error(`  ✗ ${groupName} — ${e.message}`); }
  }
  console.log(`viber-ingest: ${totalRows} records across ${files.length} groups (refresh.mjs will fold them in).`);
};
main().catch((e) => { console.error('viber-ingest failed:', e.message); process.exit(1); });
