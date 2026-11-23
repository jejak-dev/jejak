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

## Pembaru otomatis

Dibangun sendiri (`Updater.swift`), memakai kunci dan format manifest yang sama
dengan Tauri (`latest.json`, tanda tangan minisign `tauri signer`, kunci publik
dari `tauri.conf.json` yang ditanam ke Info.plist). Alur: periksa manifest kanal
(stabil/beta) → unduh `.app.tar.gz` → verifikasi minisign (BLAKE2b-512 + Ed25519,
varian "ED") → ekstrak aman → cek bundle id, versi, dan `codesign` → ganti `.app`
secara atomik → mulai ulang setelah proses lama keluar. Cek otomatis 15 detik
setelah mulai lalu tiap 6 jam (bila `autoCheck`).

- Manifest HARUS memuat platform `darwin-<arch>-native`; kunci Tauri
  (`darwin-aarch64`) sengaja diabaikan agar artefak Tauri tak pernah menimpa
  cangkang native. Membuat artefaknya: `scripts/package-update.sh <url>`.
  Menggabungkannya ke `latest.json` rilis = langkah CI yang belum dipasang.
- Debug (`JEJAK_DEBUG=1`): `JEJAK_UPDATE_ENDPOINT` dan `JEJAK_UPDATE_PUBKEY`
  menimpa endpoint (boleh http/file) dan kunci; `JEJAK_UPDATE_SELFTEST=1`
  menjalankan alur periksa→pasang→mulai ulang otomatis dan melapor ke stderr.
  Rilis biasa selalu https dan kunci bawaan.

## Belum ada

Langkah CI yang membuat dan menggabungkan artefak pembaru native ke rilis,
notarisasi, ikon/menu lanjutan, dan paket distribusi (`.dmg`).
