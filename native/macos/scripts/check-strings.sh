#!/usr/bin/env bash
# Memastikan tabel bahasa konsisten: kunci id dan en sama persis, dan setiap
# kunci L("...") di kode ada di tabel.
set -euo pipefail
AKAR="$(cd "$(dirname "$0")/.." && pwd)"
kunci() { sed -n 's/^"\([^"]*\)" = .*/\1/p' "$1" | sort; }
ID="$(kunci "$AKAR/Resources/id.lproj/Localizable.strings")"
EN="$(kunci "$AKAR/Resources/en.lproj/Localizable.strings")"
gagal=0
if [ "$ID" != "$EN" ]; then
  echo "Kunci id dan en berbeda:" >&2
  diff <(echo "$ID") <(echo "$EN") >&2 || true
  gagal=1
fi
KODE="$(grep -rhoE 'L\("[a-z_.]+"' "$AKAR/Sources" | sed -E 's/L\("//; s/"$//' | sort -u)"
HILANG="$(comm -23 <(echo "$KODE") <(echo "$ID"))"
if [ -n "$HILANG" ]; then
  echo "Kunci di kode tapi tak ada di tabel:" >&2
  echo "$HILANG" >&2
  gagal=1
fi
[ "$gagal" -eq 0 ] && echo "Tabel bahasa konsisten ($(echo "$ID" | wc -l | tr -d ' ') kunci)."
exit "$gagal"
