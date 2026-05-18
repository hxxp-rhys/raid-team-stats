# Builds the Raid Team Stats Uploader installer:
#   1. bundles companion/sea-entry.cjs + the Node runtime -> rts-companion.exe
#      (Node 24 Single Executable Application; no Node needed by end users)
#   2. (optional) Authenticode-signs the exe
#   3. compiles the WiX v6 project -> raid-team-stats-uploader.msi
#   4. (optional) Authenticode-signs the .msi
#
# Prereqs (one-time): Node 18+, .NET SDK, WiX v6 + UI ext:
#   dotnet tool install --global wix --version 6.0.0
#   wix extension add -g WixToolset.UI.wixext/6.0.0
#
# CODE SIGNING (removes the Windows SmartScreen / "unknown publisher"
# warning — see installer/SIGNING.md). Dormant until you set ONE of:
#   $env:RTS_SIGN_THUMBPRINT  - SHA1 thumbprint of a cert in the local store
#   $env:RTS_SIGN_PFX (+ $env:RTS_SIGN_PFX_PW) - path to a .pfx + password
# Optional: $env:RTS_SIGN_TS  - RFC3161 timestamp URL (default DigiCert).
# Needs signtool.exe (Windows SDK) on PATH. Without these the build still
# succeeds; the installer is just unsigned.
#
# Usage (from repo root or installer/):  pwsh installer/build.ps1
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Invoke-Sign($file) {
  $thumb = $env:RTS_SIGN_THUMBPRINT
  $pfx = $env:RTS_SIGN_PFX
  if (-not $thumb -and -not $pfx) {
    Write-Host "      (unsigned - set RTS_SIGN_THUMBPRINT or RTS_SIGN_PFX to sign)"
    return
  }
  $st = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
  if (-not $st) {
    $st = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" `
      -ErrorAction SilentlyContinue | Select-Object -Last 1 -Expand FullName
  }
  if (-not $st) { throw "signtool.exe not found (install the Windows SDK)." }
  $ts = if ($env:RTS_SIGN_TS) { $env:RTS_SIGN_TS } else { "http://timestamp.digicert.com" }
  $a = @("sign", "/fd", "SHA256", "/tr", $ts, "/td", "SHA256")
  if ($thumb) { $a += @("/sha1", $thumb) }
  else { $a += @("/f", $pfx); if ($env:RTS_SIGN_PFX_PW) { $a += @("/p", $env:RTS_SIGN_PFX_PW) } }
  $a += $file
  & $st @a
  if ($LASTEXITCODE -ne 0) { throw "signtool failed for $file" }
  Write-Host "      signed: $file"
}

Write-Host "[1/5] generating SEA blob..."
Push-Location companion
node --experimental-sea-config sea-config.json
Pop-Location

Write-Host "[2/5] bundling rts-companion.exe..."
New-Item -ItemType Directory -Force installer\dist | Out-Null
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe installer\dist\rts-companion.exe -Force
npx --yes postject installer\dist\rts-companion.exe NODE_SEA_BLOB `
  companion\sea-prep.blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
Invoke-Sign "installer\dist\rts-companion.exe"

# Gate: the MSI custom actions run under CLASSIC JScript (ES3-era engine,
# NOT Node/modern JS). It rejects things modern JS allows — most notably
# trailing commas in function-call argument lists — and a single syntax
# error makes EVERY custom action fail ("Setup ended prematurely, system
# not modified"). Validate with the very same engine before shipping.
Write-Host "[3/5] validating ca.js (classic JScript)..."
& cscript //NoLogo //E:JScript installer\ca.js
if ($LASTEXITCODE -ne 0) {
  throw "ca.js failed the classic-JScript syntax check. The MSI scripting host is ES3 JScript: no trailing commas in calls, no let/const/arrow/template literals."
}

Write-Host "[4/5] building MSI..."
wix build installer\Package.wxs installer\RtsUI.wxs `
  -ext WixToolset.UI.wixext `
  -o installer\dist\raid-team-stats-uploader.msi

Write-Host "[5/5] signing MSI (if configured)..."
Invoke-Sign "installer\dist\raid-team-stats-uploader.msi"

Write-Host "DONE -> installer\dist\raid-team-stats-uploader.msi"
