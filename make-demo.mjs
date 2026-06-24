#!/usr/bin/env node
// make-demo.mjs — generate a PUBLIC demo tenant: a config + a synthetic (fake) feed, so the website
// can showcase the cockpit without exposing any real customer data. Writes:
//   public/config.demo.json   and   feed/demo-dashboard.json + feed/demo-ops.json (+ heavy ledgers)
// Deploy with deploy-demo.ps1 (FEED_PREFIX=demo, PANEL_TOKEN=demo). All numbers below are invented.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const feedDir = path.join(DIR, 'feed');
fs.mkdirSync(feedDir, { recursive: true });
const now = new Date().toISOString();

const config = {
  _comment: 'PUBLIC demo tenant — synthetic data only. Deployed at demo.supermega.dev (passcode: demo).',
  brand: 'Northwind Tyres', instance: 'Northwind Tyres', tagline: 'demo operations cockpit',
  accent: '#D97757', vertical: 'tyre-manufacturing', footer: 'Demo · Powered by SuperMega',
  feed_prefix: 'demo', monogram: 'NT',
  search_placeholder: 'Search materials, claims, sizes, stock… (demo)',
  search_chips: ['carbon', 'reorder', 'radial', 'rejected', 'low'],
  modules: { intelligence: true, trends: true, financials: true, production_mtd: true, production_fg: true,
    production_mc: true, production: true, inventory: true, stock_balance: true, distribution: true,
    claims: true, procurement: true, raw_material: true, parties: true, sites: true, quality_wcm: true, data_sources: false },
};
fs.writeFileSync(path.join(DIR, 'public', 'config.demo.json'), JSON.stringify(config, null, 2) + '\n');

const dashboard = {
  generated_at: now,
  as_of: { production_stock: '2026-05', finance: 'H1 2025', gmail: '2026-06-23' },
  window: { from: '2026-01-01', to: '2026-06-23' },
  headline: { claims_processed: 86, claims_approval_pct: 81, procurement_threads: 64, procurement_latest: 'PO(118)',
    stock_materials: 52, low_stock_items: 9, tyres_produced: 318400, grade_a_pct: 98.2, production_reports: 12,
    dealers: 31, top_region: 'Mandalay', sources_live: 4, sources_tracked: 6 },
  alerts: [
    'Carbon black N330 — ~2 days to stockout',
    'Bead wire — reorder flag (14 days since last inbound)',
    '6 warranty claims rejected/partial — need customer reply',
  ],
};
const ops = {
  generated_at: now, window: dashboard.window, as_of: dashboard.as_of, alerts: dashboard.alerts,
  summary: { threads: 410, claims: { total: 86, by_status: { approved: 70, partial: 9, rejected: 7 }, approval_rate_pct: 81 } },
  claims: { count: 86, url: '/api/control?action=data&file=demo-claims', preview: [
    { claim_id: 'NW-R044-26', product: 'radial', status: 'approved', date: '2026-06-20' },
    { claim_id: 'NW-R041-26', product: 'radial', status: 'partial', date: '2026-06-18' },
    { claim_id: 'NW-B009-26', product: 'bias', status: 'rejected', date: '2026-06-15' } ] },
  procurement: { count: 64, url: '/api/control?action=data&file=demo-procurement', preview: [
    { tft_ref: '118', date: '2026-06-22', note: 'Nylon cord order 1x40HQ — PI attached' },
    { tft_ref: '117', date: '2026-06-19', note: 'Carbon black remittance confirmed' } ] },
  raw_material: { count: 70, url: '/api/control?action=data&file=demo-raw-material', preview: [
    { date: '2026-06-21', supplier: 'KIIC', note: 'Carbon N330 — 3 containers, customs cleared' } ] },
  production: [{ date: '2026-06-20', source: 'Plant A', report: 'Daily output 1,930 tyres, A 98.4%' }],
  contacts: [{ name: 'U Kyaw', role: 'plant manager', org: 'Northwind', messages: 22 }],
  inventory: { as_of: '2026-06-23', totals: { in_transit_shipments: 3, in_transit_mt: 72, reorder_flags: 1 },
    materials: [
      { name: 'Carbon black N330', status: 'reorder', in_transit_mt: 0, next_eta: null, days_since_last: 19 },
      { name: 'Natural rubber', status: 'ok', in_transit_mt: 48, next_eta: '2026-06-28', days_since_last: 6 },
      { name: 'Nylon cord', status: 'in_transit', in_transit_mt: 24, next_eta: '2026-07-02', days_since_last: 11 } ],
    in_transit: [{ date: '2026-06-21', material: 'Natural rubber', qty_mt: 48, eta: '2026-06-28', ref: 'NR-26-09' }] },
  stock_balance: { period: 'May 2026', source: 'Monthly Stock Balance (demo)',
    totals: { materials: 52, low_or_out: 9, closing_by_group_kg: { rubber: 412000, 'carbon black': 98000, chemicals: 61000 } },
    low_cover: [
      { material: 'Carbon black N330', closing: 4200, unit: 'kg', months_cover: 0.1, monthly_consumption: 38000, status: 'low' },
      { material: 'Bead wire', closing: 0, unit: 'kg', months_cover: 0, monthly_consumption: 9000, status: 'out' } ],
    materials: [
      { material: 'Natural rubber', group: 'rubber', closing: 412000, unit: 'kg', months_cover: 4.1, status: 'ok' },
      { material: 'Carbon black N330', group: 'carbon black', closing: 4200, unit: 'kg', months_cover: 0.1, status: 'low' } ] },
  production_fg: { source: 'Monthly Production (demo)', product_line: 'PCR / Radial', period: 'Jan–May 2026 YTD',
    totals: { produced: 318400, grade_a_pct: 98.2, grade_b_pct: 1.3, reject_pct: 0.5, off_grade_pct: 1.8, active_sizes: 41, total_weight_mt: 3120 },
    reconciliation: { headline_from: 'sheet grand-total row', reported_total: 318400, parsed_sum: 318400, reconciled: true },
    top_sizes: [ { size: '175 R 13 C', total: 22100, a: 21700, b: 300, r: 100, weight_kg: 198900 },
      { size: '155 R 12 C', total: 18800, a: 18500, b: 240, r: 60, weight_kg: 139120 } ] },
  production_mc: { source: 'Monthly Production (demo)', product_line: 'Motorcycle (MC)', period: 'Jan–May 2026 YTD',
    totals: { produced: 121700, grade_a_pct: 98.9, grade_b_pct: 0.8, reject_pct: 0.3, off_grade_pct: 1.1, active_sizes: 28, total_weight_mt: 1180 },
    reconciliation: { reported_total: 121700, parsed_sum: 121700, reconciled: true },
    top_sizes: [ { size: '2.50-17', total: 14200, a: 14050, b: 110, r: 40, weight_kg: 29400 } ] },
  retailers: { period: '6-mo', totals: { dealers: 31, total_qty: 41200, total_amount: 9800000000, est_rebate: 280000000, nylon_share_pct: 44, radial_share_pct: 56 },
    by_region: [ { key: 'Mandalay', dealers: 9, total_qty: 14200, total_amount: 3400000000 },
      { key: 'Yangon', dealers: 11, total_qty: 12100, total_amount: 2900000000 } ],
    top_dealers: [ { shop: 'Aung Tyre', township: 'Chanmyathazi', region: 'Mandalay', total_qty: 3100, total_amount: 760000000, rebate_pct: 4 } ] },
  insights: { counts: { critical: 1, high: 2, watch: 2, ok: 3 }, signals: [
    { severity: 'critical', title: 'Carbon black N330 — ~2 days to stockout', detail: 'Closing 4,200 kg vs 38,000 kg/mo consumption.' },
    { severity: 'high', title: 'Bead wire out of stock', detail: 'Reorder flag; 19 days since last inbound.' },
    { severity: 'high', title: 'June on pace for ~92% of target', detail: 'MTD 24,800 vs 27,000 target.' } ] },
  trends: { production_momentum: { direction: '▲', change_pct: 12.4, recent_avg_per_day: 1930 },
    sales_mom: { direction: '▼', change_pct: -8.1, note: 'Jun vs May', best_month: { month: 'Mar 2026', total: 2100000000 },
      series: [ { month: 'Mar', total: 2100000000 }, { month: 'Apr', total: 1850000000 }, { month: 'May', total: 1700000000 }, { month: 'Jun', total: 1560000000 } ] },
    snapshots: 3 },
  sites: { sites: [
    { name: 'Plant A', kind: 'factory', source_count: 4, produces: ['radial', 'stock balance'], galaxy: 'iStock A' },
    { name: 'Plant B', kind: 'factory', source_count: 3, produces: ['MC', 'raw stock'], galaxy: 'iStock B' },
    { name: 'Showroom', kind: 'sales', source_count: 2, produces: ['sales', 'dealer movement'], galaxy: 'iStock S' } ] },
  quality: { standards: ['ISO 9001', 'IATF 16949'], wcm_coverage: { scored: 6, total: 14 },
    oee: { oee_partial: 87, quality: 98.2 }, field_quality: { claim_dppm: 510, warranty_claims: 86, approval_pct: 81, off_grade_pct: 1.8 },
    capa: { open_ncr: 16 },
    wcm_scorecard: [ { pillar: 'Quality', kpi: 'First-pass yield', value: '98.2%', status: 'ok', iso_iatf: 'IATF 8.5' },
      { pillar: 'Logistics', kpi: 'Stock-out risk', value: '2 materials', status: 'gap', iso_iatf: 'ISO 8.1' } ] },
  finance: null,
  drive_sources: [],
};
const heavy = {
  'demo-claims.json': ops.claims.preview, 'demo-procurement.json': ops.procurement.preview, 'demo-raw-material.json': ops.raw_material.preview,
};
for (const [f, rows] of Object.entries(heavy)) fs.writeFileSync(path.join(feedDir, f), JSON.stringify({ generated_at: now, count: rows.length, rows }, null, 2) + '\n');
fs.writeFileSync(path.join(feedDir, 'demo-dashboard.json'), JSON.stringify(dashboard, null, 2) + '\n');
fs.writeFileSync(path.join(feedDir, 'demo-ops.json'), JSON.stringify(ops, null, 2) + '\n');
console.log('make-demo — wrote public/config.demo.json + feed/demo-dashboard.json + demo-ops.json (+ 3 heavy ledgers). Synthetic data only.');
