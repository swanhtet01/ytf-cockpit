# SuperMega Ops — white-label cockpit template

This cockpit is a **proprietary, reusable product**, not a one-off. YTF is the first instance. A new
client = **copy + reconfigure + point at their data + deploy** — typically a day, not a project.

## What's reusable (the generic shell) vs vertical
| Generic shell (works for ANY inventory/ops business) | Vertical module (swap per industry) |
|---|---|
| Cockpit UI (panel + ops view), responsive, PWA-installable | Warranty **claims** (#YGN parser) — tyre-specific |
| **No-AI universal search**, per-table filters | Tyre **production by size / grade A/B/R** |
| **Token-gated private data** (feed/ + /api/control) | TFT/KIIC **procurement** classifiers (tyre supply chain) |
| **Inventory + days-to-stockout**, stock balance | — |
| **Finance / P&L / cash** parser | — |
| **Intelligence** (cross-module signals), **Trends** | — |
| **Sites** model + **Galaxy iStock adapter** | — |
| **WCM + ISO 9001/IATF 16949** quality scorecard + digital whiteboard | (IATF is auto/tyre; swap for the client's standard) |
| **Multi-source pipeline**: Drive + Gmail (+ Viber) + iStock | source list per client |

The shell is industry-agnostic: any SMB that has **inventory + sales + purchasing + a few spreadsheets/email** can run it. "Other kinds of software" = same shell, different data adapters + modules.

## Configure (white-label) — `public/config.json`
```json
{ "brand": "SuperMega Ops", "instance": "<Client Name>", "tagline": "operations cockpit",
  "accent": "#4f8cff", "vertical": "<industry>", "modules": { "claims": true, "production_fg": true, ... } }
```
Applied at runtime by index.html + ops.html: brand name, page title, **accent colour**, and which modules show (`modules.*` toggles). No code change to rebrand.

## Stand up a new client (steps)
1. **Fork** the `supermega-remote` (cockpit) + `ytf-ops-tools` (pipeline) folders.
2. **Brand**: edit `public/config.json` (name, accent, modules). Generate a new `PANEL_TOKEN`.
3. **Data adapters** (`ytf-ops-tools/`): keep the generic generators (stock-balance, finance, inventory, sites, galaxy-istock); point them at the client's files (drive-manifest.json) or write a thin adapter for their format. Drop vertical modules they don't need (toggle off in config).
4. **Sources**: connect the client's Google Drive/Gmail (or Galaxy iStock export/SQL); update `data/drive-inventory.json`.
5. **Deploy**: `node refresh.mjs && vercel deploy --prod` → assign `<client>.yourdomain` (alias).
6. **Hand over**: passcode + the cockpit URL. Data stays private (gated), per-client.

## Architecture that makes it templatable
- **Adapter pattern**: every source → a generator that emits a **common schema** (the cockpit only reads the normalized feed). New source = new adapter, UI unchanged.
- **Config-driven UI**: branding + module visibility from `config.json`.
- **Per-deploy isolation**: each client = own Vercel project + own gated `feed/` + own passcode. No shared data.
- **No AI/keys**: deterministic — cheaper to run, no per-client API cost, no data leaving the tenant.

## Positioning (proprietary product)
- **What it sells:** "turn your scattered spreadsheets + email (+ your existing inventory software like Galaxy iStock) into one live, searchable, secure operations cockpit with stock-out alerts, P&L, and a WCM/ISO quality board — in a day, no ERP migration."
- **Wedge:** sits **on top of** whatever they already run (iStock, Excel, email) — zero rip-and-replace.
- **Verticals beyond tyre:** any manufacturer/distributor/retailer; swap the vertical module (claims→service tickets, tyre sizes→SKUs).
- **Pricing model:** per-tenant SaaS (setup + monthly), or license the template to integrators.
- **Moat:** the messy-data pipeline (merged cells, multi-table, reconciliation), the WCM/ISO layer, and the no-AI privacy posture.

## Status
- Config layer + branding: **built** (config.json wired into index.html + ops.html).
- YTF instance: **live** at ytf.supermega.dev.
- To productize fully next: a one-command `new-client` scaffold + a settings UI for `config.json`.
