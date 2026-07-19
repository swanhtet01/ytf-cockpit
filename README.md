# SuperMega Remote

A phone-installable **operations cockpit** + control panel for a structured-data pipeline
(first instance: the live **supermega-ytf** app / Yangon Tyre). Deploys as its own Vercel project,
so it never collides with the main app's deploys. It is also a **white-label template** — see
`TEMPLATE.md`.

```
your phone  ──>  supermega-remote (this project)  ──>  supermega-ytf (live app)
  panel token        proxy holds the cron secret         /api/health, /api/cron/ytf/*
                     + serves the private feed/ data
```

## What it does

- **Live status** — reads the live app's `/api/health` (via the proxy): database readiness, backend
  mode, intake status, autopilot, data-coverage score. Auto-refreshes every 30s.
- **Remote pipeline control** — one-tap triggers for the live crons (full refresh, source records,
  workbook extraction, operating metrics, owner brief, …) using the cron secret, which lives only on
  the server side.
- **Ops cockpit** — the **Ops card** (headline tiles + alerts) and **`/ops.html`** (the full
  structured detail view: intelligence, trends, sites, financials, production MTD, finished goods,
  inventory, stock-on-hand, distribution, claims, procurement, raw-materials, quality/WCM, sources).
- **Universal search** — a **no-AI, no-key** client-side search bar over the gated feed (materials,
  claims, procurement, dealers, sizes, signals, sources, finance). No LLM, no API key.
- **Data entry / whiteboard** — `/entry.html`: capture claims, production, sales, 5W1H/CAPA,
  downtime→OEE, safety incidents on the device; export CSV/JSON to merge back via `node refresh.mjs`.
- **Manager form ingestion** — `manager-forms.mjs` reads the live `manager-forms` Drive workbook
  during refresh, promotes only current operational rows into captures, and excludes HR/contact/admin sheets.
- **Installable** — "Add to Home Screen" gives a full-screen PWA.

## Structured data (the Ops layer)

The panel doesn't just *trigger* the pipeline — it also *reads* what the pipeline knows.

- **`../ytf-ops-tools/`** turns the live Gmail inbox + Google Drive workbooks into structured ledgers
  (warranty claims, TFT procurement, raw-material shipments, production reports, contacts) plus
  inventory, stock-balance, finished-goods production, finance, retailers, intelligence, trends,
  sites, and quality — see its README and `lib/xlsx-lite.mjs` (dependency-free `.xlsx` reader).
- **`pipeline.mjs`** (here) assembles those into the panel's feed:
  - `feed/<prefix>-dashboard.json` — compact headline + operational alerts (the **Ops** card).
  - `feed/<prefix>-ops.json` — the trimmed full payload behind **`/ops.html`** (heavy ledgers split
    into `<prefix>-claims/procurement/raw-material.json`, lazy-loaded on "Show all").
  - `<prefix>` defaults to `ytf` (see white-label config below).
- **`refresh.mjs`** runs the whole chain in one shot:
  ```powershell
  cd "supermega-remote"
  node refresh.mjs
  # extract -> drive-sources -> sites -> retailers -> inventory -> stock-balance ->
  # production -> daily-production -> finance -> manager-forms -> manual-entries ->
  # insights -> trends -> quality -> pipeline
  ```
  `sync.ps1` does `refresh.mjs` + deploy + re-alias in one command. It defaults to
  `ops.supermega.dev` and refuses `ytf.supermega.dev`; the YTF ERP domain belongs to the
  `supermega-ytf` deployment in the main platform repo. To pull *fresh* Gmail/Drive
  first, use the connectors (an assistant step) or the server-side Drive integration — see
  `INTEGRATION.md`.

> **Privacy:** the feed is written to a **private `feed/` dir**, NOT `public/`. It is served only
> through the token-gated **`/api/control?action=data&file=<prefix>-…`** endpoint (bundled into the
> function via `vercel.json` `includeFiles: feed/**`). There are no public data JSON files —
> `/feed/*.json` over the CDN returns `404`, and `?action=data` without the header returns `401`.

## White-label config

`public/config.json` rebrands the cockpit per deploy **with no code change**:

- `brand` / `instance` / `tagline` / `footer` — names shown in the UI.
- `accent` — theme colour (also recolours the logo gradient + meta theme-color).
- `monogram` — the 1–2 char logo badge (defaults to initials of brand/instance).
- `feed_prefix` — the feed namespace; **must match the server `FEED_PREFIX` env var** (default `ytf`).
- `search_placeholder` / `search_chips` — the search bar copy + quick chips.
- `modules` — set any to `false` to **hide** that section/tile/search source (e.g. `"claims": false`).
  Keys: intelligence, trends, financials, production_mtd, production_fg, production, inventory,
  stock_balance, distribution, claims, procurement, raw_material, parties, sites, quality_wcm,
  data_sources.

## Security model

- Every request to `/api/control` must carry the `PANEL_TOKEN` in the **`x-panel-token` header**
  (entered once on the phone, stored in the browser). Wrong/absent token → `401`. The token is
  **never** accepted via query string (it would leak into logs).
- The token-gated `data` action serves only an allowlist (`<prefix>-` × fixed suffixes) from `feed/`.
- The live app's `CRON_TOKEN` is **server-only**; it is never sent to the browser.
- Triggerable jobs are an explicit allowlist in `api/control.js` — nothing else can be called.

## Setup (one time)

1. **Deploy** this folder as a Vercel project (the machine may already be CLI-authed):
   ```bash
   npx --yes vercel@latest deploy --prod --yes --scope <your-team>
   ```
   (No build step — it's static + one function. Run deploy from Bash; PowerShell's `2>&1` mangles
   the CLI output and breaks prod-URL parsing.)

2. **Set environment variables** (Vercel → Project → Settings → Environment Variables, Production):
   | Var | Value |
   |-----|-------|
   | `PANEL_TOKEN` | a long random passphrase you'll type on your phone |
   | `CRON_TOKEN`  | the live app's `CRON_SECRET` / `SUPERMEGA_INTERNAL_CRON_TOKEN` |
   | `LIVE_APP_BASE` | `https://supermega-ytf-swanhtet01s-projects.vercel.app` (or your custom domain) |
   | `VERCEL_BYPASS` | only if the live app has Deployment Protection on (see below) |
   | `FEED_PREFIX` | optional; the feed namespace, must match `config.json` `feed_prefix` (default `ytf`) |

   Then redeploy so the vars take effect.

3. **Open it on your phone**, enter the `PANEL_TOKEN`, then Share → Add to Home Screen.

## If the live app is access-protected

The `*-swanhtet01s-projects.vercel.app` URLs may have Vercel **Deployment Protection** on, which
blocks anonymous requests (including this proxy). Two options:

- **Best:** supermega-ytf → Settings → Deployment Protection → **Protection Bypass for Automation**
  → generate a secret → set it here as `VERCEL_BYPASS`. The proxy then sends it automatically.
- Or point `LIVE_APP_BASE` at a public custom domain (without protection).

> Until `VERCEL_BYPASS` (or a public `LIVE_APP_BASE`) is set, the live **status** card shows
> "Unreachable"; the ops cockpit, search, and data entry still work (they read the bundled feed).

## Notes

- `CRON_TOKEN` must match the live value exactly, or triggers return `401` from the live app.
- Triggering a cron runs the *real* pipeline. The panel asks for confirmation before each run.
- A job runs on the **live backend**; the panel's own tiles/search read the per-deploy bundled feed,
  so they only change after `node refresh.mjs` + redeploy (not immediately after a job).
- The "Last response" drawer shows the raw JSON the live app returned — handy for debugging.

## Files

| File | Purpose |
|------|---------|
| `api/control.js` | serverless proxy: auth, live status, job triggers, token-gated `data` (feed) |
| `public/index.html` | the mobile panel — status, Ops card, **no-AI search**, job triggers |
| `public/ops.html` | structured-data detail view (all modules; lazy-loaded heavy ledgers) |
| `public/entry.html` | on-device data capture / digital whiteboard (CSV/JSON export) |
| `public/config.json` | white-label config (brand, accent, monogram, feed_prefix, modules) |
| `feed/<prefix>-*.json` | generated **private** data the panel reads (token-gated; do not hand-edit) |
| `pipeline.mjs` | ledgers + inventory/stock/production/finance/intelligence/… → the feed JSON |
| `refresh.mjs` | one-shot generator chain (see above) |
| `sync.ps1` | refresh + deploy + re-alias the remote cockpit domain in one command |
| `dev-server.mjs` | local dev server (mocks the live app; serves `/api/control` via control.js) |
| `public/sw.js` · `manifest.webmanifest` · `icon.svg` | PWA install support |
| `vercel.json` | headers + function duration + `includeFiles: feed/**` |

See `TEMPLATE.md` (productization) and `INTEGRATION.md` (connectors / plug-and-play refresh).
