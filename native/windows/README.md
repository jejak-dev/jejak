# Jejak untuk Windows (cangkang native)

Cangkang tipis: jendela WPF + WebView2 sistem yang memuat server Jejak lokal
(sidecar `jejak serve --desktop`). UI web tidak diubah; kontrak
`window.__TAURI_INTERNALS__.invoke` dipenuhi oleh `Bridge.cs`. Pola yang sama
dengan `native/macos`.

- `src/JejakShellCore` (net8.0): ReadyLine, token, daftar putih navigasi, pencari
  biner, `SidecarProcess` (stdin ditutup = berhenti; pohon proses dimatikan;
  Job Object KILL_ON_JOB_CLOSE di Windows), i18n id/en (`Localization.cs`).
- `src/JejakDesktop` (net8.0-windows): `MainWindow` (splash/galat/WebView2),
  `Bridge` (desktop_info, notifikasi, pembaru), `Notifier` (balon NotifyIcon).
- `tests/JejakShellCore.Tests`: harness uji mini; berjalan di Mac/Linux.

```bash
scripts/check.sh    # uji inti + kompilasi app WPF (butuh .NET 8 SDK resmi)
```

Di Windows: `pwsh scripts/build-app.ps1` (butuh `jejak.exe` hasil `bun run build:binary`).

## Belum ada
- Pembaru otomatis (perintah `updater_*` mengembalikan "belum tersedia").
- Pemasang (installer), tanda tangan kode, simpan ukuran/posisi jendela.
- App WPF belum pernah dijalankan di Windows sungguhan; baru terkompilasi dan
  inti teruji (18 tes, termasuk sidecar asli di macOS).
