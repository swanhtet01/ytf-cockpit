# Galaxy iStock — what we need, and how to build on it

Short answer to "API or what": **Galaxy iStock Enterprise has no public/cloud API.** It's a Windows
LAN application on a **Microsoft SQL Server** database (running on the showroom/office PC or a local
server). So we integrate one of three ways, best→simplest:

## The three integration paths (pick per appetite)

| # | Method | What it needs | Pros | Cons | Use when |
|---|---|---|---|---|---|
| 1 | **Scheduled report export** (RECOMMENDED first) | Someone exports iStock's built-in reports (Sales Register, Outstanding/Receivables, Stock Ledger) to Excel/CSV → drops into the Drive "Galaxy export" folder | zero DB creds, works today, safe (read-only by nature), matches our existing Drive→adapter flow | manual/scheduled, not real-time | now — fastest to value |
| 2 | **Direct SQL read** (read-only) | the Galaxy SQL Server reachable + a **read-only** login + table/view names | live, full history, no human step | needs DB access + network + schema mapping; must stay read-only | when you want hands-off live sync |
| 3 | **ODBC / SQL view bridge** | a small read-only SQL **view** over the sales/AR/stock tables + ODBC | clean contract, hides schema churn | one-time DBA setup | the durable long-term option |

All three end the same way: **iStock stays the system-of-record; we read it into the cockpit** (orders,
receivables/credit, stock valuation) as a decision layer — no rip-and-replace, like Drive/Gmail/Viber.

## What we need FROM iStock (the data)
1. **Sales orders / invoices** — date, dealer/customer, items (tyre size + qty), amount, invoice no, status.
2. **Outstanding receivables (the big one)** — per dealer: invoiced, paid, **balance + aging buckets** (0–30 / 31–60 / 61–90 / 90+). This is the money-leak view.
3. **Stock / stock-ledger per site** — already handled by `galaxy-istock.mjs` (Opening/Inward/Outward/Closing/Value).
4. **Item + customer master** — to map Galaxy codes ↔ our tyre sizes / dealer names.

## Recommended Galaxy setup
- **One Galaxy company, four LOCATIONS** (Factory A / Factory B / Showroom / Head Office) so transfers
  are location moves and reports filter per site. (Or separate installs → export each.)
- Schedule the three reports (Sales Register, Receivables aging, Stock Ledger) to auto-export Excel to a
  Drive-synced folder nightly → our service-account pull picks them up → adapters → cockpit.

## What we BUILD on it (cockpit modules, this repo)
- **Orders & receivables** (NEW, `galaxy-orders.mjs`) — orders feed + **dealer credit/aging** board +
  "overdue > X days" alerts in insights. (#1 money lever in FULL-BUILD.md.)
- **Inventory valuation + cross-site stock** — `galaxy-istock.mjs` (built) → per-site + consolidated.
- **Sales analytics** — by size / dealer / region / month (joins with the Retailer DB + production mix).
- **Order → production → dispatch** thread — tie a Galaxy SO to production + delivery confirmation (Viber).

## How to wire a path-1 export today
1. In iStock: run **Sales Register** + **Outstanding (Receivables)** → Export to Excel.
2. Drop into the Drive "Galaxy export" folder (share it with the service account, like the Yangon Tyre folder).
3. Add the fileIds to `ytf-ops-tools/lib/connectors.mjs` (pullableDrive) → `pull-drive.mjs` fetches them.
4. `galaxy-orders.mjs` + `galaxy-istock.mjs` parse them → `refresh.mjs` → cockpit shows Orders & receivables.

For path 2/3 (live SQL): give me a read-only SQL login + host; I'll add a `galaxy-sql.mjs` connector
(node, mssql over the LAN or a tunnel) that runs the same queries on a schedule. No iStock change needed
beyond the read-only user.
