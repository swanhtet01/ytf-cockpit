# SuperMega Remote Agent Guard

This repo is the remote cockpit/control-panel project. It must not deploy or alias the private YTF ERP tenant.

Rules:

- Do not run `vercel alias set ... ytf.supermega.dev` from this repo.
- Do not point `ytf.supermega.dev` at a `supermega-remote-*` deployment.
- Use `ops.supermega.dev` for this repo's live cockpit alias.
- If `ytf.supermega.dev` drifts, repair it from `C:\Users\swann\OneDrive - BDA\Super Mega Inc\supermega-platform` with `npm run ytf:alias:repair`.
- `sync.ps1` intentionally refuses `ytf.supermega.dev`; keep that fail-closed behavior.

Before ending work that touches deploy or domains here, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\sync.ps1 -Domain ytf.supermega.dev
```

That command must fail before refresh/deploy. If it does not fail, fix the guard before doing anything else.
