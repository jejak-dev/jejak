# Jejak

Workbench untuk agent coding yang tidak terikat satu penyedia model, dengan
**memory lintas repo**: agent tahu service, tabel database, dan queue yang saling
terhubung, serta bisa memperkirakan dampak perubahan sebelum menyentuh kode.

> Status: tahap awal (v0.0.1). Proyek masih muda dan antarmukanya masih berubah.

[English](README.md)

## Apa saja isinya

Jejak adalah aplikasi desktop yang berjalan lokal. Ia menjalankan server
HTTP/WebSocket kecil di mesin Anda, sebuah agent mengerjakannya, dan Anda memantau
pekerjaan itu lewat timeline.

- **Sesi dan streaming** — sesi paralel, buffer event berurutan, streaming SSE,
  persistensi SQLite, sambung ulang, dan mundur percakapan.
- **Git dan worktree** — worktree terisolasi per sesi dengan status, stage, commit
  draf, riwayat, hapus, dan pulihkan.
- **Berkas dan Perubahan** — penjelajah folder, editor berkas, pencarian teks,
  diff per hunk, dan bisa menolak atau mengurutkan hunk sebelum diterapkan.
- **Memory lapis 1 dan 2** — berkas Markdown di disk sebagai sumber, halaman Memory,
  dan jembatan MCP (`memory_search`, `memory_propose`).
- **Workspace multi-repo** — daftar workspace, repo tambahan per sesi, dan ikhtisar
  layanan repo yang bisa dibaca agent.
- **Server MCP** — MCP eksternal dan internal, tes koneksi, dan pemasangan ke sesi.
- **Pengindeksan** — indexer GitLab dan folder lokal, keduanya hanya-baca, dengan
  tool pengindeksan dan antarmuka pengindeksan.
- **Mode Goal** — perintah `/goal` dengan batas giliran, penanda di timeline, dan
  notifikasi saat tujuan tercapai.
- **Perintah proyek** — skrip package dan perintah kustom dengan konfirmasi
  berhash, tab Commands, dan terminal PTY.
- **Pengaman** — mode izin per tool, mode bypass dengan kill switch, sandbox Bash
  terarah, pemblokiran akses berkas rahasia, dan audit log append-only yang
  menyamarkan rahasia.
- **Biaya dan pemakaian** — halaman penggunaan, anggaran, jendela konteks per model
  beserta tarif dan estimasi biaya, dan penyedia/model yang bisa diganti.
- **Tambahan** — dikte suara dengan persetujuan privasi, PWA yang bisa dipasang, tab
  Wiki GitLab, dan pembaruan di dalam aplikasi.

## Persyaratan

- Untuk aplikasi desktop: macOS 12 atau lebih baru, atau Windows x64 (Windows
  masih beta).
- Untuk menjalankan dari sumber: Bun 1.4 atau lebih baru.

## Memasang aplikasi desktop

Di macOS, satu baris memasang `Jejak.app` ke `~/Applications` (tanpa `sudo`):

```bash
curl -fsSL https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh | sh
```

Alternatifnya seret `Jejak.app` dari `.dmg` ke Applications. Di Windows, unduh
`.exe` dari [GitHub Releases](https://github.com/jejak-dev/jejak/releases). Build
tersedia untuk macOS (Apple silicon dan Intel) serta Windows (x64).

Dua catatan jujur, karena aplikasi **tidak ditandatangani dengan sertifikat
vendor sistem**:

- **macOS**: Gatekeeper menampilkan peringatan "pengembang tak dikenal". Buka lewat
  klik kanan → **Open**, atau ke **System Settings → Privacy & Security → Open
  Anyway**.
- **Windows**: SmartScreen menampilkan "Windows protected your PC". Pilih **More
  info → Run anyway**. Build Windows ditandai **beta**.

Pembaruan dikirim oleh aplikasi itu sendiri. Setiap pembaruan ditandatangani dengan
kunci minisign yang kunci publiknya tertanam di aplikasi, jadi bundel yang dimanipulasi
tidak akan terpasang.

Langkah lengkap, letak data, pemecahan masalah, dan cara mencabut pemasangan:
[INSTALL.id.md](INSTALL.id.md).

## Menjalankan dari sumber

```bash
bun install
bun run doctor     # periksa lingkungan
bun run start      # jalankan server di http://127.0.0.1:3000
```

`bun run dev` menjalankan server dengan hot reload. `bun run typecheck` dan `bun test`
menjalankan pemeriksaan yang dipakai CI.

### CLI

Setelah `bun link`, perintah `jejak` tersedia:

```bash
jejak doctor                    # periksa lingkungan
jejak serve                     # jalankan server (default 127.0.0.1:3000)
jejak serve --port 3001         # atau --port=3001
jejak serve --host 127.0.0.1    # alamat binding
jejak serve --mock              # agent tiruan, tanpa SDK
jejak --version
jejak --help
```

Flag dan variabel lingkungan yang berguna:

- `--password auto` / `--password-file <path>` / `JEJAK_PASSWORD` — melindungi server
  dengan satu kata sandi.
- Sandi yang Anda buat sendiri di Pengaturan → *Akses & sandi* disimpan sebagai
  hash scrypt di `~/.jejak/auth.json` (mode `600`) dan dipakai otomatis oleh
  `jejak serve` bila tak ada flag sandi atau variabel lingkungan.
- `--allow-host <host>` — menambah host yang diizinkan pada header `Host` (bisa
  diulang).
- `--insecure-no-auth` — mengizinkan bind non-loopback tanpa kata sandi (berisiko).
- `--tls-cert <path> --tls-key <path>` — menyajikan HTTPS dengan sertifikat sendiri.
- `HOST`, `PORT` — alamat binding dan port (default `127.0.0.1:3000`).
- `JEJAK_HOME` — folder data (default `~/.jejak`).

## Akses dari perangkat lain

Jejak bisa mendengarkan di jaringan lokal supaya HP atau laptop lain bisa
membukanya.

1. Buat sandi dulu: Pengaturan → *Akses & sandi* → buat sandi.
2. Di kartu yang sama, nyalakan *Izinkan akses dari perangkat lain*. Listener
   jaringan memakai port `4747` secara bawaan; port bisa diubah saat listener
   masih mati.
3. Buka salah satu URL yang tampil di daftar (mis. `http://192.168.1.5:4747`)
   di perangkat lain lalu masuk dengan sandi yang sama.

Peringatan:

- Perangkat mana pun di jaringan yang sama yang tahu sandinya bisa membuka
  Jejak dan menjalankan agen di komputermu. Pakai hanya di jaringan tepercaya,
  atau dijangkau lewat Tailscale.
- Koneksi ini HTTP biasa: sandi dan cookie sesi **tidak** dienkripsi di jaringan
  lokal.
- macOS mungkin menampilkan dialog "terima koneksi masuk" saat pertama kali.

## Keamanan

- Server mendengarkan `127.0.0.1` secara default dan menolak bind non-loopback bila
  kata sandi tidak diatur (atau Anda memakai `--insecure-no-auth`).
- Permintaan API diperiksa terhadap daftar izinkan `Host` dan `Origin`, sehingga
  halaman di peramban Anda tidak bisa mengendalikan server dari origin lain.
- Data ada di `~/.jejak` (ubah dengan `JEJAK_HOME`). API key penyedia ditulis dengan
  mode berkas `600` dan **tidak** dienkripsi di disk. Anda juga bisa menunjuk variabel
  lingkungan lewat penyedian.
- Agent menjalankan perintah shell. Izin diatur per tool, tool Bash bisa disandbox,
  dan berkas rahasia yang dikenal (`.env`, `*.pem`, `~/.ssh/**`,
  `.aws/credentials`, dan lain-lain) diblokir dari dibaca.
- Rahasia disamarkan pada audit log dan aliran event.

Lihat [SECURITY.md](SECURITY.md) untuk model ancaman dan cara melaporkan kerentanan.

## Kontribusi

Baca [CONTRIBUTING.md](CONTRIBUTING.md) dan [AGENTS.md](AGENTS.md). Ringkasnya: satu
perubahan per commit, Conventional Commits, tes untuk setiap perubahan perilaku, dan
tanpa rahasia di repo.

## Lisensi

[MIT](LICENSE)
