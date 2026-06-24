#!/usr/bin/env node
// pipeline.mjs — turn the YTF structured ledgers into the panel's data layer.
//
// Reads the ledgers produced by ../ytf-ops-tools/extract.mjs (out/*.csv + summary.json)
// and emits two static files the deployed panel serves:
//   public/ytf-dashboard.json  — compact headline + operational alerts (the YTF Ops card)
//   public/ytf-ops.json        — the full structured payload (claims/procurement/raw-mat/
//                                 production/contacts) for the ops.html detail view
//
// This is the "structured data" half of SuperMega Remote: the panel TRIGGERS the live
// pipeline; this turns what the pipeline knows into something you can read on your phone.
//
// Usage: node pipeline.mjs [path/to/ytf-ops-tools/out]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const srcDir = process.argv[2] || path.join(DIR, '..', 'ytf-ops-tools', 'out');
const pubDir = path.join(DIR, 'feed'); // PRIVATE feed dir — served only via the token-gated /api/control?action=data (not public CDN)
fs.mkdirSync(pubDir, { recursive: true });
// feed namespace — must match the panel's config.json `feed_prefix` and the server FEED_PREFIX env (default 'ytf')
let FP = process.env.FEED_PREFIX || 'ytf';
try { const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'public', 'config.json'), 'utf8')); if (!process.env.FEED_PREFIX && cfg.feed_prefix) FP = cfg.feed_prefix; } catch {}
FP = String(FP).replace(/[^a-z0-9-]/gi, '') || 'ytf';

// --- tiny CSV reader (handles quoted fields + embedded commas/quotes) ---
function readCsv(file) {
  const full = path.join(srcDir, file);
  if (!fs.existsSync(full)) return [];
  const text = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
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
  const headers = rows.shift();
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

const readJson = (file, fallback) => {
  const full = path.join(srcDir, file);
  try { return JSON.parse(fs.readFileSync(full, 'utf8')); } catch { return fallback; }
};

// --- load ledgers ---
const summary = readJson('summary.json', null);
if (!summary) {
  console.error(`No summary.json in ${srcDir}. Run ytf-ops-tools/extract.mjs first.`);
  process.exit(1);
}
const claims = readCsv('claims-ledger.csv');
const procurement = readCsv('procurement-ledger.csv');
const rawmat = readCsv('raw-material-shipments.csv');
const production = readCsv('production-reports.csv');
const contacts = readCsv('contacts.csv');
const driveSources = readJson('drive-sources.json', null); // optional — from drive-sources.mjs
const retailers = readJson('retailers.json', null);        // optional — from retailers.mjs
const inventory = readJson('inventory.json', null);        // optional — from inventory.mjs (in-transit)
const stock = readJson('stock-balance.json', null);        // optional — from stock-balance.mjs (on-hand)
const finance = readJson('finance.json', null);            // optional — from finance.mjs (P&L/cash)
const daily = readJson('daily-production.json', null);     // optional — from daily-production.mjs (current month MTD)
const insights = readJson('insights.json', null);          // optional — from insights.mjs (cross-module signals)
const trends = readJson('trends.json', null);              // optional — from trends.mjs (momentum + history)
const sites = readJson('sites.json', null);                // optional — from sites.mjs (Factory A/B, Showroom, HO)
const quality = readJson('quality.json', null);            // optional — from quality.mjs (WCM/ISO/IATF scorecard)
const copq    = readJson('copq.json', null);               // optional — from copq.mjs (Cost of Poor Quality: scrap+claims+downtime)
const productionFg = readJson('production.json', null);    // optional — from production.mjs (finished goods, PCR/Radial)
const productionMc = readJson('production-mc.json', null);  // optional — from production-mc.mjs (motorcycle line)
const manualEntries = readJson('manual-entries.json', null); // optional — from manual-entries.mjs (whiteboard + OCR captures)
const orders = readJson('orders.json', null);               // optional — from galaxy-orders.mjs (iStock sales + receivables)
const hasCurrentPeriod = (value) => /(?:^|[^0-9])2026(?:[^0-9]|$)/.test(String(value || ''));
const financeIsCurrent = hasCurrentPeriod(finance?.as_of) || hasCurrentPeriod(finance?.period);
const exposeSourceCatalog = process.env.EXPOSE_SOURCE_CATALOG === '1';
const exposeQualityWcm = process.env.EXPOSE_QUALITY_WCM === '1';
const insightIsCurrentEnough = (signal) => {
  if (financeIsCurrent) return true;
  const text = [signal?.area, signal?.title, signal?.detail, signal?.source].filter(Boolean).join(' ');
  return !/\b(finance|financial|revenue|margin|profit|cash|p&l|h1 2025)\b/i.test(text);
};
const visibleInsightSignals = (insights?.signals || []).filter(insightIsCurrentEnough);
const visibleInsights = insights
  ? {
      ...insights,
      signals: visibleInsightSignals,
      counts: visibleInsightSignals.reduce((acc, signal) => {
        const key = signal?.severity || 'other';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    }
  : null;
const visibleSites = sites
  ? {
      ...sites,
      sites: (sites.sites || []).map((site) => ({ ...site, sources: [] })),
    }
  : null;

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
const daysBetween = (a, b) => {
  if (!a || !b) return 0;
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));
};

// procurement refs are TFT numbers; "latest" = highest ref
const procSorted = [...procurement].sort((a, b) => Number(a.tft_ref || 0) - Number(b.tft_ref || 0));
const latestTft = last(procSorted);
const rawLatest = [...rawmat].sort(byDateDesc)[0];
const claimsNeedingReply = (summary.claims?.by_status?.rejected || 0) + (summary.claims?.by_status?.partial || 0);

// --- headline (what the YTF Ops card shows) ---
const headline = {
  claims_processed: summary.claims?.total || 0,
  claims_approval_pct: summary.claims?.approval_rate_pct || 0,
  procurement_threads: procurement.length,
  procurement_latest: latestTft ? `TFT(${latestTft.tft_ref})` : '—',
  raw_material_shipments: rawmat.length,
  production_reports: production.length,
  parties: contacts.length,
  window_days: daysBetween(summary.window?.from, summary.window?.to),
  sources_tracked: exposeSourceCatalog ? driveSources?.total || 0 : 0,
  sources_live: exposeSourceCatalog ? driveSources?.by_status?.live || 0 : 0,
  dealers: retailers?.totals?.dealers || 0,
  retailer_regions: retailers?.by_region?.length || 0,
  distribution_sales_b: retailers?.totals?.total_amount ? +(retailers.totals.total_amount / 1e9).toFixed(2) : 0,
  top_region: retailers?.by_region?.[0]?.key || '',
  materials_in_transit: inventory?.totals?.in_transit_shipments || 0,
  materials_in_transit_mt: inventory?.totals?.in_transit_mt || 0,
  reorder_flags: inventory?.totals?.reorder_flags || 0,
  stock_materials: stock?.totals?.materials || 0,
  low_stock_items: stock?.totals?.low_or_out || 0,
  tyres_produced: (productionFg?.totals?.produced || 0) + (productionMc?.totals?.produced || 0),   // whole factory: PCR/Radial + MC
  tyres_produced_pcr: productionFg?.totals?.produced || 0,
  tyres_produced_mc: productionMc?.totals?.produced || 0,
  grade_a_pct: productionFg?.totals?.grade_a_pct || 0,
  off_grade_pct: productionFg?.totals?.off_grade_pct || 0,
  revenue_b: financeIsCurrent && finance?.pl?.revenue ? +(finance.pl.revenue / 1e9).toFixed(1) : 0,
  net_profit_b: financeIsCurrent && finance?.pl?.net_profit ? +(finance.pl.net_profit / 1e9).toFixed(1) : 0,
  net_margin_pct: financeIsCurrent ? finance?.pl?.net_margin_pct || 0 : 0,
  cash_b: financeIsCurrent && finance?.cash?.balance ? +(finance.cash.balance / 1e9).toFixed(1) : 0,
  mtd_produced: daily?.mtd?.produced || 0,
  mtd_attainment_pct: daily?.mtd?.attainment_pct || 0,
  mtd_as_of: daily?.as_of || null,
  critical_signals: visibleInsights?.counts?.critical || 0,
  high_signals: visibleInsights?.counts?.high || 0,
  production_momentum_pct: trends?.production_momentum?.change_pct ?? null,
  sales_mom_pct: trends?.sales_mom?.change_pct ?? null,
};

// --- operational alerts (most useful, surfaced first) ---
const alerts = [];
if (claimsNeedingReply > 0) {
  alerts.push(`${claimsNeedingReply} warranty claim(s) rejected/partial — need customer reply (DO/QC).`);
}
if (rawLatest) {
  // strip email greeting noise ("Dear ..., Good Morning/Afternoon") so the alert leads with substance
  const cleaned = (rawLatest.note || rawLatest.subject || '')
    .replace(/^\s*dear[^,]*,?\s*/i, '')
    .replace(/^\s*(good\s+(morning|afternoon|evening)|hi|hello)[,.\s]*/i, '')
    .trim();
  alerts.push(`Raw material in motion — ${rawLatest.date}: ${(cleaned || rawLatest.subject || '').slice(0, 120)}`);
}
if (latestTft) {
  alerts.push(`Latest procurement: TFT(${latestTft.tft_ref}) (${latestTft.date}) — ${(latestTft.supplier || 'supplier')}.`);
}
if (retailers?.totals?.dealers) {
  const t = retailers.totals;
  alerts.push(`Distribution: ${t.dealers} dealers · ${(t.total_amount / 1e9).toFixed(1)}B Kyat · ${t.nylon_share_pct}% nylon / ${t.radial_share_pct}% radial${retailers.sample ? ' (H2-2024 sample)' : ''}.`);
}
// inventory: reorder flags first (most actionable), then a compact in-transit summary
(inventory?.materials || []).filter((m) => m.reorder_flag).forEach((m) =>
  alerts.unshift(`⚠ Reorder: ${m.name} — ${m.days_since_last == null ? 'no inbound on record' : m.days_since_last + 'd since last inbound'}, nothing in transit.`));
if (inventory?.totals?.in_transit_shipments) {
  alerts.push(`Materials in transit: ${inventory.totals.in_transit_shipments} shipments (${inventory.totals.in_transit_mt}mt) from KIIC/Junky.`);
}
if (productionFg?.totals?.produced) {
  const t = productionFg.totals;
  alerts.push(`Production (${productionFg.product_line}): ${t.produced.toLocaleString()} tyres · grade-A ${t.grade_a_pct}% · off-grade ${t.off_grade_pct}%.`);
}
if (financeIsCurrent && finance?.pl?.revenue) {
  const f = finance.pl;
  alerts.push(`Financials (${finance.period}): revenue ${(f.revenue / 1e9).toFixed(1)}B · net ${(f.net_profit / 1e9).toFixed(1)}B (${f.net_margin_pct}% margin) · cash ${finance.cash?.balance ? (finance.cash.balance / 1e9).toFixed(1) + 'B' : '—'}.`);
}
if (daily?.mtd?.produced) {
  const m = daily.mtd;
  alerts.unshift(`Production MTD (${daily.month}, through ${daily.as_of}): ${m.produced.toLocaleString()} tyres · ${m.attainment_pct}% of target${m.attainment_pct < 95 ? ' ⚠ behind' : ''}.`);
}
// stock on-hand: low-cover materials (months-of-cover) — high-priority, surfaced near the top
(stock?.low_cover || []).slice(0, 3).forEach((m) =>
  alerts.unshift(`⚠ Low stock: ${m.material.trim()} — ${m.months_cover == null ? 'no consumption rate' : m.months_cover + 'mo cover'} (${m.closing} ${m.unit} on hand).`));

// --- write compact dashboard ---
const dashboard = {
  generated_at: new Date().toISOString(),
  source: 'ytf-ops-tools',
  window: summary.window || {},
  as_of: {
    production_stock: productionFg?.as_of || (stock?.period || '').match(/20\d\d/)?.[0] || null, // last closed month
    production_mtd: daily?.as_of || null,                                                         // freshest daily output
    finance: financeIsCurrent ? (finance?.as_of || finance?.period || null) : null,
    gmail: summary.window?.to || null,                                                            // rolling
    note: 'production/stock monthly = last closed month; production_mtd = daily output; stale finance is hidden until current P&L exists',
  },
  headline,
  categories: summary.categories || {},
  // lead with the synthesized cross-module signals (sharper than the raw per-module alerts), then the rest
  alerts: [
    ...(visibleInsights?.signals || []).filter((s) => s.severity === 'critical' || s.severity === 'high').slice(0, 4)
      .map((s) => `${s.severity === 'critical' ? '🔴' : '🟠'} ${s.title}`),
    ...alerts,
  ].slice(0, 10),
};
fs.writeFileSync(path.join(pubDir, `${FP}-dashboard.json`), JSON.stringify(dashboard, null, 2) + '\n');

// --- detail view payload, split for mobile: lean core + lazy-loaded heavy ledgers ---
// The 3 big ledgers (claims/procurement/raw-material ~120KB) are written to their own files
// and fetched on demand; the core keeps only a preview (top 15) + counts for fast first paint.
const claimsSorted = [...claims].sort(byDateDesc);
const rawSorted = [...rawmat].sort(byDateDesc);
const procDisplay = [...procSorted].reverse(); // latest TFT first
const PREVIEW = 15;
const heavy = {
  [`${FP}-claims.json`]: claimsSorted,
  [`${FP}-procurement.json`]: procDisplay,
  [`${FP}-raw-material.json`]: rawSorted,
};
for (const [file, rows] of Object.entries(heavy)) {
  fs.writeFileSync(path.join(pubDir, file), JSON.stringify({ generated_at: dashboard.generated_at, count: rows.length, rows }, null, 2) + '\n');
}

const ops = {
  generated_at: dashboard.generated_at,
  window: dashboard.window,
  as_of: dashboard.as_of,
  alerts: dashboard.alerts,
  summary,
  // heavy ledgers: preview + count + url (full set lazy-loaded by ops.html)
  claims: { count: claimsSorted.length, url: `/api/control?action=data&file=${FP}-claims`, preview: claimsSorted.slice(0, PREVIEW) },
  procurement: { count: procDisplay.length, url: `/api/control?action=data&file=${FP}-procurement`, preview: procDisplay.slice(0, PREVIEW) },
  raw_material: { count: rawSorted.length, url: `/api/control?action=data&file=${FP}-raw-material`, preview: rawSorted.slice(0, PREVIEW) },
  // light sections kept inline
  production: [...production].sort(byDateDesc),
  contacts,
  drive_sources: exposeSourceCatalog ? driveSources?.sources || [] : [],
  retailers: retailers || null,
  inventory: inventory || null,
  stock_balance: stock || null,
  production_fg: productionFg || null,
  production_mc: productionMc || null,
  captures: manualEntries || null,
  orders: orders || null,
  daily_production: daily || null,
  finance: financeIsCurrent ? finance : null,
  insights: visibleInsights || null,
  trends: trends || null,
  sites: visibleSites || null,
  quality: exposeQualityWcm ? quality || null : null,
  copq: copq || null,               // Cost of Poor Quality — always exposed (no email-derived data)
};
fs.writeFileSync(path.join(pubDir, `${FP}-ops.json`), JSON.stringify(ops, null, 2) + '\n');
if (driveSources) fs.writeFileSync(path.join(pubDir, `${FP}-sources.json`), JSON.stringify(driveSources, null, 2) + '\n');

console.log('pipeline — done');
console.log('  source       :', srcDir);
console.log('  claims       :', headline.claims_processed, `(${headline.claims_approval_pct}% approval)`);
console.log('  procurement  :', headline.procurement_threads, 'threads, latest', headline.procurement_latest);
console.log('  raw material :', headline.raw_material_shipments, 'shipments');
console.log('  production   :', headline.production_reports, 'reports');
if (retailers?.totals) console.log('  distribution :', headline.dealers, 'dealers,', headline.distribution_sales_b + 'B Kyat, top', headline.top_region);
if (stock?.totals) console.log('  stock on-hand:', headline.stock_materials, 'materials,', headline.low_stock_items, 'low/out');
if (productionFg?.totals) console.log('  production   :', headline.tyres_produced.toLocaleString(), 'tyres, grade-A', headline.grade_a_pct + '%');
console.log('  alerts       :', alerts.length);
console.log('  split        : claims/procurement/raw-material -> own files (lazy-loaded), core trimmed to preview');
console.log(`  -> feed/${FP}-dashboard.json, ${FP}-ops.json (+ ${FP}-claims/procurement/raw-material.json) [PRIVATE, token-gated]`);
