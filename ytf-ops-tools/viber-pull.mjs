#!/usr/bin/env node
// viber-pull.mjs — ingest Viber group messages into the cockpit, scoped by group. See VIBER-INTEGRATION.md.
// Best path: read Viber Desktop's local SQLite DB (%APPDATA%\ViberPC\<phone>\viber.db) — full history,
// per group, automatable. Fallback: a computer-use bridge. This scaffold LOCATES the DB and lays out the
// pipeline; wiring the actual read (sql.js or computer-use) is the one remaining step.
//
// Output: data/manual-entries/viber-<group>.json  ->  manual-entries.mjs folds it in (tagged group)
//         ->  redactForRole() in api/control.js scopes it to each user's groups.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'data', 'manual-entries');
fs.mkdirSync(outDir, { recursive: true });

function findViberDb() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const base = path.join(appData, 'ViberPC');
  if (!fs.existsSync(base)) return null;
  for (const phone of fs.readdirSync(base)) {
    const db = path.join(base, phone, 'viber.db');
    if (fs.existsSync(db)) return db;
  }
  return null;
}

// TODO(impl): read messages grouped by conversation. Two interchangeable backends:
//   A) sql.js (pure WASM SQLite) — `SELECT ... FROM messages JOIN conversations ...` grouped by group title.
//   B) computer-use bridge — open Viber Desktop, scroll each watched group, capture text.
// Both return: [{ group, date, sender, text }]. Until wired, returns [] so refresh stays green.
async function readViberMessages(/* dbPath */) { return []; }

const main = async () => {
  const db = findViberDb();
  if (!db) {
    console.log('viber-pull: Viber Desktop DB not found (%APPDATA%/ViberPC/<phone>/viber.db). Install/sign-in Viber Desktop on this PC, or use the computer-use bridge. Skipping.');
    return;
  }
  const enc = (() => { try { return fs.readFileSync(db).subarray(0, 15).toString('latin1') !== 'SQLite format 3'; } catch { return true; } })();
  console.log('viber-pull: found', db, enc ? '(ENCRYPTED — SQLCipher; use the computer-use bridge, see VIBER-INTEGRATION.md)' : '(plain SQLite)');
  const msgs = await readViberMessages(db, enc);
  if (!msgs.length) {
    console.log('viber-pull: 0 messages — reader backend (computer-use capture or DPAPI decrypt) not wired yet. Pipeline stays green.');
    return;
  }
  // group → records, tagged with the canonical group key (for redactForRole scoping)
  const byGroup = {};
  for (const m of msgs) { const g = m.group || 'viber'; (byGroup[g] = byGroup[g] || []).push(m); }
  let total = 0;
  for (const [group, rows] of Object.entries(byGroup)) {
    const key = group.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const records = rows.map((m) => ({ kind: 'viber', group: key, date: (m.date || '').slice(0, 10), via: 'viber', summary: String(m.text || '').slice(0, 120), fields: { sender: m.sender, text: m.text }, source_text: m.text }));
    fs.writeFileSync(path.join(outDir, `viber-${key}.json`), JSON.stringify(records, null, 2) + '\n');
    total += records.length;
  }
  console.log(`viber-pull: ${total} messages across ${Object.keys(byGroup).length} groups -> data/manual-entries/viber-*.json`);
};
main().catch((e) => { console.error('viber-pull failed:', e.message); process.exit(1); });
