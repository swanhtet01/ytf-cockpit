# deploy-demo.ps1 — publish the PUBLIC demo tenant (synthetic data) as its own Vercel project.
# Safe config swap: backs up the YTF config.json, deploys the demo as project "supermega-ops-demo",
# then ALWAYS restores the YTF config (finally block). demo.supermega.dev activates after the NS switch
# (see DNS-MIGRATION.md); until then the printed *.vercel.app URL works immediately.
#
# Run: powershell -ExecutionPolicy Bypass -File deploy-demo.ps1
param([string]$Scope = 'swanhtet01s-projects', [string]$Project = 'supermega-ops-demo')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

node make-demo.mjs

$cfg = 'public/config.json'; $bak = 'public/config.json.ytfbak'
Copy-Item $cfg $bak -Force
try {
  Copy-Item 'public/config.demo.json' $cfg -Force
  Write-Output '== deploy demo project =='
  $out = (npx --yes vercel@latest deploy --prod --yes --name $Project --scope $Scope 2>&1 | Out-String)
  Write-Output $out
  $url = ([regex]'https://[a-z0-9-]+\.vercel\.app').Match($out).Value
  if ($url) {
    Write-Output "demo deployed: $url"
    Write-Output "Set env once if first deploy:  vercel env add PANEL_TOKEN production  (value: demo)  + FEED_PREFIX=demo  (--scope $Scope)"
    npx --yes vercel@latest alias set $url demo.supermega.dev --scope $Scope 2>&1 | Out-String | Write-Output
  }
} finally {
  Copy-Item $bak $cfg -Force; Remove-Item $bak -Force
  Write-Output 'restored YTF public/config.json'
}
