# SuperMega Ops — the product (beyond YTF)

The cockpit built for Yangon Tyre is **one instance of a sellable product**, not a one-off. This
doc defines the product, where it sits in the SuperMega app portfolio, how it goes on supermega.dev,
and what other apps the platform still needs.

## 1. What the product is

**SuperMega Ops** — *"Turn your scattered spreadsheets, email, and existing software into one live,
secure operations cockpit — in a day, no ERP migration."*

- Reads the customer's **Google Drive workbooks + Gmail (+ Viber soon, + Galaxy/SQL exports)**, not a
  new system they have to key data into.
- Produces a phone-installable **cockpit**: headline tiles, alerts, deep ledgers (inventory,
  stock-on-hand + months-of-cover, production by line/grade, procurement, claims, distribution),
  cross-module **intelligence** (days-to-stockout), **trends**, **quality/WCM**, and a **no-AI search**.
- **Per-tenant, private, white-label**: own Vercel project, own token-gated feed, own passcode, own
  brand/accent/modules via `config.json`. New tenant = `node new-client.mjs` → config → point at data → deploy.
- Sits **on top of** what they already run (Excel, email, Galaxy iStock) — zero rip-and-replace.

**Wedge:** SMB manufacturers/distributors/retailers in Myanmar & SEA who have the data (in sheets +
email) but no usable, current, mobile view of their operation. ERP is too heavy; this is the 1-day layer.

## 2. Where it sits — the SuperMega app portfolio

One platform, warm "Arcane Atelier" brand (see BRAND.md), shared auth + design. Products:

| App | What it does | Status |
|---|---|---|
| **SuperMega Ops** (this) | Drive/Gmail/sheets → live ops cockpit + intelligence + search | **live** (YTF = first tenant at ops.supermega.dev) |
| **DeskPOS** | configurable front-desk POS + inventory (pos.supermega.dev) | live |
| **YTF ERP** (supermega-ytf) | full operational backend: daily-entry UI, manager surfaces, WCM runtime, role auth | live (Codex) at ytf.supermega.dev |
| **Payslip Maker** | salary .xlsx → printable payslips, in-browser decrypt | live |

### What other apps are needed (the gaps to build)
Prioritised by leverage for the same SMB customer:
1. **Connectors hub** — a reusable adapter layer (Drive SA ✓, Gmail ✓, Viber bridge ⏳, **Galaxy iStock / SQL export**, WhatsApp, bank statement OCR). This is the moat; every app draws from it.
2. **Orders & receivables** — dealer orders + payments + credit/aging (from Viber + Galaxy). The #1 thing SMBs lose money on; feeds Ops distribution + a collections view.
3. **Procurement / PO lifecycle** — the TFT/KIIC threads as POs with status, ETAs, landed cost (not just a thread list). Half-built in the ledger already.
4. **Quality / CAPA app** — the `entry.html` whiteboard → real OEE (downtime), 5W1H→8D CAPA register, ISO/IATF evidence. Turns the WCM board live.
5. **Reports & exports** — scheduled PDF/Excel "owner brief" + share links (the thing owners actually forward).
6. **Admin / multi-tenant console** — manage tenants, passcodes, modules, branding, billing from one place (productizes #1 of section 3).
7. **AI back-office operator** (optional, separate from the no-AI cockpit) — drafts replies/POs/DOs for approval. Kept OUT of the cockpit by design; a distinct opt-in app.

## 3. Putting it on supermega.dev (standard product)

supermega.dev is the marketing site (Codex owns the generator: `supermega-platform/tools/create_public_vercel_output.mjs`). To list SuperMega Ops as a standard product:

- **Add a product card + detail page** ("SuperMega Ops — operations cockpit"), same shell as the
  other products. Copy + the value prop above. CTA → **live demo** (see §4) + "Book a setup".
- **Screenshots**: the cockpit panel (tiles + stockout alerts), the ops detail (inventory + months-of-cover, production by line incl. MC), the no-AI search, the data-entry whiteboard. Capture from the demo tenant.
- **Positioning line**: "Your operation, live on your phone — from the spreadsheets and email you already use."
- Keep names plain/descriptive (matches the site's existing convention); "SuperMega Ops" or "Operations Cockpit".

I will NOT edit Codex's site generator directly (avoids the deploy-war). Instead this repo provides a
**ready integration kit** (copy + screenshots + demo URL) — see `WEBSITE-KIT.md` — for Codex to drop in.

## 4. Demo tenant (the proof for the website)

Stand up a generic, no-real-data demo so the site can link/screenshot a product, not YTF's private data:
```
node new-client.mjs --name "SuperMega Ops Demo" --prefix demo --write
# point at sample data (ytf-ops-tools/data/*.sample.json), refresh, deploy a "supermega-ops-demo" project,
# alias demo.supermega.dev, passcode "demo"
```
Demo data only; never expose a real tenant's feed publicly.

## 5. Packaging & pricing (proprietary product)

- **Setup** (one-time): connect sources + brand + deploy a tenant — fixed fee.
- **Subscription** (per tenant / month): hosting + refresh + support; tiers by # modules / sites / data volume.
- **Integrator license**: license the template + `new-client.mjs` scaffold to resellers.
- **Moat**: the messy-data pipeline (merged cells, multi-table, reconciliation), the connector hub, the
  WCM/ISO layer, and the no-AI privacy posture (cheaper to run, no per-client API cost, no data leaving the tenant).

## 6. Status / next
- Product shell, white-label config, `new-client.mjs` scaffold, service-account auto-refresh: **built**.
- YTF tenant: **live**. Demo tenant + website kit + Codex handoff: **this push** (see `WEBSITE-KIT.md`).
- Build order for the gaps: Connectors hub → Orders/receivables → Admin console.
