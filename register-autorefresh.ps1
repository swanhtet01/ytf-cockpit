# register-autorefresh.ps1 — set up hands-off daily refresh of the ops cockpit on THIS PC.
# Registers a Windows Scheduled Task that runs sync.ps1 (pull Drive via service account ->
# refresh feed -> deploy -> alias ops.supermega.dev) once a day. Works while the PC is on.
# (For a PC-independent option, use the GitHub Actions workflow instead — see
#  .github-workflow-refresh-cockpit.yml.)
#
# Run once, in an ADMIN PowerShell:  powershell -ExecutionPolicy Bypass -File register-autorefresh.ps1
# Remove later:  Unregister-ScheduledTask -TaskName 'SuperMega YTF cockpit refresh' -Confirm:$false

param(
  [string]$Time = '07:30',                                   # local time to run daily
  [string]$TaskName = 'SuperMega YTF cockpit refresh'
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$sync = Join-Path $scriptDir 'sync.ps1'
if (-not (Test-Path $sync)) { throw "sync.ps1 not found next to this script ($sync)" }

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$sync`"" -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
  -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Pull latest Yangon Tyre Drive data and publish the ops cockpit (ops.supermega.dev).' -Force | Out-Null

Write-Output "Registered '$TaskName' — runs daily at $Time."
Write-Output "Test it now:  Start-ScheduledTask -TaskName '$TaskName'"
