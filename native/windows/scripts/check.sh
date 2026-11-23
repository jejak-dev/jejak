#!/usr/bin/env bash
# Gerbang di Mac/Linux: uji inti + kompilasi app WPF (tanpa menjalankannya).
#   scripts/check.sh            (JEJAK_REAL_SIDECAR=<biner> menambah uji sidecar asli)
# Perlu .NET 8 SDK resmi (dotnet-install.sh); paket Homebrew tak membawa target WindowsDesktop.
set -euo pipefail
AKAR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$AKAR"
dotnet run --project tests/JejakShellCore.Tests -c Release
dotnet build src/JejakDesktop -c Release
