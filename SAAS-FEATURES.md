# SuperMega Ops — SaaS-Killer Feature Set, Self-Serve Setup Wizard, and Meta/Admin Console (repo-grounded)

## What it already is (the foundation, grounded)

The cockpit is a **config-driven, per-tenant white-label shell** with a real messy-data pipeline behind it. The pieces that make it a product (not a YTF one-off) already exist:

- **White-label config** — `supermega-remote/new-client.mjs` and `public/admin.html` both emit the same `public/config.json` shape (`brand`, `accent`, `monogram`, `feed_prefix`, 17 `modules.*` toggles). UI reads it at runtime (`index.html`/`ops.html`), so rebrand = no code change. `TEMPLATE.md` documents the generic-shell-vs-vertical split.
- **Token-gated private feed** — `api/control.js` is the entire backend: one Vercel function, `PANEL_TOKEN`-gated, with a `FEED_PREFIX`-namespaced allowlist (`DATA_FILES = prefix × DATA_SUFFIXES`) so no arbitrary file reads. Per-tenant isolation = own Vercel project + own gated `feed/` + own passcode (`PRODUCT.md` §1).
- **Connectors hub** — `ytf-ops-tools/connectors.json` is the source registry (drive ✓, gmail ✓, viber/galaxy planned) and `lib/connectors.mjs` already exposes `loadConnectors/byType/pullableDrive/summarize`. This is the declared moat (`PRODUCT.md` §2.1).
- **Deterministic pipeline** — `refresh.mjs` → `pipeline.mjs` turns ledgers into `<prefix>-dashboard.json` + `<prefix>-ops.json` + lazy heavy ledgers. No AI keys, no per-client API cost, no data leaving the tenant (the "no-AI privacy" posture in `TEMPLATE.md` line 40 / `PRODUCT.md` §5).
- **Demo generator** — `make-demo.mjs` proves a tenant can stand up on synthetic data (Northwind Tyres).

The gaps the docs themselves call out (`PRODUCT.md` §2): Connectors hub → Orders/receivables → **Admin/multi-tenant console**. The current `admin.html` is single-tenant (it reads `localStorage.sm_remote_token` and one `config.json`). The product needs a *meta* layer above it.

---

## Why it's a category-killer for SMB ops in Myanmar/SEA

| Dimension | ERP (SAP B1, Odoo, Galaxy) | Spreadsheets + email/Viber | **SuperMega Ops** |
|---|---|---|---|
| Time-to-value | 3–12 mo migration | instant but no live view | **1 day** — `new-client.mjs` → point at Drive/Gmail → deploy |
| Data source | rip-and-replace; rekey everything | the source of truth, but blind | **reads what they already use** (Drive xlsx, Gmail, Galaxy iStock export) — sits *on top* |
| Messy data | rejects it; needs clean masters | is the mess | **eats the mess** — merged cells, multi-table sheets, reconciliation (`stock-balance.mjs`, `production.mjs` reconcile parsed-sum vs sheet grand-total) |
| Privacy | cloud tenant, your data on their servers | local but unshareable | **no-AI, deterministic, per-tenant gated feed** — nothing leaves the tenant, no API cost |
| Mobile | clunky portal | none | **PWA cockpit on the owner's phone**, stockout alerts first |
| Cost to run/sell | seat licenses + integrator | free | **flat per-tenant**; integrator can resell the scaffold |

The wedge (`PRODUCT.md` §1): SMB manufacturers/distributors/retailers who *have* the data in sheets + email/Viber but have no current, mobile, secure view of their operation. ERP is too heavy; this is the 1-day layer on top.

---

## The 5–7 features that win deals (prioritized)

1. **Messy-data pipeline that reconciles** — the demo-able "magic": drop their real workbooks, get back stock-on-hand + months-of-cover, production by line/grade with a reconciliation flag (parsed sum vs the sheet's grand-total row), P&L. This is what spreadsheets and ERP both fail at. (`stock-balance.mjs`, `production.mjs`, `finance.mjs`, `pipeline.mjs` headline.)
2. **Days-to-stockout / reorder alerts as the headline** — cross-module `insights.mjs` signals ("Carbon black N330 — ~2 days to stockout") surfaced *first* in `pipeline.mjs` alerts. The single thing an owner forwards. This is the recurring "why I open it daily" hook.
3. **No-AI universal search + per-table filters** — searches inventory/orders/claims/stock across the normalized feed with zero API cost or data egress (`TEMPLATE.md` generic shell). The privacy story that beats every cloud-AI competitor in Myanmar.
4. **1-day white-label setup** — `new-client.mjs` + the admin generator already produce a deployable tenant config; the wizard below closes the last mile. Per-tenant brand/accent/monogram/modules with no code change.
5. **Connectors hub (the moat)** — `connectors.json` + `lib/connectors.mjs`. Each new customer's odd source = one registry entry (+ thin adapter), UI unchanged. Galaxy iStock + Viber bridge are the two that unlock SEA distributors.
6. **Owner Brief / scheduled export** — `api/control.js` already wires an `owner-brief` job; package it as a scheduled PDF/Excel + share link (the thing owners forward). `PRODUCT.md` §2.5 lists it as a gap — it's the retention feature.
7. **WCM + ISO/IATF quality board** — `quality.mjs` scorecard, gated behind `EXPOSE_QUALITY_WCM`. The compliance/audit-evidence angle that justifies a higher tier for manufacturers.

Deal-winners in a demo, ranked: **#1 and #2** close the meeting; **#3 (privacy)** removes the cloud objection; **#4** removes the "how long / how much disruption" objection.

---

## The self-serve SETUP wizard (beyond `new-client.mjs`)

`new-client.mjs` writes config and prints a manual deploy checklist; the admin page generates the JSON. Neither **connects sources, runs the pipeline, or deploys.** The wizard turns that checklist into 5 guided steps, each backed by a real artifact already in the repo:

1. **Brand** — name/accent/monogram → `config.json`. (Reuse `admin.html` `buildConfig()` + `new-client.mjs` logic verbatim.)
2. **Pick modules** — the 17 `ALL_MODULES` chips already in `new-client.mjs`/`admin.html`. Toggle off what the client doesn't have.
3. **Connect sources** — the new piece. A UI over `connectors.json`: "Share this Drive folder with `<service-account-email>`, paste file links" → resolves `fileId` (the `finance-pl` entry shows the failure mode to guard: an `unshared` status when the SA can't reach a personal-Drive file). Gmail = OAuth/connector query string. Galaxy/Viber = upload-export / bridge stubs. Writes entries via `lib/connectors.mjs`.
4. **Preview** — run `refresh.mjs` against the just-connected sources (or `make-demo.mjs`-style synthetic if none yet) and **show the cockpit live before deploy**. Surface per-connector `status` (live/unshared/planned) and the reconciliation result so the operator sees parse failures immediately.
5. **Deploy & hand over** — automate steps 4–6 of `new-client.mjs`'s printout: create the Vercel project, set `PANEL_TOKEN`/`FEED_PREFIX`/`GOOGLE_SA_KEY`, deploy, alias `<prefix>.supermega.dev`. Output the cockpit URL + passcode card.

Key gap to build: `connectors.json` is currently hand-edited. The wizard needs **write** helpers in `lib/connectors.mjs` (`addConnector`, `setStatus`, `resolveDriveFileId`) and a `setup` action in `api/control.js` (or a separate `api/setup.js`) so it's self-serve, not operator-only.

---

## Meta / Admin tools (the multi-tenant console — the real new build)

Today `api/control.js` and `admin.html` are **single-tenant** (one `FEED_PREFIX`, one `PANEL_TOKEN`, one `LIVE_APP_BASE`). The meta layer is a console that sits *above* tenants. Build it as a `supermega-ops-console` project with its own master token:

- **Tenant console** — list every tenant (prefix, brand, Vercel project, alias, modules-on/total, passcode rotation, last-refresh). The data already exists per-tenant in `config.json` (`brand`/`feed_prefix`/`modules`) and `dashboard.generated_at`; the console aggregates across them. The current `admin.html` `loadHealth()` already renders one tenant's tile (brand · prefix · N/total modules · feed generated time) — generalize it to a list.
- **Health board** — reuse `api/control.js` `action=status` + `normalizeStatus()` per tenant (reachable, db_ready, coverage_score, backend_ready, autopilot/review). One screen, all tenants, red/amber/green pills (the pill CSS already in `admin.html`).
- **Job runner / freshness** — the `JOBS`/`JOB_META` map in `control.js` (full-refresh, owner-brief, agent-queue, etc.) exposed per tenant with last-run time and "stale feed" flags (compare `dashboard.generated_at` to a per-tenant SLA). This is the ops view that keeps 20 tenants refreshed.
- **Usage metering** — instrument `api/control.js` (every `action=data`/`run` call is the natural meter point) to emit per-tenant counters: feed reads, job runs, refresh count, data volume (feed byte size), active days. Today there is **no metering** — add a lightweight append-only log (KV/Blob) keyed by `FEED_PREFIX`. This is the billing substrate.
- **Billing hooks** — Stripe per-tenant subscription matching `PRODUCT.md` §5 tiers (setup one-time + monthly by #modules/#sites/data volume). Map a Stripe customer → tenant prefix; usage meter → tier enforcement (e.g. disable `run` past quota). A `stripe` MCP is available for the integration.
- **Connector registry view** — render `connectors.json` per tenant via `lib/connectors.mjs summarize()` (it already returns `{type:{total,live}}`); flag `unshared`/`planned` connectors that need attention (the `finance-pl` 404 case).
- **Audit + passcode rotation** — rotate `PANEL_TOKEN` per tenant from one place (the `<prefix>-<10hex>` format in `new-client.mjs` line 52), with an audit trail of who triggered which job.

---

## Onboarding (the sales-to-live motion)

1. **Demo-first** — point the prospect at `demo.supermega.dev` (Northwind Tyres, `make-demo.mjs`) so they see their own shape of operation before sharing data. Never expose a real tenant feed (`PRODUCT.md` §4).
2. **Data drop** — they share a Drive folder with the service account (or hand over a Galaxy iStock / xlsx export). The wizard step-3 resolves it into `connectors.json`.
3. **Same-day preview** — run `refresh.mjs`, show the live cockpit on their phone in the meeting. Reconciliation flags tell them their own sheets are trustworthy (or not) — that moment sells the messy-data moat.
4. **Deploy + hand over** — passcode card + PWA install. Subscription starts; usage meter begins.
5. **Retention loop** — scheduled Owner Brief (PDF/share link) lands in the owner's inbox/Viber on a cadence; the console watches feed freshness so it never goes stale.

---

## Build order (prioritized, file-grounded)

1. **Connector write-layer** — extend `lib/connectors.mjs` (add/update/resolve) + a `setup` action in `api/control.js`. Unblocks self-serve setup; without it the wizard is cosmetic.
2. **Setup wizard UI** — new `public/setup.html`, reusing `admin.html`'s `buildConfig()` and module chips, adding the connect-sources + live-preview + deploy steps.
3. **Multi-tenant console** — new `supermega-ops-console` project: aggregate `status`/config/freshness across tenants (generalize `admin.html loadHealth()`).
4. **Usage metering** — append-only counter in `api/control.js` per `FEED_PREFIX`; the billing substrate.
5. **Stripe billing hooks** — subscriptions + quota enforcement tied to the meter (Stripe MCP).
6. **Owner Brief packaging** — wire the existing `owner-brief` job to a scheduled PDF/share-link export.

## Next build steps
- Add write helpers to ytf-ops-tools/lib/connectors.mjs (addConnector/setStatus/resolveDriveFileId) so connectors.json stops being hand-edited — the prerequisite for self-serve setup.
- Add a `setup` action to supermega-remote/api/control.js (or a new api/setup.js) that connects a source, runs refresh.mjs, and returns a live preview before deploy.
- Build supermega-remote/public/setup.html as a 5-step wizard reusing admin.html buildConfig() + the 17 ALL_MODULES chips, adding connect-sources / preview / deploy steps.
- Stand up a separate supermega-ops-console project: generalize admin.html loadHealth() to list all tenants with per-tenant api/control.js status pills, modules-on/total, and feed freshness vs SLA.
- Instrument api/control.js to emit per-FEED_PREFIX usage counters (data reads, job runs, feed byte size) to KV/Blob — the metering substrate for billing.
- Wire Stripe (via the stripe MCP) per-tenant subscriptions matching PRODUCT.md §5 tiers, mapping customer→prefix and enforcing quota on the `run` action.
- Package the existing owner-brief job (control.js JOBS) as a scheduled PDF/Excel + share-link export — the retention feature owners forward.
