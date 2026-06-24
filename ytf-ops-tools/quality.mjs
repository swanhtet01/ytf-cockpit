#!/usr/bin/env node
// quality.mjs — WCM + ISO 9001 / IATF 16949 layer for YTF, computed from the live data.
//
// Turns the operational feeds into a quality/manufacturing scorecard a tyre maker is audited on:
//   - OEE (Availability × Performance × Quality) — P & Q from our data; A needs downtime logs
//   - First-pass yield / off-grade (grade A/B/R), warranty claim rate (field DPPM)
//   - WCM pillar KPIs (Cost Deployment, Focused Improvement, Quality, Logistics, …)
//   - CAPA/NCR register from the warranty-claim ledger (IATF 8.7 / 10.2)
//   - a 5W1H digital-whiteboard schema (replaces shop-floor problem-solving boards)
// Each metric is tagged with the WCM pillar + ISO/IATF clause it supports.
//
// Output: out/quality.json     Usage: node quality.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')); } catch { return null; } };

const prod = rd('production.json');
const daily = rd('daily-production.json');
const stock = rd('stock-balance.json');
const fin = rd('finance.json');
const sum = rd('summary.json');
const insights = rd('insights.json');
const captures = rd('manual-entries.json');   // whiteboard/Viber/entry captures (incl. downtime)

// ---- downtime → Availability (from the captured downtime records: machine, minutes, planned_min) ----
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const downRows = (captures?.records || []).filter((r) => r.kind === 'downtime');
let downtimeMin = 0, plannedMin = 0;
const byMachine = {};
for (const r of downRows) {
  const f = r.fields || {};
  const dm = num(f.minutes), pm = num(f.planned_min);
  downtimeMin += dm; plannedMin += pm;
  const m = (f.machine || 'unspecified').toString();
  byMachine[m] = (byMachine[m] || 0) + dm;
}
const topDowntime = Object.entries(byMachine).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([machine, minutes]) => ({ machine, minutes }));

const pct = (n) => (n == null ? null : +Number(n).toFixed(1));

// ---- OEE (A × P × Q) ----
const performance = daily?.mtd?.attainment_pct ?? null;               // output vs target
const quality = prod?.totals?.grade_a_pct ?? daily?.mtd?.grade_a_pct ?? null; // first-pass / grade-A
// Availability = run time / planned time, from captured downtime logs (null until logs exist)
const availability = plannedMin > 0 ? pct(100 * Math.max(0, plannedMin - downtimeMin) / plannedMin) : null;
const oee_partial = (performance != null && quality != null) ? pct((performance / 100) * (quality / 100) * 100) : null;
// full OEE once all three are present
const oee_full = (availability != null && performance != null && quality != null)
  ? pct((availability / 100) * (performance / 100) * (quality / 100) * 100) : null;

// ---- warranty / field quality ----
const claimsTotal = sum?.claims?.total ?? 0;
const approval = sum?.claims?.approval_rate_pct ?? null;
const producedYtd = prod?.totals?.produced ?? 0;
const claim_dppm = producedYtd ? Math.round((claimsTotal / producedYtd) * 1e6) : null; // indicative field-defect rate
const offGrade = prod?.totals?.off_grade_pct ?? daily?.mtd?.off_grade_pct ?? null;

// ---- WCM pillar scorecard (computed where data exists; else flagged to instrument) ----
const k = (pillar, kpi, value, status, source, clause) => ({ pillar, kpi, value, status, source, iso_iatf: clause });
const wcm = [
  k('Safety', 'Recordable incidents', 'instrument', 'gap', 'needs incident log', 'ISO 45001 / IATF 6.1'),
  k('Cost Deployment', 'Gross margin', fin?.pl?.gross_margin_pct != null ? fin.pl.gross_margin_pct + '%' : '—', fin?.pl ? 'ok' : 'gap', 'P&L (finance.mjs)', 'IATF 9.1.3'),
  k('Cost Deployment', 'Net margin', fin?.pl?.net_margin_pct != null ? fin.pl.net_margin_pct + '%' : '—', fin?.pl ? 'ok' : 'gap', 'P&L', 'IATF 9.1.3'),
  k('Focused Improvement', 'Production attainment (vs target)', performance != null ? performance + '%' : '—', performance >= 95 ? 'ok' : performance != null ? 'watch' : 'gap', 'daily-production.mjs', 'IATF 9.1.1'),
  k('Quality Control', 'First-pass yield (grade-A)', quality != null ? quality + '%' : '—', quality >= 98 ? 'ok' : 'watch', 'production.mjs', 'IATF 8.6 / 9.1'),
  k('Quality Control', 'Off-grade (scrap) rate', offGrade != null ? offGrade + '%' : '—', offGrade != null && offGrade <= 2 ? 'ok' : 'watch', 'production grade B+R', 'IATF 8.7'),
  k('Quality Control', 'Warranty claim rate (field)', claim_dppm != null ? claim_dppm.toLocaleString() + ' DPPM' : '—', 'watch', `${claimsTotal} claims / ${producedYtd.toLocaleString()} produced`, 'IATF 10.2 / 8.7'),
  k('Quality Control', 'Claim approval rate', approval != null ? approval + '%' : '—', 'ok', 'claims ledger (Gmail)', 'IATF 9.1.2 (customer)'),
  k('Logistics & Cust. Service', 'Min raw-material cover', stock?.low_cover?.[0] ? `${stock.low_cover[0].material.trim()} ${stock.low_cover[0].months_cover}mo` : '—', stock?.totals?.low_or_out ? 'watch' : 'ok', 'stock-balance.mjs', 'IATF 8.5.4'),
  k('Logistics & Cust. Service', 'Materials low/out of stock', stock?.totals?.low_or_out != null ? String(stock.totals.low_or_out) : '—', stock?.totals?.low_or_out > 5 ? 'watch' : 'ok', 'stock-balance.mjs', 'IATF 8.5.4'),
  k('Autonomous / Pro Maintenance', 'Maintenance events (logged)', sum?.categories?.maintenance != null ? String(sum.categories.maintenance) : 'instrument', sum?.categories?.maintenance ? 'ok' : 'gap', 'maintenance emails', 'IATF 8.5.1.5 (TPM)'),
  k('Environment', 'Diesel/energy tracking', (stock?.materials || []).some((m) => /diesel|fuel/i.test(m.material)) ? 'tracked' : 'instrument', 'watch', 'stock-balance (Premium Diesel)', 'ISO 14001'),
  k('People Development', 'Headcount / training', 'instrument', 'gap', 'HR employee file (Drive)', 'IATF 7.2'),
  k('Early Equipment Mgmt', 'Capex / new-line readiness', 'instrument', 'gap', 'project tracker (future)', 'IATF 8.3'),
];

const scored = wcm.filter((x) => x.status === 'ok').length;
const gaps = wcm.filter((x) => x.status === 'gap').length;

// ---- CAPA / NCR register (from warranty claims) ----
const byStatus = sum?.claims?.by_status || {};
const capa = {
  open_ncr: (byStatus.rejected || 0) + (byStatus.partial || 0), // need customer disposition / CAPA
  approved_disposition: byStatus.approved || 0,                  // DO issued
  register_source: 'warranty claim ledger (#YGN-R/B/T###) — the IATF customer-complaint register',
  note: 'Each rejected/partial claim → 8D/5-Why CAPA; approved → delivery-order (DO). Drives IATF 10.2.',
};

// ---- 5W1H digital whiteboard schema (replaces shop-floor problem-solving boards) ----
const whiteboard_5w1h = {
  purpose: 'Digitize shop-floor SQDC / 5W1H / Kaizen boards into structured CAPA records (capture by form or photo→OCR).',
  schema: { id: '', date: '', site: 'factory-a|factory-b', area: '', board: 'SQDC|5W1H|Kaizen|NCR',
    what: '', why: '', where: '', when: '', who: '', how: '', root_cause_5why: ['', '', '', '', ''],
    countermeasure: '', owner: '', due: '', status: 'open|in-progress|verified|closed', iso_clause: '' },
  captured: [], // populated when boards are captured
};

const out = {
  generated_at: new Date().toISOString(),
  standards: ['ISO 9001 (QMS)', 'IATF 16949 (automotive QMS)', 'ISO 14001 (environment)', 'ISO 45001 (OH&S)'],
  oee: { availability, performance, quality, oee_partial, oee_full,
    basis: availability != null ? 'A×P×Q from captured downtime + production' : 'A needs downtime logs (capture via Data entry → Downtime); shown = Performance × Quality only',
    downtime: { total_minutes: downtimeMin, planned_minutes: plannedMin, logs: downRows.length, by_machine: topDowntime } },
  field_quality: { warranty_claims: claimsTotal, approval_pct: approval, claim_dppm, off_grade_pct: offGrade },
  wcm_scorecard: wcm,
  wcm_coverage: { scored, gaps, total: wcm.length },
  capa,
  whiteboard_5w1h,
};
fs.writeFileSync(path.join(outDir, 'quality.json'), JSON.stringify(out, null, 2) + '\n');

console.log('quality (WCM/ISO/IATF) — done');
console.log('  OEE        :', oee_full != null ? oee_full + '% (A×P×Q)' : (oee_partial != null ? oee_partial + '% (P×Q)' : '—'), `· avail ${availability != null ? availability + '%' : 'no downtime logs'} (${downRows.length} logs, ${downtimeMin}/${plannedMin} min)`);
console.log('  field qual :', `${claimsTotal} claims · ${approval}% approval · ~${claim_dppm} DPPM · off-grade ${offGrade}%`);
console.log('  WCM score  :', `${scored}/${wcm.length} pillars instrumented, ${gaps} gaps to instrument`);
console.log('  CAPA/NCR   :', capa.open_ncr, 'open (rejected/partial claims)');
console.log('  ->', path.join('out', 'quality.json'));
