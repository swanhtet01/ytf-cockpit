#!/usr/bin/env node
// copq.mjs — Cost of Poor Quality (COPQ) for Yangon Tyre Factory.
//
// Turns quality failures into a Kyat money number that management can act on:
//   Internal failure costs (caught before shipping):
//     • Scrap / reject        — reject_qty × COGS_per_unit
//     • Downgrade / rework    — off_grade_qty × grade_discount × revenue_per_unit
//   External failure costs (caught after shipping):
//     • Warranty claims       — approved_claims × avg_claim_cost
//     • Downtime loss         — downtime_min × throughput_value_per_min (CEO/manager only)
//
// All estimates are flagged; the module upgrades to actuals wherever the data exists.
// Output: out/copq.json     Usage: node copq.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(DIR, 'out');
const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')); } catch { return null; } };

const prod   = rd('production.json');       // PCR/Radial
const prodMc = rd('production-mc.json');    // Motorcycle
const fin    = rd('finance.json');
const qual   = rd('quality.json');
const caps   = rd('manual-entries.json');   // downtime captures

const M = 1e6, B = 1e9;
const pct = (n, d) => d ? +(n / d * 100).toFixed(1) : null;
const round = (n) => Math.round(n);

// ── Unit economics (from H1 2025 P&L) ─────────────────────────────────────────
//   Revenue / COGS are H1 2025 actuals; YTD 2026 production counts are the denominator
//   → estimates labelled accordingly
let unitEconomics = null;
let dataQuality   = 'estimated';

if (fin?.pl) {
  const { revenue, cogs } = fin.pl;
  const finProd = (prod?.totals?.produced || 0);
  const finMc   = (prodMc?.totals?.produced || 0);
  const totalTyres = finProd + finMc;

  // split revenue proportionally (nylon+radial = PCR, mc = MC)
  const revPcr  = (fin.sales?.by_product?.nylon || 0) + (fin.sales?.by_product?.radial || 0);
  const revMc   = fin.sales?.by_product?.mc || 0;
  const cogsRatio = cogs / revenue;

  const pcrRevPerUnit  = finProd  > 0 ? revPcr  / finProd  : 0;
  const mcRevPerUnit   = finMc    > 0 ? revMc   / finMc    : 0;
  const pcrCogsPerUnit = pcrRevPerUnit * cogsRatio;
  const mcCogsPerUnit  = mcRevPerUnit  * cogsRatio;
  const avgRevPerUnit  = totalTyres > 0 ? (revPcr + revMc) / totalTyres : 0;
  const avgCogsPerUnit = avgRevPerUnit * cogsRatio;

  unitEconomics = {
    pcr_rev_per_unit:  round(pcrRevPerUnit),
    pcr_cogs_per_unit: round(pcrCogsPerUnit),
    mc_rev_per_unit:   round(mcRevPerUnit),
    mc_cogs_per_unit:  round(mcCogsPerUnit),
    avg_rev_per_unit:  round(avgRevPerUnit),
    avg_cogs_per_unit: round(avgCogsPerUnit),
    cogs_ratio:        +cogsRatio.toFixed(3),
    source:            fin.source || fin.period,
    note:              'H1 2025 P&L actuals used as per-unit cost basis for 2026 YTD production',
  };
}

// ── Internal failure: scrap (reject) ─────────────────────────────────────────
const pcrReject = prod?.totals?.reject ?? 0;
const pcrGradeB = prod?.totals?.grade_b ?? 0;
const mcReject  = prodMc?.totals?.reject ?? 0;
const mcGradeB  = prodMc?.totals?.grade_b ?? 0;

let scrapCost = 0, gradeBCost = 0;
let scrapNote = 'no production data';
if (unitEconomics) {
  // Scrap = full COGS lost (material + labour, no recovery value)
  scrapCost = round(
    pcrReject * unitEconomics.pcr_cogs_per_unit +
    mcReject  * unitEconomics.mc_cogs_per_unit
  );
  // Grade-B sold at an estimated 15% discount vs Grade-A → opportunity cost = 15% of revenue
  const gradeBDiscount = 0.15;
  gradeBCost = round(
    (pcrGradeB * unitEconomics.pcr_rev_per_unit +
     mcGradeB  * unitEconomics.mc_rev_per_unit) * gradeBDiscount
  );
  scrapNote = `PCR reject ${pcrReject} + MC reject ${mcReject} × COGS/unit; grade-B ${pcrGradeB + mcGradeB} × 15% revenue discount`;
}

// ── Internal failure: downtime opportunity cost ───────────────────────────────
const downRows   = (caps?.records || []).filter((r) => r.kind === 'downtime');
let downtimeMin  = 0;
for (const r of downRows) {
  const mins = Number(String((r.fields || {}).minutes || '').replace(/[^0-9.]/g, ''));
  if (Number.isFinite(mins) && mins > 0) downtimeMin += mins;
}
let downtimeCost = 0;
let downtimeNote = 'no downtime logs captured yet — log via Capture → Downtime';
if (unitEconomics && downtimeMin > 0) {
  // Throughput value per minute ≈ (daily target output × avg margin per unit) / (shift minutes)
  const dailyTarget  = 249121 / 150;            // ~1660 tyres/day across 150 planned production days
  const shiftMin     = 8 * 60 * 2;             // 2 shifts of 8h
  const marginPerUnit = unitEconomics.avg_rev_per_unit * (fin.pl.gross_margin_pct / 100);
  const valuePerMin  = (dailyTarget * marginPerUnit) / shiftMin;
  downtimeCost = round(downtimeMin * valuePerMin);
  downtimeNote = `${downtimeMin} min × ~${round(valuePerMin).toLocaleString()} Kyat/min throughput value`;
}

// ── External failure: warranty claims ─────────────────────────────────────────
const claimCount    = qual?.field_quality?.warranty_claims ?? 0;
const approvalPct   = qual?.field_quality?.approval_pct ?? 83;
const approvedCount = Math.round(claimCount * approvalPct / 100);
let claimCost = 0;
let claimNote = 'no claim data';
if (unitEconomics && claimCount > 0) {
  // Warranty cost = replacement tyre (avg rev/unit) + handling/freight estimate (20%)
  const costPerClaim = unitEconomics.avg_rev_per_unit * 1.2;
  claimCost = round(approvedCount * costPerClaim);
  claimNote = `${approvedCount} approved claims × avg ${round(costPerClaim).toLocaleString()} Kyat (rev/unit × 1.2 handling)`;
}

// ── Total COPQ ────────────────────────────────────────────────────────────────
const totalCopq = scrapCost + gradeBCost + downtimeCost + claimCost;

// Revenue for ratio
const annualRevEstimate = fin?.pl?.revenue ? fin.pl.revenue * 2 : null;  // H1 × 2 as full-year proxy
const copqPctRevenue = annualRevEstimate && totalCopq > 0
  ? +(totalCopq / annualRevEstimate * 100).toFixed(2)
  : null;
const copqPerUnit = (prod?.totals?.produced || 0) + (prodMc?.totals?.produced || 0) > 0
  ? round(totalCopq / ((prod?.totals?.produced || 0) + (prodMc?.totals?.produced || 0)))
  : null;

// Benchmark: world-class manufacturers target COPQ < 1% of revenue; 2–4% is typical industry
const benchmark = copqPctRevenue != null
  ? copqPctRevenue < 1 ? 'world_class' : copqPctRevenue < 4 ? 'typical_industry' : 'above_average_cost'
  : null;

const out = {
  generated_at: new Date().toISOString(),
  currency: 'MMK',
  period: prod?.period || 'YTD 2026',
  data_quality: dataQuality,

  total_copq:          totalCopq,
  total_copq_millions: +(totalCopq / M).toFixed(1),
  copq_pct_revenue:    copqPctRevenue,
  copq_per_unit_kyat:  copqPerUnit,
  benchmark,

  components: {
    scrap: {
      cost: scrapCost,
      cost_millions: +(scrapCost / M).toFixed(1),
      pct_of_copq: totalCopq > 0 ? pct(scrapCost, totalCopq) : null,
      pcr_reject_qty: pcrReject,
      mc_reject_qty:  mcReject,
      total_reject_qty: pcrReject + mcReject,
      note: scrapNote,
    },
    downgrade: {
      cost: gradeBCost,
      cost_millions: +(gradeBCost / M).toFixed(1),
      pct_of_copq: totalCopq > 0 ? pct(gradeBCost, totalCopq) : null,
      pcr_grade_b: pcrGradeB,
      mc_grade_b:  mcGradeB,
      total_grade_b: pcrGradeB + mcGradeB,
      discount_assumed_pct: 15,
      note: 'Grade-B sold at ~15% discount vs Grade-A — opportunity cost',
    },
    claims: {
      cost: claimCost,
      cost_millions: +(claimCost / M).toFixed(1),
      pct_of_copq: totalCopq > 0 ? pct(claimCost, totalCopq) : null,
      total_claims: claimCount,
      approved_claims: approvedCount,
      note: claimNote,
    },
    downtime: {
      cost: downtimeCost,
      cost_millions: +(downtimeCost / M).toFixed(1),
      pct_of_copq: totalCopq > 0 ? pct(downtimeCost, totalCopq) : null,
      downtime_minutes: downtimeMin,
      note: downtimeNote,
    },
  },

  unit_economics: unitEconomics,

  action_priority: [
    ...(pcrReject + mcReject > 200 ? [{ area: 'scrap', action: 'Investigate top-3 scrap sizes from Scrap Pareto — press/mould root cause + CAPA', potential_saving_millions: +((pcrReject + mcReject) * 0.3 * (unitEconomics?.avg_cogs_per_unit || 0) / M).toFixed(1) }] : []),
    ...(pcrGradeB + mcGradeB > 500 ? [{ area: 'downgrade', action: 'Reduce grade-B by improving cure cycle consistency — target 0.5% reduction', potential_saving_millions: +((pcrGradeB + mcGradeB) * 0.3 * (unitEconomics?.avg_rev_per_unit || 0) * 0.15 / M).toFixed(1) }] : []),
    ...(approvedCount > 50 ? [{ area: 'claims', action: 'Root-cause top claim product — field DPPM analysis + supplier material traceability', potential_saving_millions: +(approvedCount * 0.2 * (unitEconomics?.avg_rev_per_unit || 0) * 1.2 / M).toFixed(1) }] : []),
    ...(!downtimeMin ? [{ area: 'downtime', action: 'Start logging downtime via Capture → Downtime — visibility is the first step', potential_saving_millions: null }] : []),
  ],
};

fs.writeFileSync(path.join(outDir, 'copq.json'), JSON.stringify(out, null, 2) + '\n');
console.log('copq (Cost of Poor Quality) — done');
console.log(`  total COPQ  : ${(totalCopq / M).toFixed(1)}M MMK`);
if (copqPctRevenue) console.log(`  % of revenue: ${copqPctRevenue}% (${benchmark?.replace(/_/g, ' ')})`);
if (copqPerUnit)    console.log(`  per tyre    : ${copqPerUnit.toLocaleString()} MMK`);
console.log(`  scrap       : ${(scrapCost / M).toFixed(1)}M  downgrade: ${(gradeBCost / M).toFixed(1)}M  claims: ${(claimCost / M).toFixed(1)}M  downtime: ${(downtimeCost / M).toFixed(1)}M`);
console.log(`  -> out/copq.json`);
