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

Write-Host "[1/7] generating SEA blob..."
Push-Location companion
node --experimental-sea-config sea-config.json
Pop-Location

Write-Host "[2/7] bundling rts-companion.exe..."
New-Item -ItemType Directory -Force installer\dist | Out-Null
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe installer\dist\rts-companion.exe -Force
npx --yes postject installer\dist\rts-companion.exe NODE_SEA_BLOB `
  companion\sea-prep.blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# Brand the exe so it is clearly "Raid Team Stats Uploader" everywhere
# in Windows (Task Manager / Explorer / Startup) and runs windowless.
# Version comes from Package.wxs (single source of truth).
$exe = "installer\dist\rts-companion.exe"
# Case-sensitive + 4-part so it matches the <Package Version="x.x.x.x">
# and NOT the lowercase <?xml version="1.0"?> declaration.
$ver = (Select-String -Path installer\Package.wxs -CaseSensitive `
    -Pattern 'Version="(\d+\.\d+\.\d+\.\d+)"' |
  Select-Object -First 1).Matches[0].Groups[1].Value
if (-not $ver) { throw "could not read Package Version= from Package.wxs" }

Write-Host "[3/7] branding rts-companion.exe (windowless + icon + v$ver)..."
# (a) flip PE subsystem CONSOLE(3) -> WINDOWS_GUI(2): no console window
#     from the autostart Run key, and Startup attributes to THIS exe
#     (our name + icon), not wscript.exe.
$b = [System.IO.File]::ReadAllBytes($exe)
$peOff = [System.BitConverter]::ToInt32($b, 0x3C)
if ([System.Text.Encoding]::ASCII.GetString($b, $peOff, 2) -ne "PE") {
  throw "rts-companion.exe is not a valid PE (bad signature)"
}
$subOff = $peOff + 24 + 0x44
$sub = [System.BitConverter]::ToUInt16($b, $subOff)
if ($sub -eq 3) {
  $b[$subOff] = 2; $b[$subOff + 1] = 0
  [System.IO.File]::WriteAllBytes($exe, $b)
  Write-Host "      subsystem CONSOLE -> GUI"
}
elseif ($sub -eq 2) { Write-Host "      subsystem already GUI" }
else { throw "unexpected PE subsystem value: $sub" }
# (b) embed icon + version/product metadata (pure-JS resedit-cli, no
#     native deps). Any code-signing MUST happen AFTER this.
$tmp = "$exe.branded"
npx --yes resedit-cli@2 `
  --in $exe --out $tmp `
  --ignore-signed `
  --icon "1,installer/app.ico" `
  --company-name "Stat Smith" `
  --product-name "Stat Smith" `
  --file-description "Stat Smith Uploader" `
  --product-version $ver `
  --file-version $ver `
  --original-filename "rts-companion.exe" `
  --internal-name "RaidTeamStatsUploader" `
  --legal-copyright "Stat Smith"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) {
  throw "resedit-cli failed to brand rts-companion.exe"
}
Move-Item -Force $tmp $exe
$fi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo((Resolve-Path $exe))
if ($fi.ProductName -ne "Stat Smith" -or
  $fi.FileDescription -ne "Stat Smith Uploader") {
  throw "exe branding not applied (ProductName='$($fi.ProductName)' FileDescription='$($fi.FileDescription)')"
}
Write-Host "      branded: $($fi.FileDescription) v$($fi.FileVersion)"

Write-Host "[4/7] signing rts-companion.exe (if configured)..."
Invoke-Sign $exe

# Gate: MSI custom actions run under CLASSIC JScript (ES3-era engine).
# A single modern-JS construct (trailing comma in a call, let/const/
# arrow/template literal) fails the WHOLE script -> every CA fails
# ("Setup ended prematurely"). Validate with that exact engine.
Write-Host "[5/7] validating ca.js (classic JScript)..."
& cscript //NoLogo //E:JScript installer\ca.js
if ($LASTEXITCODE -ne 0) {
  throw "ca.js failed the classic-JScript syntax check (no trailing commas / let / const / arrow / template literals)."
}

Write-Host "[6/7] building MSI..."
wix build installer\Package.wxs installer\RtsUI.wxs `
  -ext WixToolset.UI.wixext `
  -o installer\dist\raid-team-stats-uploader.msi
if ($LASTEXITCODE -ne 0) { throw "wix build failed (see the WIX error above); MSI not produced." }

Write-Host "[7/7] signing MSI (if configured)..."
Invoke-Sign "installer\dist\raid-team-stats-uploader.msi"

Write-Host "DONE -> installer\dist\raid-team-stats-uploader.msi"
