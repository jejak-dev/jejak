#!/usr/bin/env bash
# Menggabungkan potongan platform native (platform-native.json dari
# package-update.sh) ke latest.json milik tauri-action.
#
#   scripts/merge-latest.sh <latest.json> <potongan.json>... > latest.baru.json
#
# Hanya kunci berakhiran `-native` yang boleh ditambahkan, supaya entri Tauri
# tak pernah tertimpa. Gagal bila latest.json tak punya `version`/`platforms`.
set -euo pipefail
LATEST="${1:?pakai: merge-latest.sh <latest.json> <potongan.json>...}"
shift
[ "$#" -ge 1 ] || { echo "butuh minimal satu potongan" >&2; exit 2; }

jq -e '.version and (.platforms | type == "object")' "$LATEST" >/dev/null \
  || { echo "latest.json tak valid: $LATEST" >&2; exit 1; }

for P in "$@"; do
  jq -e 'to_entries | length > 0 and all(.[]; (.key | test("^(darwin|windows|linux)-[a-z0-9_]+-native$")) and (.value.signature | type == "string" and length > 0) and (.value.url | type == "string" and startswith("https://")))' "$P" >/dev/null \
    || { echo "potongan tak valid: $P" >&2; exit 1; }
done

jq -s '.[0] as $dasar | reduce .[1:][] as $p ($dasar; .platforms += $p)' "$LATEST" "$@"
