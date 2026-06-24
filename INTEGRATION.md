# ops.supermega.dev - integration & "plug-and-play" data flow

The cockpit is **integrated with your live sources through connectors**; this is how data gets in
and stays current, and how to make it fully hands-off.

## Connectors in play
| Connector | Feeds | Status |
|---|---|---|
| **Google Drive** | monthly Tyre Production / Stock Balance xlsx, P&L, Retailer DB | live (pipeline) |
| **Gmail** | warranty claims (#YGN), TFT procurement, KIIC raw materials | live (classifier) |
| **Whiteboard / manual entry** (`entry.html`) | 5W1H/CAPA, downtime→OEE, safety, claims/production/sale | live (CSV/JSON → `manual-entries/`) |
| **Vercel** | hosting + domain alias | live |
| **Galaxy iStock** | inventory/sales (future) | adapter ready (`galaxy-istock.mjs`) |

Every source → a generator → a **normalized private feed** (`feed/*.json`) → served token-gated via
`/api/control?action=data`. The UI only reads the normalized feed, so adding a source never touches the UI.

## Refresh today (one command)
```powershell
# rebuild feed from latest data + publish + re-alias ops.supermega.dev
powershell -ExecutionPolicy Bypass -File sync.ps1
```
`sync.ps1` runs `node refresh.mjs` (extract → drive-sources → sites → retailers → inventory →
stock-balance → production → daily-production → finance → insights → trends → quality → pipeline),
deploys, and re-aliases the remote cockpit domain. It refuses `ytf.supermega.dev`; the YTF ERP
domain must be deployed and repaired only from the main platform repo with `npm run ytf:alias:repair`.
Pulling **new** Gmail/Drive uses the connectors (an assistant step) or the
server integration below; `sync.ps1` always publishes the current pipeline output (incl. new
whiteboard captures dropped into `manual-entries/`).

## Fully hands-off ("plug & play") — the next step
Two ways to make it self-updating with **no manual step**:

**A. Server-side Google Drive (recommended, true plug-and-play)**
1. Create a Google Cloud **service account**, enable the Drive API, download its JSON key.
2. **Share** the "Yangon Tyre" Drive folder (read-only) with the service-account email.
3. Set `GOOGLE_SA_KEY` (the JSON) in the Vercel project env.
4. A Vercel **Cron** hits `/api/refresh` nightly → the function reads the canonical Drive files
   (via the SA), runs the generators, and writes the feed to **Vercel KV** → the cockpit serves the
   fresh feed with **no deploy and no assistant**. (Code path: download Drive file bytes → `/tmp` →
   existing generators → KV. `drive-manifest.json` already lists the canonical fileIds.)

**B. Scheduled assistant refresh (no GCP setup)**
A scheduled routine re-pulls Gmail/Drive via the connectors, runs `refresh.mjs`, and deploys —
hands-off as long as the connectors + Vercel auth are available to the scheduled run.

## Whiteboard → data loop (already integrated)
`entry.html` captures (downtime, safety, 5W1H) → export CSV/JSON → drop into
`ytf-ops-tools/manual-entries/` (or your Drive "WCM Capture" sheet) → next `sync.ps1` ingests them →
fills the WCM gaps (downtime→OEE availability, safety→incidents, 5W1H→CAPA).

## Current state
- Integrated as a remote cockpit at **ops.supermega.dev** (Drive + Gmail + whiteboard, token-gated).
- The ERP remains at **ytf.supermega.dev** and must not be aliased from this project.
- One-command publish via `sync.ps1`.
- Fully-automatic refresh = option A (server-side Drive SA + Vercel cron + KV) — code path documented; needs the SA key + KV provisioned.
