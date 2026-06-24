# supermega.dev integration kit — SuperMega Ops (for Codex)

Everything to list **SuperMega Ops** as a standard product on supermega.dev, packaged so it drops
into the site generator (`supermega-platform/tools/create_public_vercel_output.mjs` →
`unicornShellStyle`) without me editing it (avoids the deploy-war). Pick what you need.

## 1. Product card (for the products grid)
- **Name:** SuperMega Ops  (plain/descriptive: "Operations Cockpit" also fine)
- **One-liner:** Your whole operation, live on your phone.
- **Sub:** Turn the spreadsheets, email, and software you already use into one live, secure ops
  cockpit — stock-out alerts, production, claims, procurement, P&L — in a day, no ERP migration.
- **Accent:** clay `#D97757` (brand default) — or the YTF product ember `#E8A23D` if you want per-product accents.
- **Icon idea:** casting-ring + phone, or the M-rune mark.
- **CTA:** "See it live" → demo URL (§3) · "Talk to us" → mailto.

## 2. Detail page
A full, on-brand landing already exists and is **live**: `public/product.html` →
`https://<ops-deploy>/product.html`. It uses the exact Atelier tokens (clay, Fraunces+Inter), a faux
cockpit preview with real numbers, the source→cockpit flow, feature grid, and CTAs. Two ways to use it:
- **Link** the product card straight to `/product.html` (fastest), or
- **Lift the copy + structure** into a native generator section (the markup is plain + token-driven,
  so it maps onto `unicornShellStyle` cleanly).

## 3. Live demo tenant (so the site never exposes a real customer's data)
Stand up a generic demo (no real tenant feed):
```
cd supermega-remote
node new-client.mjs --name "SuperMega Ops Demo" --prefix demo --write
# point at ytf-ops-tools/data/*.sample.json, refresh, deploy a "supermega-ops-demo" project,
# set PANEL_TOKEN=demo + FEED_PREFIX=demo, alias demo.supermega.dev (DNS A 76.76.21.21)
```
Link the card's "See it live" at `https://demo.supermega.dev` (passcode shown on the page). Never
point the public site at a real tenant (ytf is private + token-gated by design).

## 4. Screenshots to feature
Capture from the demo tenant (or `product.html`):
1. **Panel** — headline tiles + stock-out alerts (the "wow": days-to-stockout).
2. **Ops detail** — inventory with months-of-cover + production by line (incl. the MC line).
3. **No-AI search** — type "carbon" → grouped results.
4. **Data-entry whiteboard** — `entry.html` (5W1H / downtime / safety capture).
(The cockpit screenshot tooling hangs on the cross-origin font load in headless; capture on a real
device/browser, or screenshot `product.html` which renders cleanly.)

## 5. Copy blocks (reusable)
- Hero: "Your whole operation, live on your phone."
- Value: "Sits on top of what you already run — Excel, email, Galaxy iStock. No rip-and-replace."
- Differentiators: 1-day setup · zero data entry (reads your sources) · no AI keys (private + cheap) · white-label per tenant.
- Proof: "First tenant: a Myanmar tyre factory — 405k tyres/yr across two lines, 86 raw materials with live stock-out alerts, 200+ procurement threads, all from their existing Drive + Gmail."

## 6. Boundaries (so we don't collide)
- `ytf.supermega.dev` = your ERP (untouched). The cockpit lives at `ops.supermega.dev` (+ `demo.` for the site).
- I won't edit `create_public_vercel_output.mjs`. If you'd rather I prepare a ready generator snippet
  (a `products` entry + a section render fn) instead of a linked page, say so and I'll add it to this kit.
- See `PRODUCT.md` for the full product definition, the app portfolio ("what other apps to build"),
  and pricing.
