# Registers a Scheduled Task that starts the logger + dashboard at logon, hidden,
# and restarts it if it crashes. A 5-min repeat also brings it back if it was closed without a
# reboot (e.g. a restart that got cancelled); IgnoreNew means it never runs a second copy.
# Remove with: Unregister-ScheduledTask -TaskName EnphaseLive
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

$action = New-ScheduledTaskAction -Execute $node `
  -Argument '--env-file-if-exists=.env --disable-warning=ExperimentalWarning src/server.js' `
  -WorkingDirectory $root
$atLogOn = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$every5Min = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew -Hidden

Register-ScheduledTask -TaskName 'EnphaseLive' -Action $action -Trigger @($atLogOn, $every5Min) -Settings $settings `
  -Description 'Per-second Enphase logger + dashboard (http://localhost:8787)' -Force | Out-Null
Start-ScheduledTask -TaskName 'EnphaseLive'
Write-Host 'EnphaseLive task registered and started. Dashboard: http://localhost:8787'
