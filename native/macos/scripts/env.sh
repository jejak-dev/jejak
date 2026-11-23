# Memilih SDK yang cocok dengan compiler Swift yang terpasang.
#
# Command Line Tools di beberapa mesin berisi SDK yang lebih baru dari compiler
# (mis. SDK 27 untuk Swift 6.3), sehingga `swift build` dan `swiftc` gagal
# memuat modul Swift. Skrip ini memilih SDK tertinggi yang kompatibel.
# Dipakai dengan `source scripts/env.sh`.

if [ -z "${SDKROOT:-}" ]; then
  for versi in 26.5 26.4 26.3 26.2 26.1 26.0 26 15.5 15.4 15; do
    kandidat="/Library/Developer/CommandLineTools/SDKs/MacOSX${versi}.sdk"
    if [ -d "$kandidat" ]; then
      SDKROOT="$kandidat"
      break
    fi
  done
fi
export SDKROOT
