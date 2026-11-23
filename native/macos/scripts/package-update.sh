#!/usr/bin/env bash
# Membuat artefak pembaruan native: Jejak.app.tar.gz + tanda tangan minisign +
# potongan manifest untuk `latest.json`.
#
#   TAURI_SIGNING_PRIVATE_KEY (isi kunci) atau TAURI_SIGNING_PRIVATE_KEY_PATH
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD (opsional)
#
#   scripts/package-update.sh <url-unduhan-arsip>
#
# Kunci platform manifest sengaja `darwin-<arch>-native` (bukan kunci Tauri)
# supaya cangkang native tak pernah memasang artefak Tauri dan sebaliknya.
# Penggabungan ke latest.json di rilis: scripts/merge-latest.sh (dipanggil CI).
set -euo pipefail
AKAR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$AKAR/../.." && pwd)"
URL="${1:?pakai: package-update.sh <url-unduhan-arsip>}"
APP="$AKAR/build/Jejak.app"
[ -d "$APP" ] || { echo "Jalankan scripts/build-app.sh lebih dulu." >&2; exit 1; }

VERSI="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
ARCH="$(uname -m | sed 's/arm64/aarch64/')"
OUT="$AKAR/build/update"
ARSIP="$OUT/Jejak_${VERSI}_${ARCH}.app.tar.gz"
mkdir -p "$OUT"
# COPYFILE_DISABLE: jangan menyertakan berkas AppleDouble (._*) di arsip.
COPYFILE_DISABLE=1 tar -czf "$ARSIP" -C "$AKAR/build" Jejak.app

(cd "$REPO" && ./node_modules/.bin/tauri signer sign "$ARSIP") >/dev/null
SIG="$(tr -d '\n' < "$ARSIP.sig")"
cat > "$OUT/platform-native.json" <<JSON
{"darwin-${ARCH}-native": {"signature": "${SIG}", "url": "${URL}"}}
JSON
echo "Arsip      : $ARSIP"
echo "Tanda tangan: $ARSIP.sig"
echo "Potongan   : $OUT/platform-native.json (versi $VERSI)"
