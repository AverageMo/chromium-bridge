# Registers a per-user scheduled task that starts the bridge server (hidden) at logon.
# No admin rights needed. Remove it with uninstall-autostart.ps1.
$script = Join-Path $PSScriptRoot 'start-bridge.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'ChromeBridgeServer' -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Starts the Chrome Bridge server at logon' -Force | Select-Object TaskName, State
