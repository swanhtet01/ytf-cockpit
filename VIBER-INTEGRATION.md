# Viber → cockpit pipeline (design)

## DECISION (2026-06-23): ingestion method + access model

**Investigated 2026-06-23:** Viber Desktop's DB IS on this PC
(`%APPDATA%\ViberPC\9595000721\viber.db`) but it is **ENCRYPTED (SQLCipher)** — the header is not
`SQLite format 3` and `node:sqlite` returns "file is not a database". Modern Viber encrypts the store
with a key sealed in Windows DPAPI. Decrypting it is possible but fragile (version-specific key
derivation, breaks on Viber updates) — **not the path to rely on.**

**Best ingestion (given the encrypted DB) = computer-use bridge → the OCR/LLM extractor we already built.**
Open Viber Desktop, scroll each watched group, capture the visible messages (text via the accessibility
tree, or screenshots), and run them through the **same extractor as `whiteboard-ocr.mjs`** (Claude
vision/text → structured records). Emit `data/manual-entries/viber-<group>.json` tagged with the
**group key**; `manual-entries.mjs` folds them in; `redactForRole()` scopes them per user's groups.
- Ranked options: **(1) computer-use bridge** (practical, works today — needs a computer-use grant for
  Viber Desktop) → (2) local DB decrypt via the DPAPI SQLCipher key (advanced/fragile — only if a
  hands-off cron is required and you accept the maintenance) → (3) Viber Bot API (covers only bots
  users message, NOT existing group history — unusable here).
- `viber-pull.mjs` (scaffold) already LOCATES the DB and detects the encryption; it abstracts the
  reader behind `readViberMessages()` so either backend (computer-use capture, or a decrypt) plugs in.

**Access model (per the owner, 2026-06-23):**
- **Email (Gmail) data = CEO role ONLY.** Enforced server-side now (`api/control.js`: email-derived
  files 403 for non-CEO; claims/procurement/raw-material stripped from ops/dashboard for non-CEO).
- **Viber data = ALL roles, scoped to the GROUPS each user belongs to.** Each Viber group maps to the
  roles/users allowed to see it. Implemented via `PANEL_USERS` → each role carries a `groups` list;
  `redactForRole()` already filters any `json.viber.records` to `who.groups` (`*` = all). So when Viber
  data lands in the feed keyed by `group`, a plant-A operator sees only plant-A's Viber, the CEO sees all.
- Mapping lives in two places that must agree: the **group names** Viber exposes (conversation titles)
  and the **`groups` arrays** in `PANEL_USERS` (set via admin.html "Users & roles"). Keep a
  `viber-groups.json` (group → canonical key) so renames don't break scoping.

---


Goal: turn the Viber chats where YTF actually does business (dealer orders, payment photos,
warranty complaints, delivery confirmations) into the **same structured ledgers** the cockpit
already reads — with no new app for staff to learn. Viber has **no official read API** for normal
1:1/group chats, so the bridge is **computer-use + an LLM extractor**, mirroring the existing
Gmail/Drive adapters: every source → a generator → the normalized feed.

## Architecture (adapter pattern, unchanged UI)
```
Viber Desktop ──(computer-use: open chat, scroll, screenshot/copy)──▶ raw thread text/images
        │
        ▼
  viber-extract.mjs  ──(LLM: classify + extract to schema)──▶  out/viber-*.csv|json
        │                                                        (orders / payments / claims / delivery)
        ▼
  refresh.mjs (existing chain) ──▶ feed/ ──▶ cockpit modules (Orders, Claims, Payments)
```
The cockpit, search, and module-gating need **zero** changes beyond a new module key + a small
ops.html section — exactly like adding Weekly Stock or MC Production.

## The computer-use bridge (what runs)
1. **Open Viber Desktop** (`open_application`), grant computer-use at full tier.
2. For each watched chat (a config list of dealer/ops group names): open it, scroll the day's
   range, and capture either selected text (preferred — copy to clipboard) or screenshots for OCR.
3. **Extract with an LLM** (you have Claude/OpenAI keys — set `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`
   for the extractor *only*, server-side; the cockpit itself stays no-AI/no-key). The model returns
   strict JSON against the schema below; we keep `source_msg_id`+timestamp for dedupe/audit.
4. **Idempotent merge** by (chat, message id) so re-runs don't double-count; unparseable messages
   are logged, never guessed.

## Data schema (maps onto existing ledgers)
| Viber message kind | → ledger | key fields |
|---|---|---|
| Dealer order ("send 50× 6.50-13") | `orders` (new) | date, dealer, size, qty, channel=viber, status |
| Payment / slip photo | `payments` (new) | date, dealer, amount_mmk, ref, image_ref |
| Warranty complaint (#YGN-…) | existing `claims` | reuses the `#YGN-R…` parser already in extract.mjs |
| Delivery / dispatch confirm | `logistics` (new) | date, order_ref, vehicle, destination |
| Stock / price query | (ignored, or FAQ log) | — |

## What I need from you to build it
- **Viber Desktop installed + signed in** on this PC, and a **computer-use grant** for it.
- The **list of chats** that carry real orders/claims (group names or dealer names).
- An **LLM key** for the extractor (Claude preferred) — I'll store it server-side only, never in the
  cockpit bundle. (Your existing keys work; rotate the ones shared in chat first.)
- Confirmation on **privacy**: messages stay in the private `feed/` (token-gated), same as today.

## Phases
1. **Read-only proof (1 chat):** bridge one dealer group → `orders` ledger → an "Orders" module.
   Verify numbers against what you know. No writing back to Viber.
2. **Watchlist:** config-driven list of chats; daily run folded into the refresh chain.
3. **Two-way (optional, gated):** draft replies/confirmations for you to approve — never auto-send.

## Why not an API
Viber Bot API only covers bots/channels users message, not existing business chats; Viber for
Business/CPaaS is outbound messaging. So inbound history = computer-use is the realistic route,
and it reuses the same OCR/computer-use stack already proven in `apps-bridge` (Viber/LINE → ledgers).
