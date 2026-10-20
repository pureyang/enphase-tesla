# Registers a Scheduled Task that starts the logger + dashboard at logon, hidden,
# and restarts it if it crashes. Remove with: Unregister-ScheduledTask -TaskName EnphaseLive
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

$action = New-ScheduledTaskAction -Execute $node `
  -Argument '--env-file-if-exists=.env --disable-warning=ExperimentalWarning src/server.js' `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden

Register-ScheduledTask -TaskName 'EnphaseLive' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Per-second Enphase logger + dashboard (http://localhost:8787)' -Force | Out-Null
Start-ScheduledTask -TaskName 'EnphaseLive'
Write-Host 'EnphaseLive task registered and started. Dashboard: http://localhost:8787'
