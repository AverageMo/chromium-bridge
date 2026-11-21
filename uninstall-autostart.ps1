# Removes the logon task created by install-autostart.ps1.
Unregister-ScheduledTask -TaskName 'ChromeBridgeServer' -Confirm:$false
Write-Host 'autostart removed'
