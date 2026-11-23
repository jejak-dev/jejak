# Jejak untuk Linux (cangkang native)

Cangkang tipis: jendela GTK3 + WebKitGTK 4.1 yang memuat server Jejak lokal
(sidecar `jejak serve --desktop`). UI web tidak diubah; kontrak
`window.__TAURI_INTERNALS__.invoke` dipenuhi oleh `src/bridge.rs`. Pola yang
sama dengan `native/macos` dan `native/windows`.

- Pustaka (tanpa GTK, teruji di mesin mana pun): `ready_line`, `token`,
  `navigation` (daftar putih), `locator`, `sidecar` (process group sendiri,
  stdin ditutup = berhenti, lalu `killpg`), `bridge`, `l10n` (id/en).
- `src/main.rs` (fitur `ui`): jendela, splash/galat, WebKit, notifikasi via
  `notify-send`, tautan luar via `xdg-open`.
- Data WebKit: `$XDG_DATA_HOME/jejak/webkit` (cookie sesi persisten).

```bash
scripts/check.sh        # uji inti (cargo test)
scripts/check.sh ui     # + kompilasi jendela GTK di Docker
```

Di mesin Linux: `apt install libgtk-3-dev libwebkit2gtk-4.1-dev`, lalu
`cargo build --release --features ui` (biner `Jejak`; taruh `jejak` di sebelahnya
atau set `JEJAK_SIDECAR`).

## Status
- Inti: 16 tes lulus (termasuk sidecar asli di macOS).
- Jendela: terkompilasi di kontainer `rust:1` dan dijalankan di Xvfb dengan
  sidecar palsu: halaman termuat dan jembatan menjawab `desktop_info` serta
  menolak perintah tak dikenal. Belum dicoba dengan sidecar Bun Linux asli
  dan belum di desktop sungguhan.
- Belum ada: AppImage, simpan ukuran jendela, pembaru untuk pemasangan .deb.

## Pembaru otomatis
Sama dengan macOS/Windows: manifest `latest.json` Tauri v2, minisign (kunci publik dibaca dari
`src-tauri/tauri.conf.json` saat build), kunci platform `linux-<x86_64|aarch64>-native`. Alur:
periksa (thread sendiri, UI tak macet) → unduh tar.gz → verifikasi → ekstrak ke
`$XDG_DATA_HOME/jejak/update` (hanya berkas biasa, tanpa `..`/symlink) → validasi (`Jejak`,
`jejak-server`, berkas `VERSION` cocok manifest). Saat "mulai ulang", berkas disalin ke folder
aplikasi dengan rename atomik (aman untuk biner yang sedang berjalan), lalu `sh` penunggu
menjalankan `Jejak` baru setelah proses lama keluar. Hanya untuk tar.gz di folder yang bisa ditulis;
pemasangan .deb (`/usr/lib/jejak`) dilaporkan "tak bisa ditulis". Teruji (27 tes inti, termasuk server
HTTP lokal dan arsip jahat); alur mulai ulang di desktop sungguhan belum dicoba. Debug:
`JEJAK_DEBUG=1` + `JEJAK_UPDATE_ENDPOINT`/`JEJAK_UPDATE_PUBKEY`.
