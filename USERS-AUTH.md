# SuperMega Ops — Users & Auth model (grounded in supermega-remote)

## Where auth lives today (the real code)

- **One gate, one secret per tenant.** `api/control.js` lines 143-150: every action requires the `x-panel-token` header to `timingSafeEqual` the single `PANEL_TOKEN` env var. There is no user identity — only "knows the passcode / doesn't." `CRON_TOKEN` (the thing that actually triggers live jobs) is server-only and never reaches the browser.
- **Client side** (`public/index.html`): the passcode is typed once, stored in `localStorage['sm_remote_token']` (`LS_KEY`, line 237), sent on every `api()` call (line 248). "Session" = whatever's in localStorage; "expiry" = a 401 from the server triggers `lock()` (lines 424, 454). No real expiry, no rotation, no record of who unlocked.
- **Per-tenant isolation is deployment-level**: one Vercel project per tenant, own `PANEL_TOKEN`/`FEED_PREFIX` env, own `public/config.json`, own bundled `feed/`. `config.json.modules.*` already gates *which tiles/sections/search-sources render* (`MOD()` in index.html line 212; mirrored server-side in `pipeline.mjs`).
- **`entry.html` has no auth and no audit at all** — it's pure client-side localStorage (`LS='ytf_entries'`, line 82), export-to-file only. It never calls `/api/control`. Each record already stamps `entered_at` + a local id (line 173) but there is no "who".
- **Constraint to preserve**: no third-party AI in the cockpit (the `api/ask.js` Ask-AI path was deliberately deleted), data stays private per tenant. Any auth must stay self-contained — no external IdP/SaaS that sees tenant data.
- **Don't rebuild the ERP's auth**: per `PRODUCT.md`, Codex's `supermega-ytf` already has "role auth" for the heavy daily-entry ERP. This cockpit is the *thin read+trigger layer*; keep its auth minimal and independent.

## Recommendation: keep the passcode, add named roles (Option C) — phased

Per-user accounts and magic-link both pull a user store / email sender into a project whose whole selling point (PRODUCT.md §5) is "no per-client cost, no data leaving the tenant, cheaper to run." They're the wrong first step. The minimal-change path that actually delivers the asked-for capability (owner-only job triggers, viewer-only views, audit of who did what) is **multiple named passcodes, each carrying a role** — same header gate, same env-based secrets, no DB.

### Why not the alternatives (first pass)
| Option | Cost vs constraint | Verdict |
|---|---|---|
| Per-user accounts (password DB) | Needs a user store + password hashing + reset flow per tenant — new stateful infra | Later, only if a tenant demands real identity |
| Magic-link | Needs an email sender wired into each private tenant deploy; links are a new exfil surface | Defer |
| **Passcode + named roles** | **Reuses the exact `timingSafeEqual` gate; secrets stay env-only; zero new infra** | **Do this first** |

### Phase 1 — roles via multiple tokens (minimal change, all server-side)
Replace the single `PANEL_TOKEN` with a small env-driven role map. Keep `timingSafeEqual`; just loop over entries and return the matched role.

- **New env (per tenant Vercel project)**, e.g. `PANEL_USERS` = JSON or a compact line list:
  `owner:tok_owner_xxx;manager:tok_mgr_xxx;operator:tok_op_xxx;viewer:tok_view_xxx`
  Keep `PANEL_TOKEN` as a back-compat fallback mapped to `owner` so existing deploys don't break.
- **`control.js` auth block (lines 143-150)** becomes: parse the map once at module load → on each request, `timingSafeEqual` the provided header against each token (constant-time, iterate all to avoid early-exit timing) → resolve `role` or 401.
- **Role → capability table**, defined server-side as the single source of truth:
  | Role | status/data (read) | search | `run` (trigger jobs) | which jobs |
  |---|---|---|---|---|
  | viewer | yes | yes | no | — |
  | operator | yes | yes | yes | pipeline group only (`JOB_META.group==='pipeline'`) |
  | manager | yes | yes | yes | pipeline + insight |
  | owner | yes | yes | yes | all (incl. `agents` group, supermega-* jobs) |
- **Gate `run` by role** (the explicit ask "only owner triggers jobs"): in the `action==='run'` branch (control.js line 186), after resolving the job, check `JOB_META[job].group` against the role's allowed groups; else `403`. This reuses the *existing* `group` field on every job — no new metadata.
- **Surface role to the client** so the UI hides what it can't use: `action==='jobs'` and a tiny `action==='whoami'` return the caller's `role` + allowed groups. `index.html` `loadJobs()` (line 433) renders only permitted job cards; viewers get the read-only cockpit (status/ops/search) with the Pipeline/Insight/agents sections hidden. This is the *same* mechanism as the existing `MOD()` module-toggle — role-gating layers on top of module-gating (a section shows only if `MOD(x) && roleAllows(group)`).

### Phase 1b — sessions & expiry (still no DB)
Today "session" = a raw secret sitting in localStorage forever. Tighten without a user store:
- On unlock, instead of storing the raw token, have `control.js` issue a **short-lived signed session cookie/token** (HMAC of `{role, tenant, iat, exp}` signed with a new `SESSION_SECRET` env, `crypto` only — already imported). `tryUnlock` (index.html line 256) stores *that*, not the passcode. Verify the HMAC + `exp` on each request alongside (or instead of) the passcode check.
- Gives real **expiry** (e.g. 12h), lets `lock()` (line 370) stay client-only, and means the long-lived passcode isn't sitting in every browser. Optional `httpOnly` cookie instead of localStorage closes the XSS-token-theft hole. Keep `cache-control: no-store` (already set, line 135).

### Phase 2 — audit (the "who entered what" ask)
Two distinct audit needs:

1. **Action audit (who triggered which job / unlocked).** Add a server-side append log in `control.js`. Since the function is stateless on Vercel, write to **Vercel KV/Blob** (the same store the memory notes already flag as the path for cloud refresh) or, minimally, structured `console.log` lines (Vercel runtime logs, queryable) for: `{ts, role, action, job, http_status, ip_hash}`. Emit it in the `run` branch right where it already builds the result object (line 206) and on unlock/401. No PII beyond a hashed IP.
2. **Data-entry attribution (`entry.html`).** Right now records have `entered_at` but no author and never leave the device. To get "who entered what":
   - Add an author field stamped from the session role/handle into each `rec` at save (line 172-176) — e.g. `rec.by = sessionHandle`.
   - Optionally add a token-gated `action==='entry'` POST to `control.js` so entries can be submitted through the same gate (carrying role) and appended to the tenant's Blob/KV log, instead of (or in addition to) the manual JSON/CSV export → `ytf-ops-tools/manual-entries/` flow. Keeps the no-AI, no-third-party posture: it's the tenant's own serverless function writing to the tenant's own store.

### How it maps to what exists (no rewrite)
- **Same gate**: still header-only `x-panel-token` + `timingSafeEqual`; just N tokens not 1.
- **Same module system**: role-gating composes with `config.json.modules` / `MOD()` — modules decide *what data exists*, roles decide *who can see/trigger it*.
- **Same deployment model**: roles are env vars per Vercel project; `admin.html` (the tenant console) gains a "Users & roles" card that mirrors `PANEL_USERS` the way it already mirrors `config.json` / `new-client.mjs` (client-side generator, copy/paste into Vercel env).
- **Privacy intact**: no external IdP, no email sender, no shared user DB — every secret and log stays inside the tenant's own Vercel project.

### Watch-outs
- Iterate *all* tokens on each auth check (don't early-return on first mismatch) to keep timing constant.
- The CSP (`vercel.json`) is `connect-src 'self'` — good; any session/audit store must be reached server-side from `control.js`, not from the browser, or it breaks CSP and the privacy posture.
- `localStorage` token is readable by any injected script; the 2026-06-22 pass already fixed several DOM-XSS holes — moving to an `httpOnly` session cookie (Phase 1b) is the durable fix.
- Don't let `entry.html` POST without the role gate, or you reintroduce an unauthenticated write path.


## Next build steps
- In api/control.js, replace the single PANEL_TOKEN check (lines 143-150) with a PANEL_USERS env map (role:token;...), keeping PANEL_TOKEN as an owner fallback; resolve a `role` per request via constant-time compare over all entries.
- Add a server-side role→allowed-job-groups table and gate the `run` branch (control.js line 186) by JOB_META[job].group, returning 403 for disallowed roles (e.g. operator can't run `agents`/supermega-* jobs; only owner runs all).
- Add `action==='whoami'` and include `role`+allowed groups in the `jobs` response so index.html loadJobs() (line 433) and the section renderers hide job cards/sections the role can't use, layered on the existing MOD() toggles.
- Introduce SESSION_SECRET + HMAC-signed short-lived session tokens issued on unlock; change tryUnlock (index.html line 256) to store the session token (or httpOnly cookie) instead of the raw passcode, giving real expiry.
- Add an append-only action audit in control.js (Vercel KV/Blob or structured console.log) writing {ts, role, action, job, status, ip_hash} at the run-result build site (line 206) and on unlock/401.
- Stamp an author/role onto entry.html records at save (lines 172-176) and add an optional token-gated `action==='entry'` POST so data-entry is attributed and logged through the same gate, preserving the no-third-party/private-per-tenant constraint.
