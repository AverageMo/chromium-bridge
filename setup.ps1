# Chrome Bridge guided setup for Windows. Run it by double-clicking setup.bat.
#
# What it does:
#   1. makes sure Node.js 18+ is installed (offers to install it with winget)
#   2. optionally registers a logon task so the server starts by itself
#   3. starts the server (this creates the token and extension/config.js)
#   4. opens Chrome's extensions page, puts the extension folder path on your clipboard,
#      and waits until the extension reports in
#
# Chrome does not allow scripts to load extensions, so the "Load unpacked" click is yours.
param(
    [switch]$SkipAutostart,   # don't offer the logon task
    [switch]$NoBrowser,       # don't open Chrome or Explorer
    [switch]$NoWait           # don't wait for the extension to connect
)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = if ($env:CB_PORT) { $env:CB_PORT } else { '9333' }

function Step($n, $text) { Write-Host ''; Write-Host "[$n/4] $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "      $text" -ForegroundColor Green }
function Info($text) { Write-Host "      $text" }

function Get-NodeExe {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = 'C:\Program Files\nodejs\node.exe'
    if (Test-Path $p) { return $p }
    return $null
}
function Get-NodeMajor($exe) {
    try { return [int](((& $exe --version) -replace '^v', '').Split('.')[0]) } catch { return 0 }
}

Write-Host 'Chrome Bridge setup' -ForegroundColor White
Write-Host 'This lets local scripts drive your logged-in Chrome. Read the Security section of the README first if unsure.'

# 1. Node ----------------------------------------------------------------------------------------
Step 1 'Checking for Node.js 18 or newer'
$node = Get-NodeExe
if (Test-Path (Join-Path $dir 'cb.exe')) {
    Ok 'this is the packaged release (cb.exe), so Node.js is not needed'
} elseif ($node -and (Get-NodeMajor $node) -ge 18) {
    Ok "found $(& $node --version) at $node"
} else {
    if ($node) { Info "found Node $(& $node --version), which is too old." } else { Info 'Node.js is not installed.' }
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        $a = Read-Host '      Install the current Node.js LTS now with winget? [Y/n]'
        if ($a -eq '' -or $a -match '^[yY]') {
            & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
            # pick up the new PATH in this window
            $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
            $node = Get-NodeExe
        }
    }
    if (-not $node -or (Get-NodeMajor $node) -lt 18) {
        Write-Host '      Install Node.js LTS from https://nodejs.org/ and run setup.bat again.' -ForegroundColor Yellow
        exit 1
    }
    Ok "using $(& $node --version) at $node"
}

# 2. Autostart -----------------------------------------------------------------------------------
Step 2 'Start at logon (optional)'
if ($SkipAutostart) {
    Info 'skipped'
} else {
    $a = Read-Host '      Start the bridge server automatically when you log in to Windows? [Y/n]'
    if ($a -eq '' -or $a -match '^[yY]') {
        & (Join-Path $dir 'install-autostart.ps1') | Out-Null
        Ok 'logon task "ChromeBridgeServer" registered (remove it with uninstall-autostart.ps1)'
    } else {
        Info "no problem: start it yourself with  powershell -File start-bridge.ps1  (or  node server.js)"
    }
}

# 3. Server --------------------------------------------------------------------------------------
Step 3 'Starting the server'
& (Join-Path $dir 'start-bridge.ps1') *> $null
$config = Join-Path $dir 'extension\config.js'
$tokenFile = Join-Path $dir 'token.txt'
for ($i = 0; $i -lt 20 -and -not ((Test-Path $config) -and (Test-Path $tokenFile)); $i++) { Start-Sleep -Milliseconds 500 }
if (-not ((Test-Path $config) -and (Test-Path $tokenFile))) {
    Write-Host "      The server didn't start. Look at server.err.log in $dir" -ForegroundColor Red
    exit 1
}
$token = (Get-Content $tokenFile -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }
Ok "server is running on 127.0.0.1:$port (it only listens on your own machine)"

# 4. Extension -----------------------------------------------------------------------------------
Step 4 'Load the extension into Chrome (two clicks, Chrome makes you do these yourself)'
$extDir = Join-Path $dir 'extension'
try { Set-Clipboard -Value $extDir } catch { }
$already = $false
try { $already = (Invoke-RestMethod -Uri "http://127.0.0.1:$port/status" -Headers $headers -TimeoutSec 2).connected } catch { }
if ($already) {
    Ok 'an extension is already connected, so you may be finished. Nothing to load.'
} else {
    Info 'In the Chrome tab that opens:'
    Info '   1. turn on "Developer mode" (top right)'
    Info '   2. click "Load unpacked" and choose this folder (its path is on your clipboard, so you can paste it):'
    Write-Host "        $extDir" -ForegroundColor White
    if (-not $NoBrowser) {
        $chrome = $null
        foreach ($p in @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                         "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                         "$env:LocalAppData\Google\Chrome\Application\chrome.exe")) {
            if (Test-Path $p) { $chrome = $p; break }
        }
        if ($chrome) { Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions' }
        else { Info '(could not find Chrome; open chrome://extensions yourself)' }
        Start-Process explorer.exe -ArgumentList "`"$extDir`""
    }
    if (-not $NoWait) {
        Write-Host ''
        Info 'Waiting for the extension to connect (up to 3 minutes, Ctrl+C to stop waiting)...'
        $deadline = (Get-Date).AddMinutes(3)
        $connected = $false
        while ((Get-Date) -lt $deadline) {
            try { if ((Invoke-RestMethod -Uri "http://127.0.0.1:$port/status" -Headers $headers -TimeoutSec 2).connected) { $connected = $true; break } } catch { }
            Start-Sleep -Seconds 2
        }
        if ($connected) { Ok 'connected! The extension badge should say "on".' }
        else { Write-Host '      Not connected yet. Finish loading the extension, then run:  node cb.js status' -ForegroundColor Yellow }
    }
}

Write-Host ''
$tryCmd = if (Test-Path (Join-Path $dir 'cb.exe')) { 'cb.exe tabs' } else { 'node cb.js tabs' }
Write-Host "Done. Try:  $tryCmd     (README has the rest)" -ForegroundColor White
