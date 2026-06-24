#!/usr/bin/env node
// daily-production.mjs — current-month-to-date tyre output from the "Tyre Production Daily Report".
//
// The monthly workbook only closes at month-end (so production.mjs is current-to-last-close, May).
// This reads the DAILY report's per-day sheets to give June MTD: produced vs target, grade mix,
// and a per-day series — the freshest production signal (through the latest day reported).
//
// Input : "Tyre Production Daily Report 2026.xlsx" (argv[2] or auto-find in drive-cache)
//         optional argv[3] = month number (default: the latest month with daily sheets)
// Output: out/daily-production.json
//
// Usage : node daily-production.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './lib/xlsx-lite.mjs';
import { parseNum } from './lib/num.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });

function findInput() {
  if (process.argv[2]) return process.argv[2];
  for (const r of [path.join(DIR, 'data', 'drive-cache'), path.join(DIR, 'data')]) {
    if (!fs.existsSync(r)) continue;
    const hit = fs.readdirSync(r).filter((f) => /daily.*production|production.*daily/i.test(f) && /\.xlsx$/i.test(f)).sort().reverse()[0];
    if (hit) return path.join(r, hit);
  }
  return path.join(DIR, 'data', 'daily-production.xlsx');
}
const inPath = findInput();
if (!fs.existsSync(inPath)) { console.error('daily-production: no Daily Report workbook found. Skipping.'); process.exit(0); }

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();
const n = (v) => parseNum(v, 0);

let sheets = [];
try { ({ sheets } = readXlsx(inPath)); } catch (e) { console.error(`daily-production: cannot read (${e.message})`); process.exit(0); }

// day sheets are named "<d>.<m>.<yy>" (e.g. 13.6.26); skip weekly rollups ("1.6.26-6.6.26")
const dayRe = /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/;
const dayer = sheets.map((s) => ({ s, m: dayRe.exec(s.name.trim()) })).filter((x) => x.m);
if (!dayer.length) { console.error('daily-production: no per-day sheets found.'); process.exit(0); }

// pick the target month = the latest month present (or argv[3])
const wantMonth = process.argv[3] ? Number(process.argv[3]) : Math.max(...dayer.map((x) => Number(x.m[2])));
const wantYear = 2000 + Math.max(...dayer.filter((x) => Number(x.m[2]) === wantMonth).map((x) => Number(x.m[3])));

// map header columns on a day sheet: Sr.No | Tyre Size | Target | Curing(=A) | B | R | Total
function mapCols(rows) {
  // header spans two rows: "Curing" (=grade A) on the size row; B/R/Total are the next 3 columns
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const row = rows[i].map(lc);
    const size = row.findIndex((h) => h.includes('tyre size') || h === 'size');
    if (size < 0) continue;
    const target = row.findIndex((h) => h.includes('target'));
    const aCol = row.findIndex((h) => h.includes('curing'));               // grade-A = cured
    if (aCol < 0) continue;
    return { headerRow: i, size, target, a: aCol, b: aCol + 1, r: aCol + 2, total: aCol + 3 }; // A,B,R,Total consecutive
  }
  return null;
}

// each day sheet has a grand-total row: size cell blank, Total numeric (largest)
function dayTotal(s) {
  const c = mapCols(s.rows);
  if (!c) return null;
  let best = null;
  for (let i = c.headerRow + 1; i < s.rows.length; i++) {
    const row = s.rows[i];
    if (norm(row[c.size])) continue;                 // size present => a product line, not a total
    const tot = n(row[c.total]);
    const a = n(row[c.a]);
    if (tot > 100 && a > 0 && (!best || tot > best.produced)) {
      best = { produced: tot, target: n(row[c.target]), a, b: n(row[c.b]), r: n(row[c.r]) };
    }
  }
  return best;
}

const days = dayer
  .filter((x) => Number(x.m[2]) === wantMonth)
  .map((x) => ({ date: `${2000 + Number(x.m[3])}-${String(wantMonth).padStart(2, '0')}-${String(Number(x.m[1])).padStart(2, '0')}`, t: dayTotal(x.s) }))
  .filter((x) => x.t)
  .sort((a, b) => (a.date < b.date ? -1 : 1));

const sum = (f) => days.reduce((s, d) => s + f(d.t), 0);
const produced = sum((t) => t.produced), target = sum((t) => t.target);
const gA = sum((t) => t.a), gB = sum((t) => t.b), gR = sum((t) => t.r);
const pct = (v) => (produced ? +(100 * v / produced).toFixed(1) : 0);
const latest = days[days.length - 1];

const out = {
  generated_at: new Date().toISOString(),
  source: path.basename(inPath),
  month: `${wantYear}-${String(wantMonth).padStart(2, '0')}`,
  as_of: latest?.date || null,
  days_reported: days.length,
  mtd: {
    produced, target,
    attainment_pct: target ? +(100 * produced / target).toFixed(1) : null,
    grade_a: gA, grade_b: gB, reject: gR,
    grade_a_pct: pct(gA), off_grade_pct: +(pct(gB) + pct(gR)).toFixed(1),
    avg_per_day: days.length ? Math.round(produced / days.length) : 0,
  },
  by_day: days.map((d) => ({ date: d.date, produced: d.t.produced, target: d.t.target, off_grade: d.t.b + d.t.r })),
};
fs.writeFileSync(path.join(outDir, 'daily-production.json'), JSON.stringify(out, null, 2) + '\n');

console.log('daily-production — done');
console.log('  month      :', out.month, `· ${days.length} days · through ${out.as_of}`);
console.log('  MTD output :', produced.toLocaleString(), 'tyres · target', target.toLocaleString(), `(${out.mtd.attainment_pct}% attainment)`);
console.log('  grade mix  :', `A ${out.mtd.grade_a_pct}% · off-grade ${out.mtd.off_grade_pct}% · avg/day ${out.mtd.avg_per_day.toLocaleString()}`);
console.log('  ->', path.join('out', 'daily-production.json'));
