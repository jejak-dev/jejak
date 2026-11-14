#!/bin/sh
# Pemasang Jejak untuk macOS.
#
# Memasang Jejak.app ke ~/Applications tanpa sudo, memakai manifest rilis
# (latest.json) yang sama dengan pembaru di dalam aplikasi. Hanya macOS.
#
# Variabel lingkungan:
#   JEJAK_INSTALL_DIR       folder tujuan (bawaan ~/Applications)
#   JEJAK_CHANNEL           "stable" (bawaan) atau "beta"
#   JEJAK_LATEST_JSON_URL   alamat manifest rilis (bawaan per kanal)
#   JEJAK_INSTALL_TEST      "1" mengizinkan URL file:// untuk pengujian
#
# Tidak memakai eval, tidak memakai `curl | sh`, dan tidak menyentuh ~/.jejak.

set -eu

NAMA_APLIKASI="Jejak"
NAMA_BINER="jejak"
URL_STABIL="https://github.com/jejak-dev/jejak/releases/latest/download/latest.json"
URL_BETA="https://github.com/jejak-dev/jejak/releases/download/beta/latest.json"
URL_RILIS="https://github.com/jejak-dev/jejak/releases"

gagal() {
  printf 'jejak: %s\n' "$1" >&2
  exit 1
}

bantuan() {
  cat <<'EOF'
jejak — pemasang Jejak untuk macOS

Pakai:
  curl -fsSL https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh | sh

Pilihan:
  --help              tampilkan pesan ini
  --uninstall         hapus Jejak.app (data di ~/.jejak tidak dihapus)
  --purge-data        bersama --uninstall: hapus juga ~/.jejak setelah konfirmasi

Variabel lingkungan:
  JEJAK_INSTALL_DIR       folder tujuan (bawaan ~/Applications)
  JEJAK_CHANNEL           "stable" (bawaan) atau "beta"
  JEJAK_LATEST_JSON_URL   alamat manifest rilis (bawaan per kanal)
EOF
}

# --------------------------------------------------------------------------
# Argumen
# --------------------------------------------------------------------------

mode="pasang"
purge_data="0"

while [ "$#" -gt 0 ]; do
  argumen="$1"
  case "$argumen" in
    --help|-h)
      bantuan
      exit 0
      ;;
    --uninstall)
      mode="lepas"
      ;;
    --purge-data)
      purge_data="1"
      ;;
    --)
      shift
      break
      ;;
    *)
      printf 'jejak: argumen tak dikenal: %s\n' "$argumen" >&2
      bantuan >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$purge_data" = "1" ] && [ "$mode" != "lepas" ]; then
  gagal "--purge-data hanya dipakai bersama --uninstall."
fi

# --------------------------------------------------------------------------
# Platform dan arsitektur
# --------------------------------------------------------------------------

sistem="$(uname -s)"
if [ "$sistem" != "Darwin" ]; then
  case "$sistem" in
    MINGW*|MSYS*|CYGWIN*)
      gagal "install.sh hanya berjalan di macOS. Untuk Windows, unduh installer .exe dari $URL_RILIS (rilis Windows masih beta)."
      ;;
    *)
      gagal "install.sh hanya berjalan di macOS. Untuk Linux, jalankan Jejak dari sumber: bun install && bun run start."
      ;;
  esac
fi

mesin="$(uname -m)"
case "$mesin" in
  arm64|aarch64) platform="darwin-aarch64" ;;
  x86_64) platform="darwin-x86_64" ;;
  *) gagal "Arsitektur macOS tak didukung: $mesin" ;;
esac

command -v curl >/dev/null 2>&1 || gagal "curl tak ditemukan. Pasang curl lalu ulangi."

# --------------------------------------------------------------------------
# Folder tujuan dan folder sementara
# --------------------------------------------------------------------------

dir_tujuan="${JEJAK_INSTALL_DIR:-$HOME/Applications}"
dir_tujuan="$(cd "$dir_tujuan" 2>/dev/null && pwd || printf '%s' "$dir_tujuan")"
tujuan="$dir_tujuan/$NAMA_APLIKASI.app"

sementara="$(mktemp -d)"
bersihkan() {
  rm -rf "$sementara"
}
trap bersihkan EXIT INT TERM

# --------------------------------------------------------------------------
# Skema URL: hanya https (file:// khusus pengujian)
# --------------------------------------------------------------------------

skema_boleh() {
  case "$1" in
    https://*) return 0 ;;
    file://*)
      if [ "${JEJAK_INSTALL_TEST:-}" = "1" ]; then
        return 0
      fi
      return 1
      ;;
    *) return 1 ;;
  esac
}

# --------------------------------------------------------------------------
# Manifest rilis
# --------------------------------------------------------------------------

kanal="${JEJAK_CHANNEL:-stable}"
case "$kanal" in
  stable) url_manifest_bawaan="$URL_STABIL" ;;
  beta) url_manifest_bawaan="$URL_BETA" ;;
  *) gagal "Kanal rilis tak dikenal: $kanal (pilihan: stable, beta)." ;;
esac

url_manifest="${JEJAK_LATEST_JSON_URL:-$url_manifest_bawaan}"

# --------------------------------------------------------------------------
# Lepas pasang
# --------------------------------------------------------------------------

konfirmasi() {
  if [ ! -t 0 ]; then
    printf 'jejak: konfirmasi tak bisa dibaca (bukan terminal); dibatalkan.\n' >&2
    return 1
  fi
  printf '%s' "$1"
  IFS= read -r jawaban || jawaban=""
  case "$jawaban" in
    y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$mode" = "lepas" ]; then
  if [ -e "$tujuan" ]; then
    rm -rf "$tujuan"
    printf '%s.app dihapus dari %s\n' "$NAMA_APLIKASI" "$dir_tujuan"
  else
    printf '%s.app tak ada di %s\n' "$NAMA_APLIKASI" "$dir_tujuan"
  fi
  if [ "$purge_data" = "1" ]; then
    if konfirmasi "Hapus juga data Jejak di $HOME/.jejak? (y/N) "; then
      rm -rf "$HOME/.jejak"
      printf 'Data Jejak di %s/.jejak dihapus.\n' "$HOME"
    elif [ ! -t 0 ]; then
      printf 'Data Jejak di %s/.jejak tidak dihapus.\n' "$HOME"
      exit 1
    else
      printf 'Data Jejak di %s/.jejak tidak dihapus.\n' "$HOME"
    fi
  else
    printf 'Data Jejak di %s/.jejak tidak dihapus. Pakai --purge-data untuk menghapusnya.\n' "$HOME"
  fi
  exit 0
fi

# --------------------------------------------------------------------------
# Unduh manifest dan arsip
# --------------------------------------------------------------------------

if ! skema_boleh "$url_manifest"; then
  gagal "Alamat manifest harus https:// (atau file:// bila JEJAK_INSTALL_TEST=1): $url_manifest"
fi

berkas_manifest="$sementara/latest.json"
if ! curl -fsSL --retry 3 -o "$berkas_manifest" "$url_manifest"; then
  gagal "Gagal mengunduh manifest rilis: $url_manifest"
fi

tab="$(printf '\t')"

baca_manifest() {
  osascript -l JavaScript -e '
function run(argv) {
  var berkas = $.NSURL.fileURLWithPath(argv[0]);
  var data = $.NSData.dataWithContentsOfURL(berkas);
  if (data === null || data === undefined) { throw new Error("latest.json tak terbaca"); }
  var teks = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  var isi = JSON.parse(teks);
  var platforms = isi.platforms || {};
  var kunci = argv[1];
  var entri = platforms[kunci + "-app"] || platforms[kunci] || null;
  if (entri === null) { throw new Error("entri platform tak ditemukan: " + kunci); }
  var versi = isi.version === undefined || isi.version === null ? "" : String(isi.version);
  return String(entri.url) + "\t" + versi;
}
' "$1" "$platform"
}

if ! baris="$(baca_manifest "$berkas_manifest" 2>"$sementara/galat-manifest.txt")"; then
  cat "$sementara/galat-manifest.txt" >&2 || true
  gagal "latest.json tak bisa dibaca atau entri platform $platform tak ditemukan."
fi

url_arsip="${baris%%"$tab"*}"
versi="${baris#*"$tab"}"

if [ -z "$url_arsip" ]; then
  gagal "latest.json tak memuat alamat unduhan untuk $platform."
fi
if ! skema_boleh "$url_arsip"; then
  gagal "Alamat unduhan harus https:// (atau file:// bila JEJAK_INSTALL_TEST=1): $url_arsip"
fi

arsip="$sementara/jejak.app.tar.gz"
if ! curl -fsSL --retry 3 -o "$arsip" "$url_arsip"; then
  gagal "Gagal mengunduh arsip Jejak: $url_arsip"
fi

ekstrak="$sementara/ekstrak"
mkdir -p "$ekstrak"
if ! tar -xzf "$arsip" -C "$ekstrak"; then
  gagal "Arsip Jejak tak bisa diekstrak: $url_arsip"
fi

aplikasi="$ekstrak/$NAMA_APLIKASI.app"
if [ ! -f "$aplikasi/Contents/MacOS/$NAMA_BINER" ]; then
  gagal "Arsip tak berisi $NAMA_APLIKASI.app/Contents/MacOS/$NAMA_BINER."
fi

# curl tak memberi atribut karantina, jadi langkah ini aman bila gagal.
xattr -dr com.apple.quarantine "$aplikasi" 2>/dev/null || true

# --------------------------------------------------------------------------
# Pasang (ganti installation lama secara aman)
# --------------------------------------------------------------------------

mkdir -p "$dir_tujuan"

lama="$sementara/lama.app"
ada_lama="0"
if [ -e "$tujuan" ]; then
  mv "$tujuan" "$lama"
  ada_lama="1"
fi

if ! mv "$aplikasi" "$tujuan"; then
  if [ "$ada_lama" = "1" ]; then
    mv "$lama" "$tujuan" 2>/dev/null || true
  fi
  gagal "Gagal memasang $NAMA_APLIKASI.app ke $dir_tujuan."
fi

if [ "$ada_lama" = "1" ]; then
  rm -rf "$lama"
fi

# --------------------------------------------------------------------------
# Ringkasan
# --------------------------------------------------------------------------

if [ -z "$versi" ]; then
  versi="tak diketahui"
fi

printf '\n'
printf 'Jejak %s terpasang.\n' "$versi"
printf 'Lokasi: %s\n' "$tujuan"
printf 'Buka: open "%s"\n' "$tujuan"
printf 'Data Jejak (sesi, memory, kunci penyedia) ada di %s/.jejak\n' "$HOME"
