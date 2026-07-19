# Tyre-manufacturing features for Yangon Tyre, grounded in the data we parse

## What the data actually gives us (grounding)

I read all six modules plus the live `out/*.json`. The parsed data is richer than the one-line summary — three facts unlock most tyre-specific features:

1. **Size strings are structured spec, not free text.** `production.json#top_sizes[].size` carries: construction (`R` = radial vs `-` = bias/diagonal), rim diameter (12/13/14/15/17), section width / aspect ratio (`185/70`), ply-rating (`6-PR`), application tag (`Premier Taxi`), and **mould-pattern code** (`YT-123`, `YT-312`). All recoverable with one regex.
2. **The compound BOM ingredients are already itemized** in `stock-balance.json#materials` (86 lines) with `opening/received/consumption/closing/monthly_consumption` each: rubbers (RSS-1, MSR-20, SBR-1502/1712, KBR/BR-150, reclaim, butyl/CIIR, chloroprene), carbon black N220/N330/N660, zinc oxide, sulphur, accelerators (TBBS, MBTS/DM, PVI), antidegradants (6PPD, TMQ, anti-ozone wax), oils, resins, **bead wire (2 gauges), steel cord (3 specs), nylon/polyester cord (multiple deniers)**, and — critically — **curing bladders itemized by press/size** (`MC Bladder 17/7.21`, `Bladder RB-1951`, `RB-1451 (12")`, `B35010`), plus mould cleaning sand and internal release agent.
3. **Per-day target vs actual exists** (`daily-production.json#by_day`), and the daily parser now emits **per-size-per-day** rows (`daily-production.json#by_day_size`) plus current-month size totals (`daily-production.json#by_size`). This is the freshest production drill-through signal when the Drive refresh has a current workbook.

Below, ranked by value/effort. "Have" = computable today from existing JSON; "almost" = one parser tweak or a small static lookup; "missing" = needs a new feed.

---

### Tier 1 — High value, low effort (ship first; uses data we already have)

**1. Compound/BOM material-consumption forecasting (recipe-aware days-to-stockout)**
- **Data:** HAVE. `stock-balance.json` gives per-material `monthly_consumption` + `closing`; `production.json`/`daily-production.json` give tyre output. Today `insights.mjs` lines 33-61 already does generic days-to-stockout. The tyre-specific upgrade: divide each ingredient's monthly consumption by tyres produced to derive an **empirical kg-per-tyre coefficient** (a back-calculated BOM), then forecast burn off the production *plan/pace* (`daily.mtd.attainment_pct`, already used as `paceFactor` on line 36).
- **Cockpit module:** "Compound cockpit" — per-ingredient kg/tyre, and "at planned June output you run out of Carbon N-330 in ~7 days" (N-330 is already at 0.2mo cover, the tightest core input).
- **Decision:** purchasing knows *which* material to expedite and *how much*, tied to the build plan — not a flat reorder point.

**2. Scrap/reject Pareto by size + mould pattern (B+R bridge)**
- **Data:** HAVE. `production.json#top_sizes[]` has per-size `b` and `r`; parse the `YT-xxx` mould code out of the size string. Off-grade % per size = `(b+r)/total`.
- **Cockpit module:** ranked Pareto — "worst off-grade: 185/70 R14 Premier Taxi at 2.1% (B+R), vs 1.2% plant avg." Group by mould code to expose a bad cavity/pattern.
- **Decision:** which size/mould to pull for inspection or mould refurbishment first. Directly feeds the `quality.mjs` IATF 8.7 off-grade KPI, which is currently plant-level only.

**3. Tyre-cord, bead-wire & carbon-black price/FX exposure**
- **Data:** HAVE/ALMOST. `stock-balance.json` gives monthly kg of carbon black (3 grades), steel cord (3 specs), bead wire (2 gauges), nylon/polyester cord. `inventory.mjs` already pulls supplier shipments (KIIC China) with tonnage and ETA. Missing only a unit-price column (almost — procurement emails carry PI prices; `extract.mjs` already reads them).
- **Cockpit module:** "raw-material cost exposure" — kg/mo × last-known $/kg per commodity, with a "1% NR/CB price move = X MMK/month" sensitivity, layered on `finance.json` COGS.
- **Decision:** when to forward-buy carbon black or natural rubber; quantifies the single biggest COGS lever for a tyre plant.

**4. Energy / diesel per tyre (WCM Environment + Cost)**
- **Data:** HAVE. `stock-balance.json` has `Premium Diesel` (14,254 gal/mo), `Heptane`, engine/gear oils; production gives tyres/mo. `quality.mjs` line 58 already flags diesel as "tracked" for ISO 14001 but computes nothing.
- **Cockpit module:** gal-diesel-per-tyre and per-MT-of-tyre trend, with month-over-month delta.
- **Decision:** detect curing/boiler efficiency drift; feeds the WCM Cost Deployment + Environment pillars that are currently "instrument/gap."

---

### Tier 2 — High value, medium effort (one parser change each)

**5. Green-tyre → cured yield & curing/press throughput**
- **Data:** ALMOST. Daily output is the *cured* count (`daily-production.mjs` maps grade-A off the "Curing" column — line 60). The missing half is green-tyre/building count. If the daily report has a building/extrusion column (likely, given it already has Curing), one parser change gives **building→curing yield** and WIP. Bladder consumption per press (`MC Bladder 17/7.21` etc. in stock-balance) is a proxy for cures per mould already.
- **Cockpit module:** "press & curing" — green vs cured, scrap-at-cure, WIP between stages.
- **Decision:** is the bottleneck building or curing; where WIP is piling up.

**6. Press/mould utilization + OEE-by-line (close the Availability gap)**
- **Data:** ALMOST→MISSING. `quality.mjs` line 34 explicitly leaves **Availability = null** ("needs machine downtime logs") so OEE is only P×Q today. We can derive a **demonstrated capacity per size/mould** from the daily target rows (target = scheduled press-hours proxy) and compare to actual; true Availability still needs a downtime log (missing). Mould inventory is inferable from the distinct `YT-xxx` codes + bladder line-items.
- **Cockpit module:** per-mould attainment heatmap; full OEE once a downtime feed (even a one-line WhatsApp "Press 4 down 3h") is added.
- **Decision:** which press/mould is the constraint; justifies the single missing feed (downtime log) with a clear payoff.

**7. Mould/size scheduling & changeover optimizer**
- **Data:** HAVE (inputs). Demand mix from `retailers.json` + recent `top_sizes`; current run rates from daily; mould availability from distinct mould codes + bladder stock (`stock-balance`).
- **Cockpit module:** suggested next-run sequence that minimizes mould changeovers while covering the top-selling sizes and respecting bladder stock (e.g. don't schedule a 17" MC run when `MC Bladder 17/7.21` is at 0.3mo).
- **Decision:** the daily/weekly production-planning sequence — ties product mix, mould, and consumable availability together.

**8. Per-size daily trend (now emitted by the daily parser)**
- **Data:** HAVE. `daily-production.mjs` emits `by_day_size` and `by_size`, so the ERP can show current-month output by plant/line/size, target attainment, grade-A %, and off-grade without waiting for the month-close production workbook.
- **Cockpit module:** size-level run-rate sparklines feeding features 2, 6, 7.
- **Decision:** spot a size whose reject rate is climbing mid-month, not at month-close.

---

### Tier 3 — High value, higher effort (needs a new feed; flag as roadmap)

**9. DOT / week-year code & finished-goods age tracking**
- **Data:** MISSING (a finished-goods/dispatch feed with DOT week codes). Production gives counts, not per-tyre DOT stamps. Relevant for a tyre maker (DOT age, FIFO, recall traceability per IATF 8.5.2), but no current feed carries it.
- **Decision:** FIFO dispatch, age-out alerts, recall scoping. Roadmap, not near-term.

**10. Retreading / reclaim loop economics**
- **Data:** ALMOST. `stock-balance.json` already tracks `Reclaim Rubber` (9,138 kg/mo) and curing resins, and `quality.mjs` tracks grade-R rejects. A retread line would need its own throughput feed (missing), but the reclaim-rubber substitution rate vs virgin NR/SBR is computable today as a cost lever.
- **Cockpit module:** reclaim-substitution % and its COGS saving.
- **Decision:** how hard to push reclaim into the compound without hurting grade-A — a margin lever using data we have.

---

### Note on honesty (matches the codebase's existing discipline)
Every module already reconciles parsed vs reported and tags gaps ("instrument"/"gap"). Features 1-4 and 8 fit that bar today. Features 5-7 should ship with the same explicit "Availability needs a downtime feed" caveat `quality.mjs` already uses, rather than fabricating OEE. The back-calculated BOM (feature 1) is an *empirical* coefficient — label it as derived-from-actuals, not an engineering recipe, so it stays honest.

## Next build steps
- Add a size-string parser (one shared helper) that extracts construction R/bias, rim diameter, aspect ratio, ply-rating, and YT-xxx mould code from production.json#top_sizes[].size — this unlocks features 2, 6, 7
- Build the scrap/reject Pareto by size+mould (feature 2) directly from production.json b/r fields and feed it into quality.mjs's IATF 8.7 off-grade KPI which is currently plant-level only
- Add empirical kg-per-tyre BOM coefficients (stock-balance monthly_consumption / production produced) and forecast ingredient burn off daily.mtd pace — extends the existing days-to-stockout logic in insights.mjs lines 33-61
- Use `daily-production.json#by_size` and `#by_day_size` in the ERP for size-level daily attainment, grade mix, and off-grade drill-through
- Compute diesel/heptane-per-tyre in quality.mjs (line 58 already flags diesel as 'tracked' but computes nothing) to fill the WCM Environment + Cost Deployment pillars
- Add a unit-price field to inventory.mjs shipment extraction (PI prices are in the procurement emails extract.mjs already reads) to enable the carbon-black / NR / cord cost-exposure module against finance.json COGS
