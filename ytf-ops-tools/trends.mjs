#!/usr/bin/env node
// trends.mjs — the time dimension. Turns point-in-time numbers into MOVEMENT:
//   - production momentum (daily series: recent days vs earlier days)
//   - sales month-over-month (from the P&L Sales sheet)
//   - a dated snapshot appended to data/history.json each refresh, so future refreshes
//     show week-over-week deltas (cover shrinking/growing, margin drift, etc.)
//
// Output: out/trends.json (+ appends data/history.json)   Usage: node trends.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')); } catch { return null; } };

const daily = rd('daily-production.json');
const finance = rd('finance.json');
const stock = rd('stock-balance.json');
const insights = rd('insights.json');
const prod = rd('production.json');

const pct = (cur, prev) => (prev ? +(((cur - prev) / prev) * 100).toFixed(1) : null);
const arrow = (d) => (d == null ? '·' : d > 1 ? '▲' : d < -1 ? '▼' : '▬');

const trends = {};

// ---- production momentum: recent days vs earlier days (same month) ----
if (daily?.by_day?.length >= 4) {
  const days = daily.by_day;
  const half = Math.floor(days.length / 2);
  const earlier = days.slice(0, half), recent = days.slice(half);
  const avg = (arr) => Math.round(arr.reduce((a, d) => a + d.produced, 0) / arr.length);
  const eAvg = avg(earlier), rAvg = avg(recent);
  trends.production_momentum = {
    month: daily.month,
    early_avg_per_day: eAvg,
    recent_avg_per_day: rAvg,
    change_pct: pct(rAvg, eAvg),
    direction: arrow(pct(rAvg, eAvg)),
    note: `${recent[0].date}→${recent[recent.length - 1].date} avg ${rAvg.toLocaleString()}/day vs earlier ${eAvg.toLocaleString()}/day`,
    last_day: days[days.length - 1],
  };
}

// ---- sales month-over-month (from finance Sales sheet) ----
if (finance?.sales?.by_month?.length >= 2) {
  const m = finance.sales.by_month;
  const series = m.map((x) => ({ month: x.month, total: x.total }));
  const last = m[m.length - 1], prev = m[m.length - 2];
  const best = [...m].sort((a, b) => b.total - a.total)[0];
  trends.sales_mom = {
    series,
    latest: { month: last.month, total: last.total },
    change_pct: pct(last.total, prev.total),
    direction: arrow(pct(last.total, prev.total)),
    best_month: { month: best.month, total: best.total },
    note: `${last.month} ${(last.total / 1e9).toFixed(1)}B vs ${prev.month} ${(prev.total / 1e9).toFixed(1)}B`,
  };
}

// ---- snapshot current state -> data/history.json (dedup by date) ----
const today = new Date().toISOString().slice(0, 10);
const snap = {
  date: today,
  mtd_produced: daily?.mtd?.produced ?? null,
  mtd_attainment_pct: daily?.mtd?.attainment_pct ?? null,
  ytd_produced: prod?.totals?.produced ?? null,
  off_grade_pct: daily?.mtd?.off_grade_pct ?? prod?.totals?.off_grade_pct ?? null,
  low_stock: stock?.totals?.low_or_out ?? null,
  critical_signals: insights?.counts?.critical ?? null,
  net_margin_pct: finance?.pl?.net_margin_pct ?? null,
  revenue_b: finance?.pl?.revenue ? +(finance.pl.revenue / 1e9).toFixed(1) : null,
  // track the headline material's runway so we can see it shrink
  carbon_n330_days: (insights?.signals || []).find((s) => /n-?330/i.test(s.title))?.metric?.days ?? null,
};
const histPath = path.join(DIR, 'data', 'history.json');
let history = [];
try { history = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch {}
if (!Array.isArray(history)) history = [];
history = history.filter((h) => h.date !== today); // replace same-day
history.push(snap);
history.sort((a, b) => (a.date < b.date ? -1 : 1));
history = history.slice(-180); // keep ~6 months of daily snapshots
fs.mkdirSync(path.dirname(histPath), { recursive: true });
fs.writeFileSync(histPath, JSON.stringify(history, null, 2) + '\n');

// ---- deltas vs the previous snapshot (week-over-week once history accrues) ----
if (history.length >= 2) {
  const prev = history[history.length - 2];
  const fields = ['mtd_produced', 'mtd_attainment_pct', 'low_stock', 'critical_signals', 'net_margin_pct', 'carbon_n330_days'];
  trends.vs_previous = { since: prev.date, deltas: {} };
  for (const f of fields) {
    if (snap[f] != null && prev[f] != null) trends.vs_previous.deltas[f] = { from: prev[f], to: snap[f], change: +(snap[f] - prev[f]).toFixed(1) };
  }
} else {
  trends.vs_previous = { since: null, note: 'baseline snapshot — cross-refresh deltas appear from the next run' };
}

const out = { generated_at: new Date().toISOString(), snapshots: history.length, ...trends };
fs.writeFileSync(path.join(outDir, 'trends.json'), JSON.stringify(out, null, 2) + '\n');

console.log('trends — done');
if (trends.production_momentum) console.log('  production :', trends.production_momentum.direction, trends.production_momentum.recent_avg_per_day.toLocaleString() + '/day recent', `(${trends.production_momentum.change_pct >= 0 ? '+' : ''}${trends.production_momentum.change_pct}% vs early-month)`);
if (trends.sales_mom) console.log('  sales MoM  :', trends.sales_mom.direction, trends.sales_mom.note, `(${trends.sales_mom.change_pct >= 0 ? '+' : ''}${trends.sales_mom.change_pct}%)`);
console.log('  snapshots  :', history.length, '(baseline today: ' + today + ')');
console.log('  ->', path.join('out', 'trends.json'));
