#!/usr/bin/env node
// galaxy-orders.mjs — Orders & receivables from a Galaxy iStock Sales/Receivables export (or Viber orders).
// See ISTOCK-INTEGRATION.md. Reads a Sales Register / Outstanding-Receivables export (xlsx OR csv),
// maps Galaxy's columns to a common shape, and emits out/orders.json:
//   { orders:[…recent…], receivables:{ by_dealer:[{dealer,invoiced,paid,balance,aging_bucket,oldest_days}], totals }, as_of }
// Aging uses an explicit days/overdue column if present, else computes from a due/invoice date.
//
// Input : a Galaxy export (argv[2]) OR auto-find in data/drive-cache, data/. --asof=YYYY-MM-DD optional.
// Output: out/orders.json   Usage: node galaxy-orders.mjs ["Galaxy Receivables June.xlsx"]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx, densify } from './lib/xlsx-lite.mjs';
import { parseNum } from './lib/num.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
fs.mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
const asofArg = (args.find((a) => a.startsWith('--asof=')) || '').replace('--asof=', '');
const asof = asofArg && !isNaN(Date.parse(asofArg)) ? new Date(asofArg) : new Date();

function findInput() {
  const explicit = args.find((a) => !a.startsWith('--'));
  if (explicit) return explicit;
  const roots = [path.join(DIR, 'data', 'drive-cache'), path.join(DIR, 'data')];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const hit = fs.readdirSync(r).filter((f) => /(sales|receivabl|outstanding|invoice|galaxy.*order|order.*galaxy)/i.test(f) && /\.(xlsx|csv)$/i.test(f)).sort().reverse()[0];
    if (hit) return path.join(r, hit);
  }
  return null;
}
const inPath = findInput();
if (!inPath || !fs.existsSync(inPath)) { console.log('galaxy-orders: no Galaxy sales/receivables export found (data/drive-cache). Skipping — see ISTOCK-INTEGRATION.md.'); process.exit(0); }

const lc = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
function loadRows(p) {
  if (/\.csv$/i.test(p)) {
    const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim();
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) { const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c; }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  const { sheets } = readXlsx(p);
  const s = sheets[0];
  return densify ? densify(s.rows, s.merges) : s.rows;
}

let rows = [];
try { rows = loadRows(inPath); } catch (e) { console.error('galaxy-orders: could not read', path.basename(inPath), '-', e.message); process.exit(0); }

// map header
const COL = [
  ['date', (h) => /date|invoice\s*date|order\s*date|bill\s*date/.test(h)],
  ['dealer', (h) => /customer|dealer|party|account|buyer|shop|client/.test(h)],
  ['invoice', (h) => /invoice|bill\s*no|voucher|doc\s*no|order\s*no|ref/.test(h)],
  ['item', (h) => /item|product|size|description|particular/.test(h)],
  ['qty', (h) => /qty|quantity|pcs|nos/.test(h)],
  ['amount', (h) => /amount|invoiced|total|gross|net|value|debit/.test(h)],
  ['paid', (h) => /paid|received|receipt|credit\b/.test(h)],
  ['balance', (h) => /balance|outstanding|due\s*amount|bal\b/.test(h)],
  ['days', (h) => /days|overdue|aging|age\b/.test(h)],
  ['due', (h) => /due\s*date|due$/.test(h)],
];
let hdr = -1, cols = null;
for (let i = 0; i < Math.min(rows.length, 15); i++) {
  const r = (rows[i] || []).map(lc);
  const c = {};
  for (const [key, test] of COL) { const j = r.findIndex((h) => h && test(h)); if (j >= 0 && c[key] == null) c[key] = j; }
  if ((c.dealer != null) && (c.amount != null || c.balance != null)) { hdr = i; cols = c; break; }
}
if (hdr < 0) { console.error('galaxy-orders: could not map header (need at least dealer + amount/balance). Columns seen:', (rows[0] || []).join(' | ').slice(0, 160)); process.exit(0); }

const get = (row, key) => (cols[key] != null ? row[cols[key]] : undefined);
const orders = [], dealers = {};
const daysFromDue = (v) => { const t = Date.parse(v); return isNaN(t) ? null : Math.round((asof - t) / 864e5); };
for (let i = hdr + 1; i < rows.length; i++) {
  const row = rows[i]; if (!row) continue;
  const dealer = String(get(row, 'dealer') || '').trim();
  if (!dealer || /total|grand|sub-?total/i.test(dealer)) continue;
  const amount = parseNum(get(row, 'amount'), 0);
  const paid = parseNum(get(row, 'paid'), 0);
  let balance = cols.balance != null ? parseNum(get(row, 'balance'), 0) : (amount - paid);
  let days = cols.days != null ? parseNum(get(row, 'days'), 0) : (cols.due != null ? daysFromDue(get(row, 'due')) : null);
  const date = String(get(row, 'date') || '').trim() || null;
  if (amount === 0 && balance === 0) continue;
  orders.push({ date, dealer, invoice: String(get(row, 'invoice') || '').trim() || null, item: String(get(row, 'item') || '').trim() || null, qty: parseNum(get(row, 'qty'), 0) || null, amount, paid, balance, days });
  const d = (dealers[dealer] = dealers[dealer] || { dealer, invoiced: 0, paid: 0, balance: 0, oldest_days: 0, invoices: 0 });
  d.invoiced += amount; d.paid += paid; d.balance += balance; d.invoices++;
  if (days != null && days > d.oldest_days) d.oldest_days = days;
}

const bucketOf = (days) => days == null ? 'unknown' : days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
const by_dealer = Object.values(dealers).map((d) => ({ ...d, invoiced: Math.round(d.invoiced), paid: Math.round(d.paid), balance: Math.round(d.balance), aging_bucket: bucketOf(d.oldest_days) }))
  .filter((d) => d.balance > 0).sort((a, b) => b.balance - a.balance);
const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, unknown: 0 };
for (const d of by_dealer) buckets[d.aging_bucket] += d.balance;
const totalBalance = by_dealer.reduce((s, d) => s + d.balance, 0);
const overdue = by_dealer.filter((d) => d.oldest_days > 60);

const out = {
  generated_at: new Date().toISOString(), source: path.basename(inPath), as_of: asof.toISOString().slice(0, 10),
  orders: orders.slice().sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1)).slice(0, 60),
  order_count: orders.length,
  receivables: {
    totals: { dealers: by_dealer.length, outstanding: Math.round(totalBalance), overdue_60plus: Math.round(overdue.reduce((s, d) => s + d.balance, 0)), aging: buckets },
    by_dealer: by_dealer.slice(0, 50),
  },
};
fs.writeFileSync(path.join(outDir, 'orders.json'), JSON.stringify(out, null, 2) + '\n');
console.log('galaxy-orders — done');
console.log('  source     :', out.source, '·', out.order_count, 'rows · as of', out.as_of);
console.log('  receivables:', by_dealer.length, 'dealers ·', (totalBalance / 1e6).toFixed(1) + 'M outstanding ·', (out.receivables.totals.overdue_60plus / 1e6).toFixed(1) + 'M overdue 60+');
console.log('  ->', path.join('out', 'orders.json'));
