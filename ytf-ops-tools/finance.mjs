#!/usr/bin/env node
// finance.mjs — P&L / revenue / cash from YTF's accounting workbook ("... Profit & Loss.xlsx").
//
// Completes the ERP money side: revenue, COGS, gross & net margin, sales by product line + month,
// and cash position — read label-by-label from the clean "Profit & Loss" / "Sales" / "Cash & Bank"
// sheets (robust to the value sitting in different columns per row).
//
// Input : a "...Profit & Loss.xlsx" (argv[2], or auto-find latest in drive-cache)
// Output: out/finance.json
//
// Usage : node finance.mjs ["path/to/2025 H1 Profit & Loss.xlsx"]

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
  const roots = [path.join(DIR, 'data', 'drive-cache'), path.join(DIR, 'data')];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const hit = fs.readdirSync(r).filter((f) => /profit\s*&?\s*loss|p\s*&?\s*l/i.test(f) && /\.xlsx$/i.test(f)).sort().reverse()[0];
    if (hit) return path.join(r, hit);
  }
  return path.join(DIR, 'data', 'profit-loss.xlsx');
}
const inPath = findInput();
if (!fs.existsSync(inPath)) { console.error('finance: no Profit & Loss workbook found. Skipping.'); process.exit(0); }

const lc = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const num = (v) => parseNum(v, NaN);
const nums = (row) => row.map(num).filter((x) => Number.isFinite(x));
const bn = (n) => (n == null ? null : +(n / 1e9).toFixed(2));

let sheets = [];
try { ({ sheets } = readXlsx(inPath)); } catch (e) { console.error(`finance: cannot read ${path.basename(inPath)} (${e.message})`); process.exit(0); }
const byName = (re) => sheets.find((s) => re.test(s.name));

// ---- P&L statement (values: amounts are >1; margins are 0..1) ----
const pl = byName(/profit\s*&?\s*loss/i) || sheets[3];
const findRow = (s, label) => s.rows.find((r) => r.some((c) => lc(c).includes(label)));
const amount = (row) => { const v = nums(row).filter((x) => Math.abs(x) > 1); return v.length ? Math.max(...v) : null; };
const margin = (row) => { const v = nums(row).find((x) => x > 0 && x < 1); return v != null ? +(v * 100).toFixed(1) : null; };

const plData = {};
if (pl) {
  const R = (lbl) => findRow(pl, lbl);
  plData.revenue = amount(R('revenue') || []);
  plData.cogs = amount(R('cost of goods') || []);
  const gr = R('gross profit'); plData.gross_profit = amount(gr || []); plData.gross_margin_pct = margin(gr || []);
  plData.other_income = amount(R('other income') || []);
  plData.selling_marketing = amount(R('selling') || []);
  plData.administrative = amount(R('administrative') || []);
  const nr = R('net profit'); plData.net_profit = amount(nr || []); plData.net_margin_pct = margin(nr || []);
  // derive margins if the sheet didn't state them
  if (plData.gross_margin_pct == null && plData.revenue) plData.gross_margin_pct = +(100 * plData.gross_profit / plData.revenue).toFixed(1);
  if (plData.net_margin_pct == null && plData.revenue) plData.net_margin_pct = +(100 * plData.net_profit / plData.revenue).toFixed(1);
}

// ---- Sales by product line + month ----
const salesSheet = byName(/^sales$/i) || byName(/sales/i);
const months = [];
let productTotals = null;
if (salesSheet) {
  for (const r of salesSheet.rows) {
    const label = lc(r[1]);
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(label)) {
      const total = num(r[6]);
      if (Number.isFinite(total)) months.push({ month: String(r[1]).trim(), nylon: num(r[2]) || 0, radial: num(r[3]) || 0, mc: num(r[5]) || 0, total });
    }
  }
  // product totals = column sums across months (robust to the totals-row column drift)
  productTotals = {
    nylon: months.reduce((a, m) => a + (m.nylon || 0), 0),
    radial: months.reduce((a, m) => a + (m.radial || 0), 0),
    mc: months.reduce((a, m) => a + (m.mc || 0), 0),
    total: months.reduce((a, m) => a + (m.total || 0), 0),
  };
}

// ---- Cash & bank balance (the "Total" row, Balance column) ----
const cashSheet = byName(/cash\s*&?\s*bank/i);
let cashBalance = null, cashAccounts = [];
if (cashSheet) {
  for (const r of cashSheet.rows) {
    const name = String(r[0] || '').trim();
    if (/^total$/i.test(name)) cashBalance = num(r[4]);
    else if (name && Number.isFinite(num(r[4])) && !/balance|in|out/i.test(lc(r[0]))) cashAccounts.push({ account: name, balance: Math.round(num(r[4])) });
  }
  cashAccounts = cashAccounts.filter((a) => Number.isFinite(a.balance)).sort((a, b) => b.balance - a.balance).slice(0, 8);
}

const bestMonth = [...months].sort((a, b) => b.total - a.total)[0];
const rawPeriod = String(pl?.rows?.find((r) => /2025|2024|2023/.test(String(r[3] || r[0])))?.[3] || salesSheet?.rows?.[1]?.[0] || '').trim();
// clean half-year label from the messy raw period (e.g. "1St,Jan;;'2025 to 30th Jun; 2025" -> "H1 2025")
const fyr = (rawPeriod.match(/20\d\d/) || ['?'])[0];
const half = /jul|aug|sep|oct|nov|dec/i.test(rawPeriod) && !/jan|feb/i.test(rawPeriod.split(/to/i)[0] || '') ? 'H2' : /jan/i.test(rawPeriod) && /jun/i.test(rawPeriod) ? 'H1' : '';
const out = {
  generated_at: new Date().toISOString(),
  source: path.basename(inPath),
  period: rawPeriod || '(period)',
  as_of: half ? `${half} ${fyr}` : fyr,
  currency: 'MMK',
  pl: plData,
  sales: { by_product: productTotals, by_month: months, best_month: bestMonth ? { month: bestMonth.month, total: bestMonth.total } : null },
  cash: { balance: cashBalance != null ? Math.round(cashBalance) : null, top_accounts: cashAccounts },
  checks: {
    gross_reconciles: plData.revenue && plData.cogs && plData.gross_profit
      ? Math.abs((plData.revenue - plData.cogs) - plData.gross_profit) < Math.max(1e6, plData.revenue * 0.002) : null,
    sales_vs_revenue_pct: plData.revenue && productTotals ? +(100 * productTotals.total / plData.revenue).toFixed(1) : null,
  },
};
fs.writeFileSync(path.join(outDir, 'finance.json'), JSON.stringify(out, null, 2) + '\n');

console.log('finance — done');
console.log('  source     :', out.source, '·', out.period);
console.log('  revenue    :', bn(plData.revenue) + 'B  COGS', bn(plData.cogs) + 'B  gross', bn(plData.gross_profit) + `B (${plData.gross_margin_pct}%)`);
console.log('  net profit :', bn(plData.net_profit) + `B (${plData.net_margin_pct}%)`);
console.log('  sales mix  :', productTotals ? `nylon ${bn(productTotals.nylon)}B / radial ${bn(productTotals.radial)}B / mc ${bn(productTotals.mc)}B` : 'n/a', bestMonth ? `· best ${bestMonth.month} ${bn(bestMonth.total)}B` : '');
console.log('  cash       :', bn(cashBalance) + 'B  ·  gross reconciles:', out.checks.gross_reconciles);
console.log('  ->', path.join('out', 'finance.json'));
