#!/usr/bin/env bash
# Membangun dan menguji JejakShellCore memakai swiftc langsung.
#
# `swift build` / `swift test` (SwiftPM) rusak pada Command Line Tools yang
# tidak serasi (swift-package gagal dimuat dyld), jadi jalur ini tidak
# bergantung padanya. Package.swift tetap dipertahankan untuk mesin yang sehat.
#
#   scripts/build-core.sh           bangun saja
#   scripts/build-core.sh test      bangun dan jalankan tes (swift-testing)
set -euo pipefail
AKAR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
source "$AKAR/scripts/env.sh"
OUT="$AKAR/.build/manual"
mkdir -p "$OUT"
FW="/Library/Developer/CommandLineTools/Library/Developer/Frameworks"

swiftc -swift-version 6 -parse-as-library -wmo -enable-testing \
  -module-name JejakShellCore -emit-module -emit-module-path "$OUT/JejakShellCore.swiftmodule" \
  -emit-library -static -o "$OUT/libJejakShellCore.a" \
  "$AKAR"/Sources/JejakShellCore/*.swift
echo "Core terbangun: $OUT/libJejakShellCore.a"

if [ "${1:-}" = "test" ]; then
  # Harness uji mini; swift-testing/XCTest tak serasi dengan CLT di sebagian mesin.
  swiftc -swift-version 6 -enable-testing -I "$OUT" -L "$OUT" -lJejakShellCore \
    -o "$OUT/CoreTests" "$AKAR"/Tests/JejakShellCoreTests/*.swift
  "$OUT/CoreTests"
fi
