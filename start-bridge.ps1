# Starts the Chromium Bridge server hidden if it isn't already answering. Safe to run repeatedly.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tokenFile = Join-Path $dir 'token.txt'
$up = $false
if (Test-Path $tokenFile) {
    try {
        $t = (Get-Content $tokenFile -Raw).Trim()
        $port = if ($env:CB_PORT) { $env:CB_PORT } else { '9333' }
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/status" -Headers @{ Authorization = "Bearer $t" } -TimeoutSec 2 | Out-Null
        $up = $true
    } catch { }
}
if ($up) { Write-Host 'bridge already running'; exit 0 }
$exe = Join-Path $dir 'cb.exe'
if (Test-Path $exe) {
    # packaged release: no Node needed
    $run = $exe; $runArgs = 'server'
} else {
    $run = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $run) { $run = 'C:\Program Files\nodejs\node.exe' }
    $runArgs = "`"$(Join-Path $dir 'server.js')`""
}
Start-Process -FilePath $run -ArgumentList $runArgs -WorkingDirectory $dir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
Start-Sleep 2
Write-Host 'bridge started'
