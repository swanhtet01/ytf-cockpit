#!/usr/bin/env node
// galaxy-orders.mjs - Sales ledger / receivables adapter for YTF.
//
// Reads current Galaxy/iStock exports when they exist, but also handles the real
// YTF 2026 "All Ledger" workbooks already in Drive. Multiple readable ledgers
// are aggregated into one orders.json so MC, Radial, and Nylon sales do not
// overwrite each other.
//
// Output: out/orders.json
// Usage : node galaxy-orders.mjs ["All Ledger MC 2026.xlsx"] [--asof=YYYY-MM-DD]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx, densify } from './lib/xlsx-lite.mjs';
import { parseNum } from './lib/num.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
const dataDir = path.join(DIR, 'data');
const cacheDir = path.join(dataDir, 'drive-cache');
fs.mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const asofArg = (args.find((a) => a.startsWith('--asof=')) || '').replace('--asof=', '');
const asof = asofArg && !isNaN(Date.parse(asofArg)) ? new Date(asofArg) : new Date();

const WANT = /(all\s*ledger|sales?|sale.?invoice|receivabl|outstanding|invoice|galaxy.*order|order.*galaxy)/i;
const JUNK = /~\$|salary|payroll|spare\s*part|not\s*order|costing|bank|cash\s*received|voucher|purchase|raw|supplier|qc/i;
const currentYear = asof.getUTCFullYear();

function lineOf(file) {
  const n = path.basename(file).toLowerCase();
  if (/(^|[^a-z0-9])mc([^a-z0-9]|$)|motor/.test(n)) return 'MC';
  if (/radial/.test(n)) return 'Radial';
  if (/nylon|bias/.test(n)) return 'Nylon';
  return null;
}

function readInventoryCandidates() {
  const invPath = path.join(dataDir, 'drive-inventory.json');
  let inv = null;
  try { inv = JSON.parse(fs.readFileSync(invPath, 'utf8')); } catch { return []; }
  const root = cacheDir;
  return (inv.files || [])
    .filter((f) => f.cache && f.spreadsheet && WANT.test(f.name) && !JUNK.test(f.name))
    .map((f) => {
      const full = path.join(root, f.cache.replace(/^scan[\\/]/, 'scan/'));
      return fs.existsSync(full)
        ? { path: full, name: f.name, modified: f.modifiedTime || '', source: 'inventory' }
        : null;
    })
    .filter(Boolean);
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, item.name);
    if (item.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(xlsx|csv)$/i.test(item.name)) out.push(full);
  }
  return out;
}

function findInputs() {
  const explicit = args.find((a) => !a.startsWith('--'));
  if (explicit) return [explicit];

  const found = [];
  found.push(...readInventoryCandidates());
  found.push(...walkFiles(cacheDir)
    .filter((p) => WANT.test(path.basename(p)) && !JUNK.test(path.basename(p)))
    .map((p) => ({ path: p, name: path.basename(p), modified: fs.statSync(p).mtime.toISOString(), source: 'cache' })));

  const seen = new Set();
  return found
    .filter((f) => {
      const key = path.resolve(f.path).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => score(b) - score(a) || String(b.modified).localeCompare(String(a.modified)))
    .slice(0, 12)
    .map((f) => f.path);
}

function score(f) {
  const n = String(f.name || f.path).toLowerCase();
  let s = 0;
  if (n.includes(String(currentYear))) s += 30;
  if (/all\s*ledger/.test(n)) s += 25;
  if (/radial|nylon|\bmc\b|motor/.test(n)) s += 10;
  if (/sales?|sale.?invoice/.test(n)) s += 8;
  if (/outstanding|receivabl/.test(n)) s += 6;
  return s;
}

function lc(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function loadRows(p) {
  if (/\.csv$/i.test(p)) {
    const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim();
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  const { sheets } = readXlsx(p);
  const s = sheets[0];
  return densify ? densify(s.rows, s.merges) : s.rows;
}

const COL = [
  ['date', (h) => /date|invoice\s*date|order\s*date|bill\s*date/.test(h)],
  ['dealer', (h) => /customer|dealer|party|account|buyer|shop|client|name/.test(h)],
  ['invoice', (h) => /invoice|bill\s*no|voucher|doc\s*no|order\s*no|ref|ledger\s*no|no\./.test(h)],
  ['item', (h) => /item|product|size|description|particular/.test(h)],
  ['qty', (h) => /qty|quantity|pcs|nos|total\s*pcs/.test(h)],
  ['amount', (h) => /amount|invoiced|total|gross|net|value|debit|sale/.test(h)],
  ['paid', (h) => /paid|received|receipt|credit\b|payment/.test(h)],
  ['balance', (h) => /balance|outstanding|due\s*amount|bal\b|closing/.test(h)],
  ['days', (h) => /days|overdue|aging|age\b/.test(h)],
  ['due', (h) => /due\s*date|due$/.test(h)],
];

function mapHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const r = (rows[i] || []).map(lc);
    const c = {};
    for (const [key, test] of COL) {
      const j = r.findIndex((h) => h && test(h));
      if (j >= 0 && c[key] == null) c[key] = j;
    }
    if (c.dealer != null && (c.amount != null || c.balance != null || c.qty != null)) return { hdr: i, cols: c };
  }
  return null;
}

function parseOne(inPath) {
  const rows = loadRows(inPath);
  const mapped = mapHeader(rows);
  if (!mapped) {
    const seen = (rows[0] || []).join(' | ').slice(0, 160);
    throw new Error(`could not map header (${seen})`);
  }
  const { hdr, cols } = mapped;
  const get = (row, key) => (cols[key] != null ? row[cols[key]] : undefined);
  const daysFromDue = (v) => {
    const t = Date.parse(v);
    return isNaN(t) ? null : Math.round((asof - t) / 864e5);
  };
  const cleanDate = (v) => {
    const raw = String(v == null ? '' : v).trim();
    const serial = Number(raw);
    if (serial > 20000 && serial < 70000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 864e5);
      return d.toISOString().slice(0, 10);
    }
    const t = Date.parse(raw);
    return isNaN(t) ? raw || null : new Date(t).toISOString().slice(0, 10);
  };
  const productLine = lineOf(inPath);
  const orders = [];

  for (let i = hdr + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const dealer = String(get(row, 'dealer') || '').trim();
    if (!dealer || /total|grand|sub-?total|opening|closing/i.test(dealer)) continue;
    const amount = parseNum(get(row, 'amount'), 0);
    const paid = parseNum(get(row, 'paid'), 0);
    const qty = parseNum(get(row, 'qty'), 0) || null;
    const balance = cols.balance != null ? parseNum(get(row, 'balance'), 0) : (amount ? amount - paid : 0);
    const days = cols.days != null ? parseNum(get(row, 'days'), 0) : (cols.due != null ? daysFromDue(get(row, 'due')) : null);
    const date = cleanDate(get(row, 'date'));
    if (amount === 0 && balance === 0 && !qty) continue;
    orders.push({
      date,
      dealer,
      invoice: String(get(row, 'invoice') || '').trim() || null,
      item: String(get(row, 'item') || '').trim() || productLine,
      product_line: productLine,
      qty,
      amount,
      paid,
      balance,
      days,
      source: path.basename(inPath),
    });
  }
  return orders;
}

const inputPaths = findInputs();
const parseGaps = [];
const parsedSources = [];
let orders = [];
for (const p of inputPaths) {
  try {
    const rows = parseOne(p);
    if (!rows.length) {
      parseGaps.push({ source: path.basename(p), error: 'no sales rows' });
      continue;
    }
    orders.push(...rows);
    parsedSources.push(path.basename(p));
    console.log(`  ok ${path.basename(p)} - ${rows.length} rows`);
  } catch (e) {
    parseGaps.push({ source: path.basename(p), error: e.message.slice(0, 180) });
    console.log(`  skip ${path.basename(p)} - ${e.message.slice(0, 120)}`);
  }
}

const seen = new Set();
orders = orders.filter((o) => {
  const key = [o.invoice || '', o.dealer, o.date || '', o.item || '', o.amount || 0, o.balance || 0].join('|').toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const dealers = {};
for (const o of orders) {
  const d = dealers[o.dealer] = dealers[o.dealer] || { dealer: o.dealer, invoiced: 0, paid: 0, balance: 0, oldest_days: 0, invoices: 0, qty: 0 };
  d.invoiced += Number(o.amount) || 0;
  d.paid += Number(o.paid) || 0;
  d.balance += Number(o.balance) || 0;
  d.invoices++;
  d.qty += Number(o.qty) || 0;
  if (o.days != null && o.days > d.oldest_days) d.oldest_days = o.days;
}

const bucketOf = (days) => days == null ? 'unknown' : days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
const byDealer = Object.values(dealers)
  .map((d) => ({
    ...d,
    invoiced: Math.round(d.invoiced),
    paid: Math.round(d.paid),
    balance: Math.round(d.balance),
    qty: Math.round(d.qty),
    aging_bucket: bucketOf(d.oldest_days),
  }))
  .filter((d) => d.balance > 0 || d.invoiced > 0)
  .sort((a, b) => b.balance - a.balance);

const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0, unknown: 0 };
for (const d of byDealer) buckets[d.aging_bucket] += d.balance;
const totalBalance = byDealer.reduce((s, d) => s + d.balance, 0);
const overdue = byDealer.filter((d) => d.oldest_days > 60);
const qty = orders.reduce((s, o) => s + (Number(o.qty) || 0), 0);
const amount = orders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
const byLine = {};
for (const o of orders) {
  const line = o.product_line || 'Other';
  const g = byLine[line] = byLine[line] || { key: line, order_count: 0, qty: 0, amount: 0, balance: 0 };
  g.order_count++;
  g.qty += Number(o.qty) || 0;
  g.amount += Number(o.amount) || 0;
  g.balance += Number(o.balance) || 0;
}

const out = {
  generated_at: new Date().toISOString(),
  source: parsedSources,
  as_of: asof.toISOString().slice(0, 10),
  order_count: orders.length,
  totals: {
    qty: Math.round(qty),
    amount: Math.round(amount),
    dealers: byDealer.length,
  },
  by_line: Object.values(byLine).map((x) => ({
    ...x,
    qty: Math.round(x.qty),
    amount: Math.round(x.amount),
    balance: Math.round(x.balance),
  })).sort((a, b) => b.amount - a.amount),
  orders: orders.slice().sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1)).slice(0, 80),
  receivables: {
    totals: {
      dealers: byDealer.length,
      outstanding: Math.round(totalBalance),
      overdue_60plus: Math.round(overdue.reduce((s, d) => s + d.balance, 0)),
      aging: buckets,
    },
    by_dealer: byDealer.slice(0, 50),
  },
  parse_gaps: parseGaps.slice(0, 20),
};

fs.writeFileSync(path.join(outDir, 'orders.json'), JSON.stringify(out, null, 2) + '\n');
if (!orders.length) {
  console.log('galaxy-orders - no current sales rows parsed; wrote empty orders.json');
} else {
  console.log('galaxy-orders - done');
  console.log('  sources    :', out.source.join(', '));
  console.log('  rows       :', out.order_count, 'orders/ledger rows - as of', out.as_of);
  console.log('  sales      :', (amount / 1e9).toFixed(2) + 'B MMK', '- qty', out.totals.qty.toLocaleString());
  console.log('  receivable :', byDealer.length, 'dealers -', (totalBalance / 1e9).toFixed(2) + 'B outstanding');
}
