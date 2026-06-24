# How to Use the Yangon Tyre Ops Cockpit (Phone Guide)

A plain-language, step-by-step guide for the factory owner/manager, grounded in the real screens. Everything lives in one phone app reachable at **ops.supermega.dev** (the cockpit's own domain, set in `supermega-remote/sync.ps1`). The data behind it (claims, stock, production, dealers, finance) is the *real* Yangon Tyre data, pulled from your Google Drive workbooks and Gmail.

There are four screens, all reached from the panel:
- **Panel** (`/index.html`) — the home screen: status, Ops card, search, pipeline buttons.
- **Ops cockpit** (`/ops.html`) — the full detail view, every ledger and table.
- **Data entry** (`/entry.html`) — the digital whiteboard for capturing things by hand.
- **Admin** (`/admin.html`) — health check + setup-for-new-factory console (rarely needed).

---

## 1. Open + unlock the cockpit, then install it

**Open and unlock**
1. In your phone browser go to **ops.supermega.dev**.
2. You'll see a dark screen titled **"SuperMega Remote"** with one box: *"Enter your panel passcode."*
3. Type the **panel passcode** (the long passphrase set as `PANEL_TOKEN`; ask whoever set up the app — it's the same code every time) and tap **Unlock**.
4. If it says **"Wrong passcode,"** re-type carefully — it is case-sensitive. *"Server not ready"* means the app needs setup, not your fault — contact your admin.
5. Once correct, the passcode is **remembered on that phone** (`localStorage`), so you normally won't re-type it. The top-right **eject button (⏏)** logs you out and forgets it; use it if you lose the phone.

**Install to the home screen (do this once, so it opens like a real app)**
- **iPhone (Safari):** tap the **Share** button → **Add to Home Screen** → **Add**.
- **Android (Chrome):** tap the **⋮** menu → **Add to Home screen** / **Install app**.
- A **"SM Remote"** icon appears. Tapping it opens full-screen with no browser bars. It even works partly offline.

---

## 2. The daily flow — read the home Panel each morning

When you open the app, the Panel shows three cards top-to-bottom. Read them in order.

**(a) Status card (top)** — *Is the system alive?*
- A coloured **dot** + **"Live · ready"** = everything is healthy and talking to the live app. It auto-refreshes every 30 seconds; the **⟳** button forces a refresh.
- A **red dot / "Unreachable"** means the cockpit can't reach the live backend right now. Important: your numbers below are still readable (they're saved in the app) — only the live "is-it-online" check is down. No action needed from you; tell your admin if it stays red for a day.
- The **Data coverage** bar shows how complete the data is. Higher is better.

**(b) Ops card — "Yangon Tyre Ops"** — *your morning dashboard.* Small tiles summarise:
- **Claims** — e.g. `12 · 80% ✓` = 12 warranty claims processed, 80% approved.
- **Procurement** — count of machine-part (TFT) threads + the latest one.
- **Stock** — number of materials tracked and how many are **low**.
- **Production** — tyres produced (in thousands) and Grade-A %.
- **Dealers** — dealer count and top region.
- **Sources** — how many data feeds are live vs. tracked.

**Alerts** appear below the tiles as **⚠️ orange boxes**. These are the things that need a human. **When an alert fires:**
- *"X material low / out of stock"* → check the **Raw-material stock** section in the cockpit, then start a reorder with that supplier.
- *"Claims awaiting / high rejection"* → open the **Warranty claims** ledger and follow up.
- *"Source stale"* → the underlying workbook hasn't updated; ask the responsible person to update their Drive sheet (see Section 4).
- An alert is a **prompt to act outside the app** (call a supplier, chase a sheet) — the app surfaces it; you and your team resolve it.

**(c) Search card** — type any tyre size, claim ID, material, dealer, or **TFT** number to find it instantly across all ledgers. Tap a quick chip (e.g. *carbon, reorder, radial, TFT, rejected*) for a one-tap search. This is plain text matching — no internet AI, fully private.

**Going deeper:** tap **"Full ledgers →"** on the Search card to open the **Ops cockpit** (`/ops.html`).

### What each section of the Ops cockpit (`/ops.html`) means
At the top is a filter box — type a size/claim/material/dealer/TFT to filter **every table at once**. The subtitle line shows current production month, stock status, and data freshness; a red **STALE** tag appears if the data is over 3 weeks old. Sections (each shows only if it has data):
- **Headline tiles + claims bar** — MTD production, stock items, procurement, raw materials, warranty claims (green/amber/red bar = approved/partial/rejected), production reports.
- **Intelligence** — the system's own warnings (e.g. "X days to stockout"), ranked critical → high → watch. Read these first.
- **Trends** — production momentum and month-over-month sales, with a small bar chart.
- **Sites** — Factory A (Bilin), Factory B (SPT), Showroom, Head Office.
- **Financials** — revenue, gross/net profit, cash (only shows for a current 2026 period; says "reconciled ✓" when the numbers tie out).
- **Production — MTD (daily)** — this month's output vs. target, Grade-A %, day-by-day table with a vs-target % pill.
- **Finished goods / Motorcycle production** — top sizes by volume, grades, tonnage.
- **Inventory — raw materials** — auto-read from supplier emails: what's in transit, ETAs, **REORDER** flags. No data entry needed.
- **Raw-material stock — on hand** — months of cover per material; **LOW/OUT** items listed first.
- **Distribution / dealers** — dealers by region, top dealers, sales, estimated rebate.
- **Warranty claims / Procurement (TFT) / Raw materials** — big lists; they show a preview and a **"Show all →"** button to load the rest.
- **Data sources** — which Drive files feed the cockpit and whether each is **live / available / stale**. Tap a source name to open the actual Drive file.

> Note: the source files (claims, procurement, stock) are clickable links straight to the real Drive workbook (↗), so you can always open the original.

---

## 3. Capture on the whiteboard (`/entry.html`)

This replaces the paper whiteboard on the factory floor. Open it from the Ops card's **"+ Data entry →"** link, or the **← Panel** screen. At the top are six buttons — tap one to pick what you're recording:

- **Claim** — a warranty claim: date, claim ID, product (radial/bias/tube), status, customer, region, notes.
- **Production** — output: plant (A / B / Bilin / SPT), product, quantity, weight, shift notes.
- **Sale** — a sale: location, product, qty, amount in **Kyat**, retailer.
- **5W1H** — a problem-solving board: site, board type (5W1H/Kaizen/SQDC/NCR), area/machine, *what / why / root cause (5-Why) / countermeasure*, owner, due date, status. This feeds your CAPA / corrective-action register.
- **Downtime** — machine stoppages: site, machine, downtime minutes, planned minutes, reason, action. This feeds the OEE/availability number.
- **Safety** — an incident: site, type (near-miss / first-aid / recordable / lost-time), severity, area, what happened, corrective action. This feeds the WCM Safety pillar.

**How to use it:**
1. Tap the entry type at the top.
2. Fill the form (date defaults to today).
3. Tap **Save entry**. You'll see **"Saved ✓."** The counter shows how many entries are stored.
4. Saved entries list below; tap the **✕** to delete a wrong one. **Clear** wipes all local entries (it asks first).

**Important — where the data goes:** entries are saved **on that one phone only** (offline-safe). They are **not** automatically in the cockpit yet. To send them in, tap **⬇ JSON** or **⬇ CSV** to export the file and hand it to your admin, who drops it into the tools folder and runs the refresh (Section 4). So: capture freely during the day; export and send at end of day/week.

**Photos:** photo attachments are planned but **not on this screen yet** — today it's the typed fields above. Use the **notes** box to describe a defect or incident until photo capture ships.

---

## 4. Keep the data fresh

You mostly **don't** have to do anything — the cockpit refreshes itself.

- **Automatic (the normal case):** the system pulls your latest **Google Drive workbooks** on its own. `sync.ps1` first runs `pull-drive.mjs`, which uses a Google **service account** to download the canonical "Yangon Tyre" files (no login, no manual step) into a cache, then rebuilds the cockpit feed and publishes it. So if your team keeps the Drive sheets (Monthly Stock Balance, Tyre Production, Retailer DB, etc.) up to date, the cockpit follows. Supplier emails feed the Inventory section automatically with no entry at all.
- **What you do:** keep the **Drive workbooks current**. When an alert says a source is **stale**, that's the prompt — get the owner to update their sheet.
- **Manual refresh (admin/technical, on the office PC):** if numbers look behind and you want to force an update, the one command is:
  ```powershell
  cd "supermega-remote"
  .\sync.ps1
  ```
  This does it all in order: pull Drive → rebuild the feed (`refresh.mjs`) → deploy → re-point the **ops.supermega.dev** domain. (It deliberately refuses to touch the `ytf.supermega.dev` ERP domain — that's a separate app.) This step needs the Google service-account key file and is a job for whoever set the system up — not something to run from the phone.

> Why a job button on the Panel doesn't instantly change the tiles: the Panel's **Pipeline** buttons trigger work on the live backend, but the tiles/search read a bundled copy that only updates after a refresh+publish. So after triggering a job, give it time and re-open later — don't expect the numbers to jump immediately.

---

## 5. The Admin page (`/admin.html`) — usually leave it alone

Reach it by typing `/admin.html` after the address, or from links inside the app. It's a **technical console**, not a daily screen. Two useful things for a manager:
- **Health & meta** — confirms the live app status, database, coverage %, and when the feed was last generated. A quick "is it healthy and how fresh is it?" check.
- **Surfaces** — quick links to the Panel, Ops cockpit, Data entry, and Product page.

The **"New tenant / branding"** section is for **rolling the cockpit out to another factory/client** (set a name, colour, monogram, and toggle which sections show). You won't need it for running Yangon Tyre day-to-day — ignore it unless you're setting up a second site.

---

### One-line daily habit
Open the app → glance at the **Ops card + any ⚠️ alerts** → tap **Full ledgers** if something needs a closer look → use **Data entry** to log claims/downtime/safety as they happen → export and send those to your admin at end of day.

## Next build steps
- Open ops.supermega.dev on your phone, enter the panel passcode (PANEL_TOKEN), and Add to Home Screen so it opens like an app
- Each morning read the 'Yangon Tyre Ops' card on /index.html and act on any orange ⚠️ alert (low stock = reorder, stale source = chase the Drive sheet owner)
- Tap 'Full ledgers →' to open /ops.html and check the Intelligence + Raw-material stock + Warranty claims sections when an alert points there
- Use /entry.html during the day to log Claims, Downtime, and Safety incidents; tap ⬇ CSV/JSON at end of day and send the file to your admin
- Keep the Google Drive workbooks (stock, production, retailer DB) current — the cockpit auto-pulls them; a STALE tag means a sheet needs updating
- Admin only: on the office PC run `cd supermega-remote; .\sync.ps1` to force a Drive pull + feed rebuild + publish
