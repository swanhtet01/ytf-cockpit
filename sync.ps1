# sync.ps1 - one command to refresh the remote cockpit data and publish it live.
#   0) node pull-drive.mjs    -> pull the latest Drive workbooks via the service account (self-serve).
#   1) node refresh.mjs       -> rebuilds the private feed/ from the latest data.
#   2) vercel deploy --prod   -> publishes this remote cockpit project.
#   3) vercel alias set       -> points the remote cockpit domain at the deployment.
#
# This project must not own ytf.supermega.dev. That domain belongs to the YTF ERP
# deployment in ../Super Mega Inc/supermega-platform.
param(
  [string]$Domain = 'ops.supermega.dev',
  [string]$Scope = 'swanhtet01s-projects',
  # Path to the Google service-account JSON (Drive read). Override or set GOOGLE_SA_KEY_FILE / GOOGLE_SA_KEY.
  [string]$SaKeyFile = "$env:USERPROFILE\Downloads\keystore\supermega-468612-9c08e1ed3bb4.json",
  # File containing the Anthropic key (for the whiteboard-photo OCR step only; cockpit stays no-AI).
  [string]$AnthropicKeyFile = "$env:USERPROFILE\OneDrive - BDA\Desktop\claude api.txt"
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$protectedDomains = @('ytf.supermega.dev', 'www.ytf.supermega.dev')
if ($protectedDomains -contains $Domain) {
  throw "Refusing to alias $Domain from supermega-remote. Use the YTF deploy guard in ../Super Mega Inc/supermega-platform: npm run ytf:alias:repair"
}

Write-Output '== 0/3 pull latest Drive files (service account) =='
if (-not $env:GOOGLE_SA_KEY -and -not $env:GOOGLE_SA_KEY_FILE -and (Test-Path $SaKeyFile)) { $env:GOOGLE_SA_KEY_FILE = $SaKeyFile }
if ($env:GOOGLE_SA_KEY -or $env:GOOGLE_SA_KEY_FILE) {
  try { node ../ytf-ops-tools/pull-drive.mjs } catch { Write-Output "  (pull-drive failed; using cached drive-cache) $_" }
} else {
  Write-Output '  (no service-account key found; skipping live pull, using cached drive-cache)'
}

# Anthropic key for the whiteboard-photo OCR step (whiteboard-ocr.mjs self-skips if unset).
if (-not $env:ANTHROPIC_API_KEY -and (Test-Path $AnthropicKeyFile)) {
  $m = Select-String -Path $AnthropicKeyFile -Pattern 'sk-ant-api03-[A-Za-z0-9_-]+' | Select-Object -First 1
  if ($m) { $env:ANTHROPIC_API_KEY = $m.Matches[0].Value; Write-Output '  (loaded ANTHROPIC_API_KEY for OCR)' }
}

Write-Output '== 1/3 refresh feed =='
node refresh.mjs

Write-Output '== 2/3 deploy prod =='
$out = (npx --yes vercel@latest deploy --prod --yes --scope $Scope 2>&1 | Out-String)
$prod = ([regex]'https://supermega-remote-[a-z0-9]+-' + $Scope + '\.vercel\.app').Match($out).Value
if (-not $prod) {
  Write-Output $out
  throw 'Could not parse production URL from deploy output.'
}
Write-Output "deployed: $prod"

Write-Output "== 3/3 alias $Domain =="
npx --yes vercel@latest alias set $prod $Domain --scope $Scope

Write-Output "DONE -> https://$Domain"
