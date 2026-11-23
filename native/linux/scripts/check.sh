#!/usr/bin/env bash
# Gerbang: uji inti (di mesin apa pun) + kompilasi jendela GTK di kontainer Linux.
#   scripts/check.sh          uji inti lokal
#   scripts/check.sh ui       tambah kompilasi `--features ui` di Docker (rust:1 + libgtk-3/libwebkit2gtk-4.1)
set -euo pipefail
AKAR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$AKAR/../.." && pwd)"
cd "$AKAR"
cargo test
if [ "${1:-}" = "ui" ]; then
  docker run --rm -v "$REPO:/w" -e CARGO_TARGET_DIR=/tmp/target -w /w/native/linux rust:1 bash -c \
    'apt-get update -qq && apt-get install -y -qq libgtk-3-dev libwebkit2gtk-4.1-dev >/dev/null && cargo build --features ui'
fi
