#!/usr/bin/env bash
# Membangun biner `jejak-desktop` dan merakit build/Jejak.app (ad-hoc signed).
#
# Memakai swiftc langsung (lihat build-core.sh untuk alasannya). Variabel:
#   JEJAK_SIDECAR  binary sidecar yang disalin ke Contents/MacOS/jejak
#                  (bawaan: src-tauri/binaries/jejak-aarch64-apple-darwin)
set -euo pipefail
AKAR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$AKAR/../.." && pwd)"
# shellcheck source=env.sh
source "$AKAR/scripts/env.sh"
OUT="$AKAR/.build/manual"
APP="$AKAR/build/Jejak.app"
mkdir -p "$OUT"

# Core dan UI dalam satu modul: tanpa `import JejakShellCore` (lihat canImport).
swiftc -swift-version 5 -O -module-name JejakDesktop \
  -o "$OUT/jejak-desktop" \
  "$AKAR"/Sources/JejakShellCore/*.swift "$AKAR"/Sources/jejak-desktop/*.swift \
  -framework AppKit -framework WebKit -framework UserNotifications

PUBKEY="$(sed -n 's/.*"pubkey": *"\([^"]*\)".*/\1/p' "$REPO/src-tauri/tauri.conf.json" | head -1)"
VERSI="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/package.json" | head -1)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OUT/jejak-desktop" "$APP/Contents/MacOS/jejak-desktop"
cp "$REPO/src-tauri/icons/icon.icns" "$APP/Contents/Resources/icon.icns"
cp "$REPO/src-tauri/shim/notification.js" "$APP/Contents/Resources/notification.js"
bash "$AKAR/scripts/check-strings.sh"
for lproj in "$AKAR"/Resources/*.lproj; do
  cp -R "$lproj" "$APP/Contents/Resources/"
done

SIDECAR="${JEJAK_SIDECAR:-$REPO/src-tauri/binaries/jejak-aarch64-apple-darwin}"
if [ -f "$SIDECAR" ]; then
  cp "$SIDECAR" "$APP/Contents/MacOS/jejak"
  chmod +x "$APP/Contents/MacOS/jejak"
else
  echo "PERINGATAN: sidecar tak ditemukan ($SIDECAR); aplikasi tak akan bisa memulai server." >&2
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>id</string>
  <key>CFBundleLocalizations</key><array><string>id</string><string>en</string></array>
  <key>CFBundleExecutable</key><string>jejak-desktop</string>
  <key>CFBundleIdentifier</key><string>io.github.jejak-dev.jejak.native</string>
  <key>CFBundleName</key><string>Jejak</string>
  <key>CFBundleDisplayName</key><string>Jejak</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSI}</string>
  <key>CFBundleVersion</key><string>${VERSI}</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>JejakUpdatePubKey</key><string>${PUBKEY}</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Jejak memakai mikrofon untuk dikte.</string>
</dict></plist>
PLIST

# Sidecar Bun butuh JIT; tanda tangani sidecar dulu, lalu aplikasi (ad-hoc).
if [ -f "$APP/Contents/MacOS/jejak" ]; then
  codesign --force --options runtime --entitlements "$AKAR/Entitlements.plist" -s - "$APP/Contents/MacOS/jejak"
fi
codesign --force --options runtime --entitlements "$AKAR/Entitlements.plist" -s - "$APP"
codesign --verify --deep --strict "$APP"
echo "Jejak.app siap: $APP"
