#!/usr/bin/env node
// refresh.mjs — one command to rebuild the panel's structured-data layer.
//
//   Stages run in parallel where possible:
//   1) Gmail extract (extract.mjs)                           ─┐
//   2) Drive pull (drive-sources, sites, retailers, inventory,  ├─ parallel group A
//      stock-balance, production, production-mc, daily-production,│
//      finance, galaxy-orders)                                 ─┘
//   3) LLM captures (whiteboard-ocr, viber-pull, viber-ingest) — sequential, after group A
//   4) manual-entries                                          — after captures
//   5) insights, trends, quality                              ─ parallel group B
//   6) pipeline.mjs                                           — assembles final JSON
//
// Run: node refresh.mjs  [--no-llm]  (--no-llm skips whiteboard OCR + viber-ingest)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// Support two layouts: repo root (GitHub Actions) and local dev (sibling directory)
const opsDir = fs.existsSync(path.join(DIR, 'ytf-ops-tools'))
  ? path.join(DIR, 'ytf-ops-tools')
  : path.join(DIR, '..', 'ytf-ops-tools');
const live = path.join(opsDir, 'data', 'threads.live.json');
const sample = path.join(opsDir, 'data', 'threads.sample.json');
const threads = fs.existsSync(live) ? live : sample;
const noLlm = process.argv.includes('--no-llm');

console.log(`refresh — ${new Date().toISOString()}`);
console.log(`  threads : ${path.relative(DIR, threads)}${threads === sample ? '  (sample)' : '  (live)'}`);
if (noLlm) console.log('  --no-llm: whiteboard OCR + viber-ingest skipped');

const t0 = Date.now();
const timings = [];

// run a script and return a promise; resolves even on non-zero exit (soft error)
function run(script, args = [], cwd = opsDir, label = null) {
  if (!fs.existsSync(script)) return Promise.resolve();
  const name = label || path.basename(script);
  const t = Date.now();
  return new Promise((resolve) => {
    const child = spawn('node', [script, ...args], { cwd, stdio: 'inherit' });
    child.on('close', (code) => {
      const elapsed = ((Date.now() - t) / 1000).toFixed(1);
      timings.push({ name, elapsed, ok: code === 0 });
      if (code !== 0) console.warn(`  ⚠  ${name} exited ${code} (continuing)`);
      resolve();
    });
  });
}

// run multiple scripts in parallel, wait for all
async function parallel(tasks) {
  await Promise.all(tasks.map(([script, args, cwd, label]) => run(script, args ?? [], cwd ?? opsDir, label)));
}

const o = (f) => path.join(opsDir, f);

// ── Stage 1: Gmail extract + all Drive/data generators — parallel ─────────────
console.log('\n[1/4] Parallel extract stage…');
await parallel([
  [o('extract.mjs'),          [threads],                                    opsDir,  'extract'],
  [o('drive-sources.mjs'),    [],                                            opsDir,  'drive-sources'],
  [o('sites.mjs'),            [],                                            opsDir,  'sites'],
  [o('retailers.mjs'),        [fs.existsSync(o('data/retailers.live.json'))
                                 ? o('data/retailers.live.json')
                                 : o('data/retailers.sample.json')],          opsDir, 'retailers'],
  [o('inventory.mjs'),        [],                                            opsDir,  'inventory'],
  [o('stock-balance.mjs'),    [],                                            opsDir,  'stock-balance'],
  [o('production.mjs'),       [],                                            opsDir,  'production'],
  [o('production-mc.mjs'),    [],                                            opsDir,  'production-mc'],
  [o('daily-production.mjs'), [],                                            opsDir,  'daily-production'],
  [o('finance.mjs'),          [],                                            opsDir,  'finance'],
  [o('galaxy-orders.mjs'),    [],                                            opsDir,  'galaxy-orders'],
]);

// ── Stage 2: LLM capture steps — sequential (OCR writes files viber-ingest reads) ──
if (!noLlm) {
  console.log('\n[2/4] LLM captures (sequential)…');
  await run(o('whiteboard-ocr.mjs'));
  await run(o('viber-pull.mjs'));
  await run(o('viber-ingest.mjs'));
}

// ── Stage 3: Normalize all captures ─────────────────────────────────────────────
console.log('\n[3/4] Normalise + cross-module analysis (parallel)…');
await run(o('manual-entries.mjs'));
await parallel([
  [o('insights.mjs'), [], opsDir, 'insights'],
  [o('trends.mjs'),   [], opsDir, 'trends'],
  [o('quality.mjs'),  [], opsDir, 'quality'],
]);
// COPQ reads quality.json; brief-agent reads insights — both must run after Stage 3
await run(o('copq.mjs'),      [], opsDir, 'copq');
await run(o('brief-agent.mjs'), [], opsDir, 'brief-agent');

// ── Stage 4: Assemble final dashboard JSON ───────────────────────────────────────
console.log('\n[4/4] Assembling dashboard…');
await run(path.join(DIR, 'pipeline.mjs'), [path.join(opsDir, 'out')], DIR, 'pipeline');

// ── Summary ──────────────────────────────────────────────────────────────────────
const total = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n✓ refresh done in ${total}s`);
const failed = timings.filter((t) => !t.ok);
if (failed.length) {
  console.warn(`  ⚠  ${failed.length} stage(s) had errors: ${failed.map((t) => t.name).join(', ')}`);
}
const slow = timings.filter((t) => parseFloat(t.elapsed) > 5).sort((a, b) => b.elapsed - a.elapsed);
if (slow.length) {
  console.log('  Slowest stages:');
  for (const t of slow.slice(0, 5)) console.log(`    ${t.elapsed}s  ${t.name}`);
}
console.log('  public/ytf-dashboard.json + public/ytf-ops.json updated.');
