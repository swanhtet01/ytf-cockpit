# Yangon Tyre — the full build (modules, roles, what's done, what's left)

The goal: one **final, real, professional** system for Yangon Tyre. It is **two surfaces, one product**,
not two competing apps. Keeping them distinct is what makes it professional (each does what it's best at).

## The two surfaces (clear division of labor)

| | **ytf.supermega.dev** — the ERP (Codex) | **ops.supermega.dev** — the cockpit (this repo) |
|---|---|---|
| Role | **System of record + workflows** | **At-a-glance + intelligence + capture companion** |
| Tech | Python/JS app, login, workspaces, DB | Static PWA + 1 serverless proxy; reads a private feed |
| Best at | data entry, daily close + sign-off, payroll/attendance, manager workflows, role workspaces | phone dashboard, stock-out/quality intelligence, no-AI search, whiteboard/Viber capture, alerts |
| Who opens it | staff doing the work, on desktop | owner/manager on their phone, "how are we doing right now" |
| Link | — | the cockpit's "Open full ERP →" button deep-links here |

Rule (held): the cockpit never re-implements the ERP's heavy workflows; the ERP doesn't try to be the
phone dashboard. Email (Gmail) data is CEO-only; Viber is per-group; both surfaces honor that.

## Roles & users (the real four)
`PANEL_USERS` env (set via admin.html → Vercel). Same model both surfaces should share.

| Role | Sees | Email (Gmail) data | Viber | Can trigger jobs |
|---|---|---|---|---|
| **admin** | everything + system/pipeline | no (CEO-only rule) | all groups | pipeline + insight + agents |
| **ceo** | everything incl. finance | **yes (only role)** | all groups | all |
| **manager** (head office) | cross-plant ops | no | their groups (e.g. plant-a, plant-b, head-office) | pipeline + insight |
| **plant_manager** (per plant) | their plant only | no | their plant's groups | pipeline |

## Module map — done / partial / to build

### ✅ Done (cockpit, live)
- Production by size + grade (PCR/Radial + **MC** lines; total 249k YTD), scrap Pareto by size.
- Daily production MTD vs plan; raw-material **stock + months-of-cover**, in-transit + reorder flags.
- **Days-to-stockout intelligence** with recommended actions; trends/momentum; sites roll-up.
- Quality/WCM/ISO-IATF scorecard; **OEE A×P×Q** once downtime is logged.
- Warranty **claims** ledger; **procurement** (TFT) + raw-material (KIIC) ledgers (CEO-only).
- **Open actions & CAPA** board (owner/due/status from captures).
- Capture: whiteboard **photo→OCR**, **Viber paste→extract**, typed entry — all LLM-extracted, role-scoped.
- No-AI universal search; per-table filter; token-gated private feed; 4-role access; YTF theme; PWA; auto-refresh (Drive service-account + Gmail).

### 🟡 Partial / needs the ERP or infra
- **Durable write-back** — captures persist via download→drop or the ERP; cockpit-native server intake needs **Vercel Blob** (provision once → I wire `POST /api/control?action=entry`).
- **Daily-close manager sign-off** — cockpit shows MTD; the *promote-to-official* step lives in the ERP.
- **OEE Availability** — computes the moment downtime is captured (form exists); needs real logs.

### ⬜ To build for a "full" operation (ranked by value)
1. **Orders & receivables** — dealer orders + payments + credit aging (from Viber + Galaxy iStock). #1 money lever.
2. **Procurement PO→GRN** — TFT threads become POs with status/ETA/landed-cost; reconcile in-transit vs on-hand to a true net position + auto-close on arrival.
3. **Material-consumption forecast** — production volume → raw-material burn (compound/BOM) so stock-out alerts predict further out.
4. **COPQ money packet** — scrap + rejects + downtime + claims → a Kyat cost-of-poor-quality number.
5. **One-tap drafted actions** — "raise PO" / "reply to rejected claim" → a pre-filled draft to send.
6. **Curing/press OEE + maintenance book** — asset registry, breakdowns, MTBF/MTTR (extends the downtime capture).
7. **Append-only history + audit** — immutable movement ledger + who-changed-what (vs full-overwrite feed).
8. **Galaxy iStock connector** — showroom sales orders / dealer credit (adapter scaffolded).

## How to use (today)
- **Owner/manager:** open `ops.supermega.dev` on your phone → unlock → Operations card (this month, stock-outs, tyres) + alerts; tap **Full detail** for ledgers, **Capture** for whiteboard/Viber/photo, **Open full ERP** for data entry/close/payroll.
- **Admin:** `/admin.html` → generate `PANEL_USERS` (roles+groups) + tenant config; set in Vercel.
- **Data:** auto-pulls from the Yangon Tyre Drive (service account) + Gmail; `sync.ps1` or the GitHub Action refreshes + deploys.

## To finish "final & professional"
1. Provision Vercel Blob → durable write-back (unlocks orders, CAPA persistence, daily-close from the cockpit).
2. Build Orders & receivables (#1) — the highest-value missing module.
3. Switch supermega.dev nameservers to Vercel → `ops.supermega.dev` resolves (currently stable Vercel URL).
4. Keep one shared `PANEL_USERS`/role model across both surfaces (coordinate with Codex).
