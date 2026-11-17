# Memasang Jejak

Jejak tersedia sebagai aplikasi desktop untuk macOS dan Windows. Halaman ini
menjelaskan pemasangan, peringatan jujur yang akan Anda temui, letak data Anda,
dan cara mencabut aplikasinya lagi.

- [Persyaratan](#persyaratan)
- [Pemasangan di macOS](#pemasangan-di-macos)
- [Peringatan Gatekeeper di macOS](#peringatan-gatekeeper-di-macos)
- [Pemasangan di Windows (beta)](#pemasangan-di-windows-beta)
- [Windows (beta): batasan](#windows-beta-batasan)
- [Pembaruan otomatis](#pembaruan-otomatis)
- [Letak data Anda](#letak-data-anda)
- [Mengatasi masalah](#mengatasi-masalah)
- [Mencabut pemasangan](#mencabut-pemasangan)

## Persyaratan

- **macOS 12 (Monterey) atau lebih baru.** Build tersedia untuk Apple silicon
  dan Intel.
- **Windows x64.** Build Windows ditandai **beta** dan tidak ditandatangani
  dengan sertifikat vendor, jadi SmartScreen akan memperingatkan Anda.
- Untuk menjalankan Jejak dari sumber, bukan sebagai aplikasi: **Bun 1.4 atau
  lebih baru**.

## Pemasangan di macOS

### Opsi A: pemasang satu baris

```bash
curl -fsSL https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh | sh
```

Perintah ini mengunduh manifest rilis yang ditandatangani (`latest.json`),
mengambil bundel aplikasi yang cocok dengan CPU Anda, lalu memasang
`Jejak.app` ke `~/Applications`. Tidak perlu `sudo`, dan data Anda di
`~/.jejak` tidak pernah disentuh.

Pilihan yang sering dipakai:

| Variabel | Arti | Bawaan |
| --- | --- | --- |
| `JEJAK_INSTALL_DIR` | tempat `Jejak.app` diletakkan | `~/Applications` |
| `JEJAK_CHANNEL` | `stable` atau `beta` | `stable` |
| `JEJAK_LATEST_JSON_URL` | alamat manifest rilis | sesuai kanal |

```bash
# Pasang kanal beta
curl -fsSL https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh | JEJAK_CHANNEL=beta sh
```

Variabel lingkungan diletakkan di sisi `sh` pada pipeline, bukan di sisi
`curl`, supaya benar-benar sampai ke pemasang.

Pemasang juga bisa dijalankan dari salinan lokal, berguna bila Anda ingin
membacanya lebih dulu:

```bash
curl -fsSLO https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh
less install.sh
sh install.sh
```

### Opsi B: disk image

1. Unduh `.dmg` sesuai CPU Anda dari
   [GitHub Releases](https://github.com/jejak-dev/jejak/releases) — satu build
   untuk Apple silicon (`aarch64`) dan satu untuk Intel (`x86_64`).
2. Buka `.dmg` dan seret `Jejak.app` ke folder **Applications**.
3. Lepas disk image, lalu jalankan Jejak dari Applications.

Alternatifnya, ambil berkas yang sama dari
[halaman unduh](https://jejak-dev.github.io/jejak/).

## Peringatan Gatekeeper di macOS

Jejak **tidak ditandatangani dengan sertifikat Apple Developer ID dan tidak
dinotarisasi**. Karena itu macOS menampilkan peringatan saat pertama kali
Anda membukanya. Ini hal yang diharapkan, bukan unduhan yang rusak, dan
aplikasi tetap berjalan tanpa koneksi internet.

Cara membukanya:

1. Klik kanan (atau Control-klik) `Jejak.app` di Applications, lalu pilih
   **Open**.
2. Pada dialog, pilih **Open** lagi untuk mengonfirmasi.

Bila dialognya sudah tertutup, buka **System Settings → Privacy & Security**,
lalu tekan **Open Anyway** pada pesan tentang Jejak. Peringatan muncul saat
peluncuran pertama untuk tiap akun pengguna; setelah Anda menyetujuinya,
macOS biasanya tak bertanya lagi.

Kalau macOS melaporkan aplikasi sebagai "rusak", bukan "pengembang tak
dikenal", kemungkinan atribut quarantine masih ada. Pemasang satu baris
membersihkan atribut itu; kalau Anda memasang manual, jalankan:

```bash
xattr -dr com.apple.quarantine /Applications/Jejak.app
```

## Pemasangan di Windows (beta)

Build Windows diterbitkan sebagai pemasang NSIS (`.exe`) untuk x64. Pemasang
menginstal **hanya untuk pengguna yang sedang login**, jadi tidak perlu hak
administrator.

1. Unduh `.exe` dari
   [GitHub Releases](https://github.com/jejak-dev/jejak/releases).
2. Jalankan dan ikuti petunjuknya.
3. Windows SmartScreen menampilkan "Windows protected your PC" karena binary
   tak ditandatangani. Pilih **More info → Run anyway**. Lakukan ini hanya
   untuk build yang Anda unduh dari halaman rilis resmi.

Data disimpan di `%USERPROFILE%\.jejak`.

## Pemasangan di Android (beta)

Aplikasi Android adalah klien tipis: ia membuka server Jejak di komputer Anda
lewat WebView. Tidak ada yang berjalan di ponsel, jadi APK jarang perlu
diperbarui; tampilan dimuat dari server.

1. Di komputer, aktifkan akses jaringan di pengaturan Jejak dan setel sandi
   akses. Server hanya menerima host jaringan privat (`192.168.x.x`, `.local`,
   `.ts.net`).
2. Unduh `Jejak-<versi>.apk` dari
   [GitHub Releases](https://github.com/jejak-dev/jejak/releases) lalu buka.
   Izinkan pemasangan dari sumber ini saat Android menanyakan.
3. Isi alamat server, misalnya `http://192.168.1.24:4747`, lalu masuk dengan
   sandi akses.

`http://` biasa di jaringan lokal berfungsi, tetapi dikte suara butuh HTTPS
(misalnya lewat Tailscale). Pembaruan terpasang di atas aplikasi yang ada
selama berasal dari tanda tangan rilis yang sama.

## Pembaruan otomatis

Jejak memperbarui dirinya sendiri. Aplikasi memeriksa rilis baru sekitar
setiap enam jam, dan Anda juga bisa memeriksa sendiri.

- Buka aplikasi lalu ke halaman pengaturan (**Set up provider** di sidebar).
  Di bawah halaman itu ada kartu **Pembaruan aplikasi**.
- **Periksa sekarang** memeriksa langsung. Bila pembaruan ditemukan, tekan
  **Perbarui**, lalu **Mulai ulang sekarang** untuk menyelesaikannya.
- **Periksa otomatis** menyalakan atau mematikan pemeriksaan berkala. Bawaannya
  menyala.
- **Kanal pembaruan** memilih `Stabil` atau `Beta`. Kanal beta berisi build
  pra-rilis yang belum tentu stabil; kanal stabil hanya berisi rilis penuh.
- Aplikasi tak pernah memasang atau memulai ulang pembaruan sendiri — selalu
  perlu klik Anda.

Pengaturan ini disimpan di berkas `desktop.json` di dalam folder konfigurasi
aplikasi:

- macOS: `~/Library/Application Support/io.github.jejak-dev.jejak/desktop.json`
- Windows: `%APPDATA%\io.github.jejak-dev.jejak\desktop.json`

Setiap rilis ditandatangani dengan kunci minisign yang kunci publiknya
ditanam di dalam aplikasi, jadi bundel yang dimanipulasi tidak akan terpasang.
Pembaruan diambil hanya lewat HTTPS dari `github.com/jejak-dev/jejak`.

## Letak data Anda

Jejak berorientasi lokal. Sesi, berkas memory, pengaturan penyedia, dan kunci
API disimpan dalam satu folder:

- macOS dan Linux: `~/.jejak`
- Windows: `%USERPROFILE%\.jejak`

Set `JEJAK_HOME` untuk memindahkan folder itu ke tempat lain.

```
~/.jejak/
  providers.json     profil penyedia dan kunci API (mode berkas 600)
  memory/            berkas memory, sumber kebenaran
  sessions/          penyimpanan sesi dan peristiwa
  backup/<versi>/    cadangan otomatis sebelum menaikkan versi data
```

Sebelum Jejak menaikkan format data di disk, Jejak menyalinnya ke
`~/.jejak/backup/<versi>/`. Cadangan lama dipangkas, jadi simpan salinan
sendiri bila suatu folder penting bagi Anda.

Kunci API disimpan tanpa enkripsi di mesin Anda sendiri. Siapa pun yang bisa
membaca folder home Anda bisa membacanya.

## Mengatasi masalah

**Periksa lingkungan lebih dulu.** Perintah `doctor` melaporkan runtime, git,
registry penyedia, penyimpanan sesi, versi data, memory, workspace,
checkpoint, server MCP, sandbox, dan Claude Agent SDK:

```bash
jejak doctor
```

Dari bundel aplikasi yang terpasang di macOS, pakai CLI di dalam bundel
secara langsung:

```bash
/Applications/Jejak.app/Contents/MacOS/jejak doctor
```

**Aplikasi tak mau terbuka di macOS.** Lihat
[Peringatan Gatekeeper di macOS](#peringatan-gatekeeper-di-macos) di atas.

**Server tak mau jalan.** Jejak mendengarkan di `127.0.0.1:3000` secara
bawaan. Bila program lain sudah memakai port itu, pilih port lain:

```bash
jejak serve --port 3001
```

**Penyedia melaporkan kunci hilang.** Tambahkan kunci API di halaman
pengaturan, atau arahkan penyedia ke variabel lingkungan agar tak disimpan
di disk.

**Pembaruan tak pernah datang.** Periksa kanal di kartu pembaruan, lalu tekan
**Periksa sekarang**. Bila mesin sedang offline, pemeriksaan akan gagal dan
dicoba lagi nanti.

**Sesi atau memory terlihat kosong setelah pindah mesin.** Salin seluruh
folder `~/.jejak` ke mesin baru. Jangan hanya menyalin `memory/`, karena
status sesi dan pengaturan penyedia ada di sebelahnya.

## Windows (beta): batasan

Build Windows masih beta. Jejak bisa dijalankan dan dipakai, tetapi bagian
berikut ini tak ada atau terbatas di Windows:

- **Panel Terminal dan peluncur perintah (Commands) butuh opt-in.** Jalankan
  Jejak dengan `JEJAK_TERMINAL=1` untuk menyalakannya; di Windows terminal
  memakai **Command Prompt** (`cmd.exe`, sesuai `COMSPEC`). Tak ada indikator
  sibuk saat perintah berjalan, dan belum diuji di Windows sungguhan.
- **Tak ada sandbox untuk tool Bash.** Windows tak punya `sandbox-exec`
  (macOS) maupun `bwrap` (Linux), jadi sandbox melaporkan dirinya tak
  tersedia. Selama mode sandbox bukan **Mati**, sesi baru akan gagal; setel
  mode sandbox ke **Mati** di pengaturan sandbox lebih dulu.
- **Tak ada folder picker native.** Dialog Finder milik macOS tak punya
  padanan di Windows, jadi ketik atau tempel path foldernya.
- **Dikte tak tersedia.** Dikte memakai Web Speech API peramban, dan runtime
  WebView2 di Windows tak menyediakannya, jadi tombol dikte tak pernah muncul.
- **Git for Windows wajib.** `jejak doctor` memeriksa `git` ada di `PATH`;
  tool Bash milik Agent SDK juga butuh Git Bash
  (`C:\Program Files\Git\bin\bash.exe`), atau setel
  `CLAUDE_CODE_GIT_BASH_PATH`.
- **`chmod` tak bermakna di sini.** Kunci penyedia disimpan di
  `%USERPROFILE%\.jejak`; di Windows mode berkas tak berarti apa pun, jadi
  perlindungannya bergantung pada izin akun Windows Anda.
- **Belum diuji di Windows sungguhan.** Build Windows diterbitkan sebagai
  beta dan belum pernah dicoba di mesin Windows yang sebenarnya.

## Mencabut pemasangan

### macOS

- Seret `Jejak.app` dari Applications ke Sampah, atau jalankan pemasang dengan
  `--uninstall`:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh | sh -s -- --uninstall
  ```

  Pencabut ini hanya menghapus `Jejak.app`. Data Anda di `~/.jejak` tetap
  ada.

- Untuk menghapus data juga, tambahkan `--purge-data`. Perintah ini meminta
  jawaban `y` di terminal, jadi jalankan dari terminal, bukan dari pipeline:

  ```bash
  curl -fsSLO https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh
  sh install.sh --uninstall --purge-data
  ```

### Windows

- Buka **Settings → Apps → Installed apps** (di Windows 10: **Settings → Apps
  → Apps & features**), pilih **Jejak**, lalu pilih **Uninstall**. Pencabut
  juga ditambahkan ke menu Start.
- Hapus data secara manual dengan menghapus folder `%USERPROFILE%\.jejak`.

### Menghapus data secara manual

Folder data boleh dihapus kapan saja:

- macOS dan Linux: `rm -rf ~/.jejak`
- Windows: hapus folder `%USERPROFILE%\.jejak`

> **Peringatan:** menghapus `~/.jejak` menghapus sesi, berkas memory, dan kunci
> API penyedia yang tersimpan. Tak ada cara membatalkannya. Bila hanya ingin
> memasang ulang aplikasinya, biarkan folder itu dan pasang ulang di atasnya.

---

Lihat juga [README.md](README.md), [README.id.md](README.id.md), dan
[SECURITY.md](SECURITY.md).
