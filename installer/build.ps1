# Builds the Raid Team Stats Uploader installer:
#   1. bundles companion/sea-entry.cjs + the Node runtime -> rts-companion.exe
#      (Node 24 Single Executable Application; no Node needed by end users)
#   2. compiles the WiX v6 project -> raid-team-stats-uploader.msi
#
# Prereqs (one-time): Node 18+, .NET SDK, WiX v6 + UI ext:
#   dotnet tool install --global wix --version 6.0.0
#   wix extension add -g WixToolset.UI.wixext/6.0.0
#
# Usage (from repo root or installer/):  pwsh installer/build.ps1
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host "[1/3] generating SEA blob..."
Push-Location companion
node --experimental-sea-config sea-config.json
Pop-Location

Write-Host "[2/3] bundling rts-companion.exe..."
New-Item -ItemType Directory -Force installer\dist | Out-Null
$nodeExe = (Get-Command node).Source
Copy-Item $nodeExe installer\dist\rts-companion.exe -Force
npx --yes postject installer\dist\rts-companion.exe NODE_SEA_BLOB `
  companion\sea-prep.blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

Write-Host "[3/3] building MSI..."
wix build installer\Package.wxs installer\RtsUI.wxs `
  -ext WixToolset.UI.wixext `
  -o installer\dist\raid-team-stats-uploader.msi

Write-Host "DONE -> installer\dist\raid-team-stats-uploader.msi"
