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

const sourcePlant = process.env.DAILY_PRODUCTION_PLANT || 'plant-b';

function lineFromHeading(value) {
  const text = norm(value).toUpperCase();
  if (!text) return '';
  if (/\bPCR\b|RADIAL/.test(text)) return 'PCR';
  if (/\bMC\b|MOTORCYCLE/.test(text)) return 'MC';
  if (/\bTBR\b|TRUCK|BUS/.test(text)) return 'TBR';
  if (/\bAG\b|AGRIC/.test(text)) return 'AG';
  return '';
}

function parseProductionCount(row, c) {
  const a = n(row[c.a]);
  let b = n(row[c.b]);
  let reject = n(row[c.r]);
  let total = n(row[c.total]);

  // Some YTF sheets omit the reject cell on clean rows, shifting Total into the reject column.
  if (!total && reject >= a + b && reject > 0) {
    total = reject;
    reject = Math.max(0, total - a - b);
  }
  // Other clean rows omit both B and R, shifting Total into the B column.
  if (!total && !reject && b >= a && b > 0) {
    total = b;
    b = Math.max(0, total - a);
  }
  if (!total) total = a + b + reject;
  return { a, b, reject, total };
}

function daySizeRows(s, date) {
  const c = mapCols(s.rows);
  if (!c) return [];
  let line = '';
  for (let i = 0; i <= c.headerRow; i++) {
    line = lineFromHeading(s.rows[i]?.[0]) || line;
  }
  const rows = [];
  for (let i = c.headerRow + 1; i < s.rows.length; i++) {
    const row = s.rows[i];
    const maybeLine = lineFromHeading(row[0]);
    if (maybeLine) line = maybeLine;
    const size = norm(row[c.size]);
    if (!size) continue;
    const counts = parseProductionCount(row, c);
    if (counts.total <= 0 || counts.a <= 0) continue;
    if (/^total$/i.test(size) || /percentage|percent/i.test(size)) continue;
    rows.push({
      date,
      plant: sourcePlant,
      line: line || 'Tyre',
      size,
      target: n(row[c.target]),
      produced: counts.total,
      grade_a: counts.a,
      grade_b: counts.b,
      reject: counts.reject,
      off_grade: counts.b + counts.reject,
      weight_kg: n(row[9]),
    });
  }
  return rows;
}

// each day sheet has a grand-total row: size cell blank, Total numeric (largest)
function dayTotal(s, sizeRows = []) {
  if (sizeRows.length) {
    return {
      produced: sizeRows.reduce((sum, row) => sum + (row.produced || 0), 0),
      target: sizeRows.reduce((sum, row) => sum + (row.target || 0), 0),
      a: sizeRows.reduce((sum, row) => sum + (row.grade_a || 0), 0),
      b: sizeRows.reduce((sum, row) => sum + (row.grade_b || 0), 0),
      r: sizeRows.reduce((sum, row) => sum + (row.reject || 0), 0),
    };
  }
  const c = mapCols(s.rows);
  if (!c) return null;
  let best = null;
  for (let i = c.headerRow + 1; i < s.rows.length; i++) {
    const row = s.rows[i];
    if (norm(row[c.size])) continue;                 // size present => a product line, not a total
    const counts = parseProductionCount(row, c);
    if (counts.total > 100 && counts.a > 0 && (!best || counts.total > best.produced)) {
      best = { produced: counts.total, target: n(row[c.target]), a: counts.a, b: counts.b, r: counts.reject };
    }
  }
  return best;
}

const days = dayer
  .filter((x) => Number(x.m[2]) === wantMonth)
  .map((x) => {
    const date = `${2000 + Number(x.m[3])}-${String(wantMonth).padStart(2, '0')}-${String(Number(x.m[1])).padStart(2, '0')}`;
    const sizeRows = daySizeRows(x.s, date);
    return { date, sheet: x.s, sizeRows, t: dayTotal(x.s, sizeRows) };
  })
  .filter((x) => x.t)
  .sort((a, b) => (a.date < b.date ? -1 : 1));

const sum = (f) => days.reduce((s, d) => s + f(d.t), 0);
const produced = sum((t) => t.produced), target = sum((t) => t.target);
const gA = sum((t) => t.a), gB = sum((t) => t.b), gR = sum((t) => t.r);
const pct = (v) => (produced ? +(100 * v / produced).toFixed(1) : 0);
const latest = days[days.length - 1];
const byDaySize = days.flatMap((d) => d.sizeRows);
const aggregate = (keyFn) => {
  const map = new Map();
  for (const row of byDaySize) {
    const key = keyFn(row);
    const cur = map.get(key) || { key, plant: row.plant, line: row.line, size: row.size, target: 0, produced: 0, grade_a: 0, grade_b: 0, reject: 0, off_grade: 0, weight_kg: 0, days: new Set(), latest_date: row.date };
    cur.target += row.target || 0;
    cur.produced += row.produced || 0;
    cur.grade_a += row.grade_a || 0;
    cur.grade_b += row.grade_b || 0;
    cur.reject += row.reject || 0;
    cur.off_grade += row.off_grade || 0;
    cur.weight_kg += row.weight_kg || 0;
    cur.days.add(row.date);
    if (row.date > cur.latest_date) cur.latest_date = row.date;
    map.set(key, cur);
  }
  return [...map.values()].map((x) => ({
    ...x,
    days_reported: x.days.size,
    days: undefined,
    attainment_pct: x.target ? +(100 * x.produced / x.target).toFixed(1) : null,
    grade_a_pct: x.produced ? +(100 * x.grade_a / x.produced).toFixed(1) : null,
    weight_kg: +x.weight_kg.toFixed(2),
  })).sort((a, b) => b.produced - a.produced);
};
const bySize = aggregate((row) => `${row.line}|${row.size}`);
const byLine = aggregate((row) => row.line).map((row) => ({ ...row, size: undefined }));
const latestRows = byDaySize.filter((row) => row.date === latest?.date).sort((a, b) => b.produced - a.produced);

const out = {
  generated_at: new Date().toISOString(),
  source: path.basename(inPath),
  plant: sourcePlant,
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
  by_line: byLine,
  by_size: bySize,
  by_day_size: byDaySize,
  latest_day: latest ? { date: latest.date, rows: latestRows } : null,
};
fs.writeFileSync(path.join(outDir, 'daily-production.json'), JSON.stringify(out, null, 2) + '\n');

console.log('daily-production — done');
console.log('  month      :', out.month, `· ${days.length} days · through ${out.as_of}`);
console.log('  MTD output :', produced.toLocaleString(), 'tyres · target', target.toLocaleString(), `(${out.mtd.attainment_pct}% attainment)`);
console.log('  grade mix  :', `A ${out.mtd.grade_a_pct}% · off-grade ${out.mtd.off_grade_pct}% · avg/day ${out.mtd.avg_per_day.toLocaleString()}`);
console.log('  ->', path.join('out', 'daily-production.json'));
