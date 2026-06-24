#!/usr/bin/env node
// build-threads.mjs — normalize raw Gmail search-thread pages into threads.live.json
//
// Reads every JSON page file in data/raw/ (each is a raw `search_threads` response:
// { threads: [ { id, messages: [ { date, sender, subject, snippet, ... } ] } ] }),
// takes the ORIGINATING message (messages[0]) of each thread, dedups by thread id,
// sorts newest-first, and writes the flat {id,date,sender,subject,snippet} array
// that extract.mjs consumes.
//
// Usage: node build-threads.mjs            (raw dir = data/raw, out = data/threads.live.json)
//        node build-threads.mjs <rawDir> <outFile>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const rawDir = process.argv[2] || path.join(DIR, 'data', 'raw');
const outFile = process.argv[3] || path.join(DIR, 'data', 'threads.live.json');

if (!fs.existsSync(rawDir)) {
  console.error(`raw dir not found: ${rawDir}`);
  process.exit(1);
}

const files = fs.readdirSync(rawDir).filter((f) => f.toLowerCase().endsWith('.json') || f.toLowerCase().endsWith('.txt'));
if (!files.length) {
  console.error(`no page files in ${rawDir}`);
  process.exit(1);
}

const byId = new Map();
let pages = 0;
let rawThreads = 0;

for (const f of files) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
  } catch (e) {
    console.warn(`skip ${f}: ${e.message}`);
    continue;
  }
  const threads = Array.isArray(doc) ? doc : doc.threads;
  if (!Array.isArray(threads)) {
    console.warn(`skip ${f}: no threads array`);
    continue;
  }
  pages++;
  for (const t of threads) {
    rawThreads++;
    const id = t.id || (t.messages && t.messages[0] && t.messages[0].id);
    if (!id || byId.has(id)) continue;
    const m = (t.messages && t.messages[0]) || {};
    const row = {
      id,
      date: m.date || '',
      sender: m.sender || '',
      subject: m.subject || '',
    };
    if (m.snippet) row.snippet = String(m.snippet).replace(/\s+/g, ' ').trim().slice(0, 280);
    byId.set(id, row);
  }
}

const rows = [...byId.values()]
  .filter((r) => r.date)
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

fs.writeFileSync(outFile, JSON.stringify(rows, null, 2) + '\n');

console.log('build-threads — done');
console.log('  page files  :', pages);
console.log('  raw threads :', rawThreads);
console.log('  unique      :', rows.length);
console.log('  window      :', rows[rows.length - 1]?.date?.slice(0, 10), '->', rows[0]?.date?.slice(0, 10));
console.log('  ->', outFile);
