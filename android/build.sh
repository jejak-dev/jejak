#!/usr/bin/env bash
# Membangun APK klien tipis Jejak tanpa Gradle.
# Kebutuhan: JDK 17, Android SDK (platform android-36) dan build-tools terpasang.
# Hasil: android/build/jejak.apk. Tanda tangan: env JEJAK_KEYSTORE (+ _PASSWORD, _ALIAS)
# untuk rilis, atau kunci debug lokal android/.keystore bila env kosong.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="${ANDROID_BUILD_TOOLS:-$(ls -d "$SDK"/build-tools/* /opt/homebrew/share/android-commandlinetools/build-tools/* 2>/dev/null | sort -V | tail -1 || true)}"
JAR="$(ls "$SDK"/platforms/android-*/android.jar | sort -V | tail -1)"
[ -d "$BT" ] || { echo "build-tools tidak ditemukan (sdkmanager \"build-tools;36.0.0\")" >&2; exit 1; }

VERSI="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../src-tauri/tauri.conf.json | head -1)"
KODE="$(( ($(date +%s) - 1767225600) / 60 ))"  # menit sejak 2026-01-01, selalu naik
OUT=build
rm -rf "$OUT"; mkdir -p "$OUT/res" "$OUT/classes"

"$BT/aapt2" compile --dir src/main/res -o "$OUT/res"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" \
  --manifest src/main/AndroidManifest.xml \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-name "$VERSI" --version-code "$KODE" \
  "$OUT"/res/*.flat

javac --release 17 -classpath "$JAR" -d "$OUT/classes" \
  $(find src/main/java -name '*.java')
"$BT/d8" --min-api 24 --lib "$JAR" --output "$OUT" $(find "$OUT/classes" -name '*.class')

(cd "$OUT" && zip -q base.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/base.apk" "$OUT/jejak-aligned.apk"

# Penandatanganan: keystore rilis lewat env (CI), atau kunci debug lokal.
# Tanda tangan harus sama di setiap rilis, kalau tidak Android menolak pembaruan.
if [ -n "${JEJAK_KEYSTORE:-}" ]; then
  [ -f "$JEJAK_KEYSTORE" ] || { echo "JEJAK_KEYSTORE tidak ditemukan: $JEJAK_KEYSTORE" >&2; exit 1; }
  : "${JEJAK_KEYSTORE_PASSWORD:?JEJAK_KEYSTORE_PASSWORD wajib diisi}"
  "$BT/apksigner" sign --ks "$JEJAK_KEYSTORE" --ks-key-alias "${JEJAK_KEY_ALIAS:-jejak}" \
    --ks-pass env:JEJAK_KEYSTORE_PASSWORD \
    --out "$OUT/jejak.apk" "$OUT/jejak-aligned.apk"
else
  if [ ! -f .keystore ]; then
    keytool -genkeypair -keystore .keystore -storepass android -keypass android \
      -alias jejak -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Jejak Debug"
  fi
  "$BT/apksigner" sign --ks .keystore --ks-pass pass:android --key-pass pass:android \
    --out "$OUT/jejak.apk" "$OUT/jejak-aligned.apk"
fi
"$BT/apksigner" verify "$OUT/jejak.apk"
echo "OK: android/$OUT/jejak.apk ($VERSI)"
