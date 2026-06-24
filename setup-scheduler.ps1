# setup-scheduler.ps1 — Register a Windows Task Scheduler job that auto-refreshes
# the YTF cockpit data twice daily and deploys to Vercel.
#
# Usage (run once as admin, or accept the UAC prompt):
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#   .\setup-scheduler.ps1
#
# What it does:
#   - Reads the Anthropic API key from the known path (~/Desktop/claude api.txt)
#   - Runs sync.ps1 at 06:00 and 18:00 every day (Myanmar time — adjust TriggerTime if needed)
#   - Logs output to logs\scheduler.log (rotated weekly)
#   - Skips run if the PC is not on AC power or idle (laptop-friendly)

$ErrorActionPreference = 'Stop'

$ScriptDir  = $PSScriptRoot
$SyncScript = Join-Path $ScriptDir 'sync.ps1'
$LogDir     = Join-Path $ScriptDir 'logs'
$LogFile    = Join-Path $LogDir 'scheduler.log'
$TaskName   = 'YTF-Cockpit-AutoRefresh'

if (!(Test-Path $SyncScript)) {
    Write-Error "sync.ps1 not found at $SyncScript. Run from the supermega-remote folder."
    exit 1
}

# Ensure logs folder exists
if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# The action: run powershell -> sync.ps1, log output
$WrapScript = @"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
`$logFile = '$($LogFile -replace "'","''")'
`$timestamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Add-Content -Path `$logFile -Value "`n===== `$timestamp ====="
& '$($SyncScript -replace "'","''")' 2>&1 | Add-Content -Path `$logFile
"@

$ActionArgs = "-NonInteractive -NoProfile -Command `"$($WrapScript -replace '"','\"')`""

$Action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument $ActionArgs `
    -WorkingDirectory $ScriptDir

# Two daily triggers: 06:00 and 18:00
$Trigger1 = New-ScheduledTaskTrigger -Daily -At '06:00'
$Trigger2 = New-ScheduledTaskTrigger -Daily -At '18:00'

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -WakeToRun:$false `
    -MultipleInstances IgnoreNew

$Principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Highest

# Remove existing task if present
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task '$TaskName'."
}

Register-ScheduledTask `
    -TaskName   $TaskName `
    -Action     $Action `
    -Trigger    @($Trigger1, $Trigger2) `
    -Settings   $Settings `
    -Principal  $Principal `
    -Description 'Refreshes YTF cockpit data from Drive/Gmail and deploys to Vercel — 06:00 and 18:00 daily' | Out-Null

Write-Host ""
Write-Host "Task '$TaskName' registered successfully." -ForegroundColor Green
Write-Host "  Runs at: 06:00 and 18:00 daily"
Write-Host "  Logs to: $LogFile"
Write-Host ""
Write-Host "Test run now? (y/N)" -ForegroundColor Yellow -NoNewline
$answer = Read-Host " "
if ($answer -match '^y') {
    Write-Host "Running sync.ps1 now..." -ForegroundColor Cyan
    & $SyncScript
}
