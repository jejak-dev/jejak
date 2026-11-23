#!/usr/bin/env bash
# Mengemas Jejak untuk Linux: arsip tar.gz (taruh di mana saja) dan .deb.
#
#   scripts/package.sh <biner-Jejak> <sidecar-jejak> <amd64|arm64> [versi]
#
# Hasil di native/linux/build/: Jejak-native_<versi>_<arch>-linux.tar.gz dan
# jejak_<versi>_<arch>.deb (bila dpkg-deb ada). Tata letak deb:
#   /usr/lib/jejak/{Jejak,jejak-server}   /usr/bin/jejak-desktop -> ../lib/jejak/Jejak
#   /usr/share/applications/jejak.desktop   /usr/share/icons/hicolor/128x128/apps/jejak.png
set -euo pipefail
AKAR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$AKAR/../.." && pwd)"
APP="${1:?pakai: package.sh <biner-Jejak> <sidecar-jejak> <amd64|arm64> [versi]}"
SIDECAR="${2:?sidecar}"
ARCH="${3:?arsitektur amd64|arm64}"
VERSI="${4:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/package.json" | head -1)}"
[ -f "$APP" ] && [ -f "$SIDECAR" ] || { echo "biner tak ditemukan" >&2; exit 1; }
# Sidecar bernama jejak-server: `Jejak` dan `jejak` hanya beda huruf besar, bentrok di sistem berkas case-insensitive.
# Versi Debian: prarilis memakai "~" supaya mengurut sebelum rilis stabil.
DEBVER="${VERSI/-/\~}"
OUT="$AKAR/build"
rm -rf "$OUT"; mkdir -p "$OUT"

# 1) tar.gz: folder Jejak/ berisi Jejak, jejak-server, ikon.
ST="$OUT/stage/Jejak"
mkdir -p "$ST"
install -m 755 "$APP" "$ST/Jejak"
install -m 755 "$SIDECAR" "$ST/jejak-server"
install -m 644 "$REPO/src-tauri/icons/128x128.png" "$ST/jejak.png"
tar -czf "$OUT/Jejak-native_${VERSI}_${ARCH}-linux.tar.gz" -C "$OUT/stage" Jejak
echo "Arsip: $OUT/Jejak-native_${VERSI}_${ARCH}-linux.tar.gz"

# 2) .deb
if command -v dpkg-deb >/dev/null 2>&1; then
  D="$OUT/deb"
  mkdir -p "$D/DEBIAN" "$D/usr/lib/jejak" "$D/usr/bin" "$D/usr/share/applications" "$D/usr/share/icons/hicolor/128x128/apps"
  install -m 755 "$APP" "$D/usr/lib/jejak/Jejak"
  install -m 755 "$SIDECAR" "$D/usr/lib/jejak/jejak-server"
  ln -s ../lib/jejak/Jejak "$D/usr/bin/jejak-desktop"
  install -m 644 "$REPO/src-tauri/icons/128x128.png" "$D/usr/share/icons/hicolor/128x128/apps/jejak.png"
  cat > "$D/usr/share/applications/jejak.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Jejak
Comment=Jejak
Exec=jejak-desktop
Icon=jejak
Terminal=false
Categories=Development;
StartupWMClass=Jejak
DESK
  SIZE="$(du -sk "$D" | cut -f1)"
  cat > "$D/DEBIAN/control" <<CTL
Package: jejak
Version: ${DEBVER}
Section: devel
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${SIZE}
Depends: libgtk-3-0, libwebkit2gtk-4.1-0
Maintainer: Jejak <noreply@users.noreply.github.com>
Description: Jejak (cangkang native)
 Jendela GTK dan WebKitGTK di sekitar server Jejak lokal.
CTL
  dpkg-deb --build --root-owner-group "$D" "$OUT/jejak_${DEBVER}_${ARCH}.deb" >/dev/null
  echo "Deb  : $OUT/jejak_${DEBVER}_${ARCH}.deb"
fi
