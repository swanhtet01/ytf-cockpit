# SuperMega Ops — roadmap (focus: Yangon Tyre)

**Highest-leverage next:** Ship per-request roles + audit on control.js first (one file unlocks multi-tenant safety and metering); then the tyre size-string parser, which is the keystone for 4 manufacturing features off data we already parse.

## Now
- HIGHEST-LEVERAGE BUILD — Roles + audit in supermega-remote/api/control.js: replace the single PANEL_TOKEN check (lines 144-150) with a PANEL_USERS env map (role:token;...), keep PANEL_TOKEN as owner fallback, resolve `role` via timingSafeEqual (line 67) over all entries; add a server-side role->JOB_META[job].group table and gate the `run` branch (line 186) returning 403 (operator blocked from `agents`/supermega-* groups). This is the gate everything else layers on.
- Add append-only audit in control.js at the run-result build site (line 206) and on unlock/401 (line 148), writing {ts, role, action, job, status, ip_hash} to Vercel KV/Blob or structured console.log — the same write path doubles as the per-FEED_PREFIX usage counters (runs, data reads) that become the billing/metering substrate.
- Add the shared tyre size-string parser (one helper, e.g. ytf-ops-tools/lib/tyre-size.mjs) that extracts construction (R vs bias `-`), rim diameter, aspect ratio, ply-rating `(6-PR)`, and YT-xxx mould code from production.json top_sizes[].size like "2.75-17 (YT-123)" / "145 R 12 C (6-PR)" — this single helper unlocks the scrap Pareto, BOM coefficients, and size-level series below.

## Next
- Add `action==='whoami'` to control.js and return role+allowed groups in the `jobs` response (line 169) so index.html loadJobs() (line 277/433) hides job cards and ops.html sections the role can't use, layered on the existing MOD() toggles.
- Build the scrap/reject Pareto by size+mould (use the new parser over production.json a/b/r fields) and feed it into quality.mjs's IATF 8.7 off-grade KPI (line 52), which is currently plant-level only — turns one flat number into a ranked defect register.
- Persist the per-size daily rows in daily-production.mjs (currently parsed in dayTotal() then discarded at lines 68-82, only the grand-total row survives) to produce a size-level daily attainment/off-grade series.
- Add write helpers to ytf-ops-tools/lib/connectors.mjs (addConnector / setStatus / resolveDriveFileId) so connectors.json stops being hand-edited — the prerequisite for any self-serve setup, then add a `setup` action to control.js (or new api/setup.js) that connects a source, runs the existing supermega-remote/refresh.mjs, and returns a live preview before deploy.
- Add empirical kg-per-tyre BOM coefficients (stock-balance monthly_consumption / production produced) and forecast ingredient burn off daily.mtd pace — extends the days-to-stockout logic in insights.mjs lines 33-61 from reactive to predictive.

## Later
- Introduce SESSION_SECRET + HMAC-signed short-lived session tokens issued on unlock; change index.html tryUnlock() (line 256) to store the session token / httpOnly cookie instead of the raw passcode (currently localStorage.setItem(LS_KEY, tok) at line 267), and stamp author/role onto entry.html records at save (lines 181-185) via a token-gated `action==='entry'` POST through the same gate.
- Build supermega-remote/public/setup.html as a 5-step wizard reusing admin.html buildConfig() (line 107) + the module chips, adding connect-sources / preview / deploy steps.
- Stand up a separate supermega-ops-console project: generalize admin.html loadHealth() (line 127) to list all tenants with per-tenant control.js status pills, modules-on/total, and feed freshness vs SLA.
- Add a unit_price field to inventory.mjs shipment objects (currently only qty_mt, lines 106-119; PI prices live in the procurement emails extract.mjs already reads) to enable a carbon-black / NR / cord cost-exposure module against finance.json COGS; and compute diesel/heptane-per-tyre in quality.mjs (line 58 flags diesel 'tracked' but computes nothing) to fill the WCM Environment + Cost Deployment pillars.
- Wire Stripe (stripe MCP) per-tenant subscriptions to PRODUCT.md tiers, mapping customer->FEED_PREFIX and enforcing quota on the `run` action using the usage counters from the audit substrate; package the owner-brief job (control.js JOBS, line 41) as a scheduled PDF/Excel + share-link export.
- Publish the phone-guide onboarding (ops.supermega.dev passcode + Add to Home Screen, morning ⚠️ alert routine, entry.html CSV/JSON handoff, admin `cd supermega-remote; .\sync.ps1` Drive-pull) as in-app first-run help once roles ship, so each role sees only its relevant steps.
