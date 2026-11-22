# Chromium Bridge one-line installer for Windows.
#
#   irm https://raw.githubusercontent.com/AverageMo/chromium-bridge/main/install.ps1 | iex
#
# What it does, in full:
#   1. downloads this repo's current main branch as a zip from github.com (nothing else is fetched)
#   2. unpacks it into %LOCALAPPDATA%\ChromiumBridge (re-running updates the files and keeps your token)
#   3. runs setup.ps1 from there (Node check, optional start-at-logon, starts the server, opens Chrome's
#      extensions page). Read setup.ps1 to see exactly what that does.
# It does not need admin rights and does not touch anything outside that folder, except the optional logon task.
#
# Test hooks: $env:CB_INSTALL_DIR overrides the install folder; $env:CB_SETUP_FLAGS passes flags to setup.ps1.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$repo = 'AverageMo/chromium-bridge'
$dest = if ($env:CB_INSTALL_DIR) { $env:CB_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'ChromiumBridge' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('chromium-bridge-' + [Guid]::NewGuid().ToString('N'))

try {
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $zip = Join-Path $tmp 'src.zip'
    Write-Host "Downloading https://github.com/$repo ..." -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/archive/refs/heads/main.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'setup.ps1'))) { throw 'The download did not look like Chromium Bridge.' }

    New-Item -ItemType Directory -Force $dest | Out-Null
    Copy-Item -Path (Join-Path $src.FullName '*') -Destination $dest -Recurse -Force
    Write-Host "Installed to $dest" -ForegroundColor Green
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$flags = if ($env:CB_SETUP_FLAGS) { $env:CB_SETUP_FLAGS -split '\s+' } else { @() }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dest 'setup.ps1') @flags
