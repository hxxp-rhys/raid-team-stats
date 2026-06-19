# Builds the Raid Team Stats Uploader installer:
#   1. bundles companion/sea-entry.cjs + the Node runtime -> rts-companion.exe
#      (Node 24 Single Executable Application; no Node needed by end users)
#   2. publishes the system-tray helper (tray/RtsTray.csproj) -> rts-tray.exe
#      (self-contained single-file win-x64 .NET 8 WinForms; no runtime needed)
#   3. (optional) Authenticode-signs both exes
#   4. compiles the WiX v6 project -> raid-team-stats-uploader.msi
#   5. (optional) Authenticode-signs the .msi
#
# Prereqs (one-time): Node 20+ (Single Executable App), .NET SDK, WiX v6 + UI ext:
#   dotnet tool install --global wix --version 6.0.0
#   wix extension add -g WixToolset.UI.wixext/6.0.0
#
# CODE SIGNING (removes the Windows SmartScreen / "unknown publisher"
# warning - see installer/SIGNING.md). Two independent ways:
#  (a) LOCAL cert via signtool - dormant until you set ONE of:
#        $env:RTS_SIGN_THUMBPRINT  - SHA1 thumbprint of a cert in the store
#        $env:RTS_SIGN_PFX (+ $env:RTS_SIGN_PFX_PW) - a .pfx path + password
#      Optional: $env:RTS_SIGN_TS - RFC3161 timestamp URL (default DigiCert).
#      Needs signtool.exe (Windows SDK) on PATH.
#  (b) AZURE Artifact Signing (cloud, no local key) - done in CI by the
#      Azure/artifact-signing-action, NOT inside this script. Because WiX
#      embeds the exe INTO the MSI at build time, the exe must be signed
#      BEFORE the MSI is built. So CI runs this script in two stages:
#        pwsh installer/build.ps1 -Stage exe   # branded, unsigned exe
#        <action signs installer/dist/rts-companion.exe>
#        pwsh installer/build.ps1 -Stage msi   # packs the signed exe -> MSI
#        <action signs the MSI>
# Without any of the above the build still succeeds; the installer is unsigned.
#
# Usage (local, one pass):  pwsh installer/build.ps1
param([ValidateSet("all", "exe", "msi")][string]$Stage = "all")
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Invoke-Sign($file) {
  $thumb = $env:RTS_SIGN_THUMBPRINT
  $pfx = $env:RTS_SIGN_PFX
  if (-not $thumb -and -not $pfx) {
    Write-Host "      (unsigned here - set RTS_SIGN_THUMBPRINT/RTS_SIGN_PFX for a local cert, or sign via Azure in CI)"
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

$exe = "installer\dist\rts-companion.exe"
$tray = "installer\dist\rts-tray.exe"
$msi = "installer\dist\raid-team-stats-uploader.msi"

# ---- exe stages (1-5): build, brand, build tray, optionally local-sign ----
if ($Stage -ne "msi") {
  Write-Host "[1/7] generating SEA blob..."
  Push-Location companion
  node --experimental-sea-config sea-config.json
  Pop-Location

  Write-Host "[2/7] bundling rts-companion.exe..."
  New-Item -ItemType Directory -Force installer\dist | Out-Null
  $nodeExe = (Get-Command node).Source
  Copy-Item $nodeExe $exe -Force
  npx --yes postject $exe NODE_SEA_BLOB `
    companion\sea-prep.blob `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

  # Brand the exe so it is clearly "Raid Team Stats Uploader" everywhere
  # in Windows (Task Manager / Explorer / Startup) and runs windowless.
  # Version comes from Package.wxs (single source of truth).
  # Case-sensitive + 4-part so it matches the <Package Version="x.x.x.x">
  # and NOT the lowercase <?xml version="1.0"?> declaration.
  $ver = (Select-String -Path installer\Package.wxs -CaseSensitive `
      -Pattern 'Version="(\d+\.\d+\.\d+\.\d+)"' |
    Select-Object -First 1).Matches[0].Groups[1].Value
  if (-not $ver) { throw "could not read Package Version= from Package.wxs" }

  # Drift guard: the companion's self-reported COMPANION_VERSION must match the
  # MSI version it ships in (sea-entry.cjs is the twin compiled into the exe).
  $cv = (Select-String -Path companion\sea-entry.cjs `
      -Pattern 'COMPANION_VERSION\s*=\s*"([^"]+)"' |
    Select-Object -First 1).Matches[0].Groups[1].Value
  if ($cv -ne $ver) {
    throw "COMPANION_VERSION ('$cv') in companion/sea-entry.cjs != Package.wxs Version ('$ver'). Bump them in lockstep."
  }

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
    --company-name "Raid Team Stats" `
    --product-name "Raid Team Stats" `
    --file-description "Raid Team Stats Uploader" `
    --product-version $ver `
    --file-version $ver `
    --original-filename "rts-companion.exe" `
    --internal-name "RaidTeamStats" `
    --legal-copyright "Raid Team Stats"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) {
    throw "resedit-cli failed to brand rts-companion.exe"
  }
  Move-Item -Force $tmp $exe
  $fi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo((Resolve-Path $exe))
  if ($fi.ProductName -ne "Raid Team Stats" -or
    $fi.FileDescription -ne "Raid Team Stats Uploader") {
    throw "exe branding not applied (ProductName='$($fi.ProductName)' FileDescription='$($fi.FileDescription)')"
  }
  Write-Host "      branded: $($fi.FileDescription) v$($fi.FileVersion)"

  # Build the system-tray helper (Phase 4): a self-contained, single-file,
  # win-x64 .NET WinForms NotifyIcon app (tray\RtsTray.csproj). It is installed
  # ALONGSIDE rts-companion.exe and drives it via the loopback control server.
  # The exe is named rts-tray.exe (AssemblyName in the csproj) and is dropped
  # into installer\dist next to rts-companion.exe so the next step signs both,
  # and so CI's Azure signing (which targets the whole installer\dist folder
  # with files-folder-filter "exe") auto-signs it with NO workflow change.
  Write-Host "[4/8] building rts-tray.exe (self-contained single-file win-x64 v$ver)..."
  $trayTmp = Join-Path $env:TEMP "rts-tray-publish"
  if (Test-Path $trayTmp) { Remove-Item -Recurse -Force $trayTmp }
  dotnet publish tray\RtsTray.csproj -c Release -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:Version=$ver `
    -o $trayTmp
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed for tray\RtsTray.csproj" }
  $trayBuilt = Join-Path $trayTmp "rts-tray.exe"
  if (-not (Test-Path $trayBuilt)) { throw "tray publish did not produce rts-tray.exe" }
  Copy-Item $trayBuilt $tray -Force
  Write-Host "      tray: $tray"

  # Local code-signing (CI's Azure step signs the whole installer\dist folder
  # with files-folder-filter "exe", so it picks up BOTH rts-companion.exe and
  # rts-tray.exe automatically -- no workflow change needed).
  Write-Host "[5/8] signing exes (local cert only; Azure signs the whole dist folder in CI between stages)..."
  Invoke-Sign $exe
  Invoke-Sign $tray
}

# ---- msi stages (6-8): validate CA, build MSI, optionally local-sign ----
if ($Stage -ne "exe") {
  if (-not (Test-Path $exe)) {
    throw "$exe not found - run 'build.ps1 -Stage exe' (and sign it) before -Stage msi."
  }

  # Gate: MSI custom actions run under CLASSIC JScript (ES3-era engine).
  # A single modern-JS construct (trailing comma in a call, let/const/
  # arrow/template literal) fails the WHOLE script -> every CA fails
  # ("Setup ended prematurely"). Validate with that exact engine.
  Write-Host "[6/8] validating ca.js (classic JScript)..."
  & cscript //NoLogo //E:JScript installer\ca.js
  if ($LASTEXITCODE -ne 0) {
    throw "ca.js failed the classic-JScript syntax check (no trailing commas / let / const / arrow / template literals)."
  }

  Write-Host "[7/8] building MSI..."
  wix build installer\Package.wxs installer\RtsUI.wxs `
    -ext WixToolset.UI.wixext `
    -o $msi
  if ($LASTEXITCODE -ne 0) { throw "wix build failed (see the WIX error above); MSI not produced." }

  Write-Host "[8/8] signing MSI (local cert only; Azure signs in CI)..."
  Invoke-Sign $msi
}

if ($Stage -eq "exe") { Write-Host "DONE (exe stage) -> $exe" }
else { Write-Host "DONE -> $msi" }
