# Cangkang native macOS Jejak

Jendela tipis Swift 6 + AppKit + WKWebView yang menjalankan sidecar
`jejak serve --desktop` dan memuat UI web yang sama dengan Tauri. Pola mengikuti
cangkang Kabmo (`packages/macos`): tanpa runtime tertanam, tanpa kerangka
tengah. Pengganti `src-tauri` di macOS; Windows dan Linux menyusul.

## Isi

- `Sources/JejakShellCore`: logika murni (baris `JEJAK_READY`, token, daftar
  putih navigasi, pelacak biner, `SidecarProcess` dengan process group sendiri).
- `Sources/jejak-desktop`: AppKit (jendela, splash/galat, menu, jembatan).
- Jembatan halaman: `window.__TAURI_INTERNALS__.invoke` dipenuhi cangkang
  (info versi, notifikasi native); klien web tidak diubah.

## Build dan uji

```bash
bun run build:binary && bun run stage:sidecar   # sidecar segar (jangan pakai yang usang)
bash scripts/build-core.sh test                 # build core + 17 tes
bash scripts/build-app.sh                       # build/Jejak.app (ad-hoc signed)
open build/Jejak.app
```

Skrip memakai `swiftc` langsung, bukan `swift build`: pada Command Line Tools
yang tak serasi (SDK lebih baru dari compiler) `swift-package` gagal dimuat dan
`swiftc` perlu `SDKROOT` lama; `scripts/env.sh` memilihnya otomatis. swift-testing
juga tak bisa dipakai di sana, jadi tes memakai harness mini (`Tests/.../Harness.swift`).
`Package.swift` dipertahankan untuk mesin dengan toolchain yang sehat.

## Bahasa (id/en)

Teks tampilan lewat `L("kunci", "teks bawaan Indonesia")` (`Localization.swift`);
tabelnya di `Resources/{id,en}.lproj/Localizable.strings`, mengikuti bahasa
sistem (coba: `open build/Jejak.app --args -AppleLanguages "(en)"`). Menambah
teks = tambah kunci di KEDUA tabel; `scripts/check-strings.sh` (dijalankan
`build-app.sh`) gagal bila kunci tak sama atau ada kunci kode yang tak
terdaftar. Teks bawaan di kode menjaga pesan tetap terbaca bila tabel tak
ada (mis. tes di luar bundel .app).

## Belum ada

Pembaruan otomatis (perintah `updater_*` mengembalikan keadaan `idle`), notarisasi,
ikon/menu lanjutan, dan paket distribusi (`.dmg`).
