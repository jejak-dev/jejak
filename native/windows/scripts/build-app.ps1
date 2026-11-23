# Membangun Jejak untuk Windows: publish app (framework-dependent, satu folder)
# lalu menempatkan sidecar `jejak-server.exe` di sebelah Jejak.exe.
#
#   pwsh scripts/build-app.ps1 [-Sidecar <jalur jejak.exe>] [-Runtime win-x64|win-arm64]
#
# Sidecar bawaan: src-tauri/binaries/jejak-<triple>.exe (bun run build:binary + stage:sidecar).
param(
  [string]$Sidecar = "",
  [string]$Runtime = "win-x64"
)
$ErrorActionPreference = "Stop"
$akar = Split-Path -Parent $PSScriptRoot
$repo = Resolve-Path (Join-Path $akar "../..")
$triple = if ($Runtime -eq "win-arm64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
if (-not $Sidecar) { $Sidecar = Join-Path $repo "src-tauri/binaries/jejak-$triple.exe" }
if (-not (Test-Path $Sidecar)) { throw "Sidecar tak ditemukan: $Sidecar" }

$out = Join-Path $akar "build/Jejak"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
dotnet publish (Join-Path $akar "src/JejakDesktop") -c Release -r $Runtime --self-contained false -o $out
if ($LASTEXITCODE -ne 0) { throw "dotnet publish gagal" }
# Bukan jejak.exe: NTFS tak membedakan huruf besar/kecil, sehingga akan menimpa Jejak.exe.
Copy-Item $Sidecar (Join-Path $out "jejak-server.exe")
Write-Host "Jejak siap: $out\Jejak.exe"
