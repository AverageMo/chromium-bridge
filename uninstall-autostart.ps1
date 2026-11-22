# Removes the logon task created by install-autostart.ps1.
Unregister-ScheduledTask -TaskName 'ChromiumBridgeServer' -Confirm:$false
Write-Host 'autostart removed'
