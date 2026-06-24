# supermega.dev DNS → Vercel nameservers (safe migration runbook)

**Why:** `ops.supermega.dev` / `demo.supermega.dev` (and `ytf-ops`) live in Vercel's DNS zone but are
**dormant** — supermega.dev's registrar nameservers still point at Google/Squarespace, so only records
at *that* provider resolve (which is why `ytf.supermega.dev` works and `ops` doesn't). Squarespace has
no public DNS API (confirmed: `/domains`→404), so the fix is to move the **nameservers** to Vercel.

**The risk:** switching nameservers makes Vercel's zone authoritative for the WHOLE domain. Anything
NOT re-created in the Vercel zone first **stops resolving** — most dangerously **email (MX / SPF / DKIM
/ DMARC)** and `ytf.supermega.dev`. The Vercel `*` wildcard ALIAS covers subdomains for web, but **not
MX/TXT**. Do the capture step or email breaks.

## Already in the Vercel zone (Claude added, dormant)
`ops` → cname.vercel-dns.com · `demo` → cname.vercel-dns.com · `ytf-ops` (6d) · apex + `*` wildcard ALIAS.

## Runbook (do in order — do NOT switch NS first)
1. **Capture the current zone** from Squarespace/Google-Domains DNS for supermega.dev. Export/screenshot
   EVERY record: A/AAAA/ALIAS (apex), all CNAMEs, **MX**, **TXT** (SPF `v=spf1…`, DKIM `*._domainkey`,
   DMARC `_dmarc`), any verification TXT, and `ytf` if it's an explicit record.
2. **Re-create the non-web records in the Vercel zone** (`vercel dns add supermega.dev <name> <type> <value>`):
   - **Codex's lane:** `ytf` (CNAME `cname.vercel-dns.com` — confirm `ytf.supermega.dev` is a domain on the
     `supermega-ytf` project so Vercel routes it), and any platform/POS subdomains.
   - **Email (whoever owns it):** every MX, the SPF TXT, DKIM TXT, DMARC TXT — exactly as captured.
   - **Verification TXTs** (Google site verification, etc.).
3. **Confirm project-domain assignments** (these route the resolved name): `ops`→supermega-remote,
   `demo`→the demo project, `ytf`→supermega-ytf. (`vercel domains inspect <host>`.)
4. **Switch nameservers** at Squarespace → `ns1.vercel-dns.com` + `ns2.vercel-dns.com`. Propagation ~mins–hrs.
5. **Verify** after propagation: `ops.supermega.dev` (200, cockpit), `ytf.supermega.dev` (200, ERP),
   `demo.supermega.dev` (200), and **send a test email** to a supermega.dev address (MX intact).
   Vercel auto-issues certs once each host resolves to it.

## Coordination
This is cross-lane (Claude owns ops/demo; Codex owns ytf + platform). Per `AGENTS.md §6`: re-create the
ytf + email records (steps 1–2) **before** anyone flips the nameservers. Until the switch, the cockpit
is reachable at `supermega-remote-swanhtet01s-projects.vercel.app`.

## Alternative (no NS switch)
If you'd rather not move nameservers, add a single record at the **current** provider (Squarespace DNS):
`CNAME  ops  →  cname.vercel-dns.com` (and `demo` likewise). That resolves ops/demo without touching the
rest of the zone — lower blast radius, but you keep managing DNS in two places.
