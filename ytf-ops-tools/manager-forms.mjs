#!/usr/bin/env node
// manager-forms.mjs - promote useful manager workbook rows into the ERP capture feed.
//
// The source workbook also contains HR/admin forms and old templates. This adapter is intentionally
// conservative: only current operational rows become records; personnel, phone/address, blank, and
// stale rows are skipped so the user-facing ERP does not leak private or useless sheet content.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './lib/xlsx-lite.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(DIR, 'data');
const cacheDir = path.join(dataDir, 'drive-cache');
const outDir = path.join(dataDir, 'manual-entries');
fs.mkdirSync(outDir, { recursive: true });

const inputPath = process.argv[2] || process.env.YTF_MANAGER_FORMS_PATH || path.join(cacheDir, 'All Form.xlsx');
const outPath = path.join(outDir, 'manager-forms.json');
const now = new Date(process.env.YTF_MANAGER_FORMS_NOW || Date.now());
const cutoffDays = Number(process.env.YTF_MANAGER_FORMS_MAX_AGE_DAYS || 120);
const cutoff = new Date(now.getTime() - cutoffDays * 86400000);

const PLANT_A_RE = /\b(plant\s*a|yangon|spt|qc|pd|bias)\b/i;
const PLANT_B_RE = /\b(plant\s*b|bilin|mc|motorcycle|radial)\b/i;
const OP_RE = /\b(5w1h|abnormal|incident|downtime|breakdown|repair|maintenance|claim|reject|defect|waste|quality|ground|stock|inventory|production|output|diesel|chemical|consumption|weight|shortage|scrap|safety|capa|ncr)\b/i;
const PRIVATE_RE = /\b(phone|address|education|employee|staff|attendance|overtime|salary|payroll|leave|roster|funeral|donation|name list|time in|time out)\b/i;
const ACTION_RE = /\b(5w1h|abnormal|incident|downtime|breakdown|repair|maintenance|safety|capa|ncr|claim)\b/i;
const MEASURE_RE = /\b(qty|quantity|pcs|kg|ton|stock|ground|different|difference|balance|actual|target|reject|waste|consumption|weight|hours?|minutes?|amount|total)\b/i;

const HEADER_HINTS = [
  'date', 'no', 'item', 'description', 'size', 'material', 'section', 'waste', 'unit',
  'stock', 'ground', 'different', 'difference', 'remarks', 'qty', 'quantity', 'actual',
  'target', 'reject', 'claim', 'reason', 'action', 'owner', 'status', 'machine',
  'production', 'consumption', 'weight',
];
const DROP_FIELDS = /\b(no|sr|serial|phone|address|education|name|signature|prepared|checked|approved|receiver|attendant)\b/i;

function clean(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase();
}

function toAsciiDigits(value) {
  return String(value ?? '').replace(/[\u1040-\u1049]/g, (ch) => String(ch.charCodeAt(0) - 0x1040));
}

function excelDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 30000 || n > 70000) return null;
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + n * 86400000).toISOString().slice(0, 10);
}

function fixYear(y) {
  const n = Number(y);
  if (!Number.isFinite(n)) return null;
  if (n < 100) return n >= 70 ? 1900 + n : 2000 + n;
  return n;
}

function isoDate(y, m, d) {
  const yy = fixYear(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!yy || !mm || !dd || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return dt.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (typeof value === 'number') return excelDate(value);
  const s = toAsciiDigits(clean(value));
  if (!s) return null;
  let m = /\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/.exec(s);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = /\b(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{2,4})\b/.exec(s);
  if (m) return isoDate(m[3], m[2], m[1]);
  m = /\b(20\d{2})\s*[- ]\s*(jan|feb|mar|apr|may|jun|jul|july|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(s);
  if (m) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      .findIndex((x) => m[2].toLowerCase().startsWith(x)) + 1;
    return isoDate(m[1], month, 1);
  }
  return null;
}

function currentEnough(date) {
  if (!date) return false;
  const dt = new Date(date + 'T00:00:00Z');
  return Number.isFinite(dt.getTime()) && dt >= cutoff && dt <= new Date(now.getTime() + 7 * 86400000);
}

function plantFromText(text) {
  const t = clean(text);
  if (PLANT_B_RE.test(t)) return 'plant-b';
  if (PLANT_A_RE.test(t)) return 'plant-a';
  return 'company';
}

function kindFor(text) {
  const t = norm(text);
  if (/\b5w1h|abnormal|incident|safety|capa|ncr\b/.test(t)) return '5w1h';
  if (/\bdowntime|breakdown|repair|maintenance\b/.test(t)) return 'downtime';
  if (/\bclaim|reject|defect|waste|quality|ground\b/.test(t)) return 'quality';
  if (/\bstock|inventory|balance|shortage\b/.test(t)) return 'stock';
  if (/\bproduction|output\b/.test(t)) return 'production';
  if (/\bconsumption|chemical|diesel|weight\b/.test(t)) return 'quality';
  return 'other';
}

function rowScore(row) {
  return row.reduce((score, cell) => {
    const t = norm(cell);
    if (!t) return score;
    return score + (HEADER_HINTS.some((h) => t === h || t.includes(h)) ? 1 : 0);
  }, 0);
}

function isBlankRow(row) {
  return row.every((cell) => !clean(cell));
}

function compactRow(row) {
  const out = [];
  for (const cell of row) {
    const t = clean(cell);
    if (t) out.push(t);
  }
  return out;
}

function headerKey(value, index) {
  const base = norm(value).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return base || `col_${index + 1}`;
}

function makeHeaders(header, next = []) {
  return header.map((h, i) => {
    const joined = [h, next[i]].map(clean).filter(Boolean).join(' ');
    return headerKey(joined || h, i);
  });
}

function rowObject(headers, row) {
  const obj = {};
  headers.forEach((h, i) => {
    const v = clean(row[i]);
    if (v) obj[h] = v;
  });
  return obj;
}

function usefulFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!v || DROP_FIELDS.test(k)) continue;
    if (DROP_FIELDS.test(String(v)) && !OP_RE.test(String(v))) continue;
    out[k] = v;
  }
  return out;
}

function hasMeasure(fields) {
  return Object.entries(fields).some(([k, v]) => MEASURE_RE.test(k) || (MEASURE_RE.test(String(v)) && /\d/.test(String(v))));
}

function operationalContext(sheetName, header, row, fields) {
  const text = [sheetName, ...header, ...row, ...Object.values(fields)].map(clean).join(' ');
  if (!OP_RE.test(text)) return false;
  if (PRIVATE_RE.test(text) && !ACTION_RE.test(text) && !/\b(waste|ground|stock|production|consumption|weight|claim|defect|reject)\b/i.test(text)) return false;
  return hasMeasure(fields) || ACTION_RE.test(text);
}

function contextDate(sheetRows) {
  const dates = [];
  for (const row of sheetRows.slice(0, 12)) {
    for (const cell of row) {
      const d = parseDate(cell);
      if (d) dates.push(d);
    }
  }
  const current = dates.filter(currentEnough).sort().pop();
  return current || dates.sort().pop() || null;
}

function rowDate(fields, fallback) {
  const candidates = Object.entries(fields)
    .filter(([k]) => /\bdate|when|day\b/i.test(k))
    .map(([, v]) => parseDate(v))
    .filter(Boolean);
  return candidates.find(currentEnough) || candidates[0] || fallback;
}

function summarize(kind, fields) {
  const values = Object.entries(fields)
    .filter(([k]) => !DROP_FIELDS.test(k))
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`)
    .slice(0, 5);
  return `${kind}: ${values.join(' / ')}`.slice(0, 180);
}

function extractSheet(sheet) {
  const rows = sheet.rows || [];
  const records = [];
  const fallbackDate = contextDate(rows);
  const sheetPlant = plantFromText(sheet.name);

  for (let i = 0; i < rows.length; i++) {
    if (rowScore(rows[i]) < 2) continue;
    const header = rows[i];
    const next = rows[i + 1] && rowScore(rows[i + 1]) >= 1 ? rows[i + 1] : [];
    const headers = makeHeaders(header, next);
    const headerText = compactRow(header).join(' ');
    const start = next.length ? i + 2 : i + 1;
    let blanks = 0;

    for (let r = start; r < Math.min(rows.length, start + 160); r++) {
      const row = rows[r];
      if (isBlankRow(row)) {
        blanks++;
        if (blanks >= 4) break;
        continue;
      }
      blanks = 0;
      if (rowScore(row) >= 2 && r > start) break;

      const rawFields = rowObject(headers, row);
      const fields = usefulFields(rawFields);
      if (!Object.keys(fields).length) continue;
      if (!operationalContext(sheet.name, header, row, fields)) continue;

      const date = rowDate(rawFields, fallbackDate);
      if (!currentEnough(date)) continue;

      const allText = [sheet.name, headerText, ...Object.values(fields)].join(' ');
      const kind = kindFor(allText);
      const plant = plantFromText(allText) || sheetPlant;
      const group = plant === 'company' ? 'head-office' : plant;
      records.push({
        kind,
        date,
        captured_via: 'manager-form',
        confidence: 0.72,
        group,
        fields: {
          plant,
          department: /qc|quality/i.test(allText) ? 'quality' : null,
          form: sheet.name,
          ...fields,
        },
        source_text: summarize(kind, fields),
      });
    }
  }
  return records;
}

function dedupe(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const key = [r.date, r.kind, r.group, r.source_text].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out.sort((a, b) => String(a.date) < String(b.date) ? 1 : -1);
}

function writeEmpty(reason) {
  fs.writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    source: 'manager-forms',
    reason,
    records: [],
  }, null, 2) + '\n');
  console.log(`manager-forms: ${reason} -> manager-forms.json (0 records)`);
}

if (!fs.existsSync(inputPath)) {
  writeEmpty(`cache missing: ${path.relative(DIR, inputPath)}`);
  process.exit(0);
}

let workbook;
try {
  workbook = readXlsx(inputPath, { densify: true });
} catch (e) {
  writeEmpty(`read failed: ${e.message}`);
  process.exit(0);
}

const records = dedupe((workbook.sheets || []).flatMap(extractSheet)).slice(0, 250);
fs.writeFileSync(outPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  source: 'manager-forms',
  input_modified: fs.statSync(inputPath).mtime.toISOString(),
  cutoff_days: cutoffDays,
  sheets_read: workbook.sheets?.length || 0,
  records,
}, null, 2) + '\n');

const byKind = records.reduce((acc, r) => ((acc[r.kind] = (acc[r.kind] || 0) + 1), acc), {});
console.log('manager-forms - done');
console.log('  sheets :', workbook.sheets?.length || 0, 'records:', records.length, JSON.stringify(byKind));
console.log('  ->', path.join('data', 'manual-entries', 'manager-forms.json'));
