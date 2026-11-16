# Changelog

Semua perubahan penting pada Jejak dicatat di berkas ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/), dan nomor versi mengikuti [SemVer](https://semver.org/lang/id/).

## [Belum dirilis]

### Ditambah

- Atur sandi akses dari Pengaturan (Akses & sandi); Keluar tampil setelah sandi dibuat.

### Diperbaiki

- Tombol Keluar tidak lagi tampil di aplikasi desktop (sandi internalnya tidak dikenal pengguna, sehingga keluar berarti terkunci sampai restart).
- Sandi lama yang salah di kartu Akses & sandi kini menampilkan galat, tidak lagi memantulkan ke layar login.

## [0.1.0-beta.4] - 2026-11-15

### Ditambah

- Panel Browser: Chromium terpisah dengan tampilan langsung, banyak tab, riwayat, ukuran tampilan, kontrol klik, gulir, ketik, salin, tempel, dan layar penuh. Bisa dinyalakan dari kartu Fitur di Pengaturan tanpa restart.
- Agen memakai browser yang sama dengan panel lewat tool `browser_*` (navigasi, snapshot, klik, ketik, tab, dan `browser_screenshot`). Tool baca berjalan otomatis, aksi lewat modal izin, dan isi halaman diperlakukan sebagai data tak tepercaya.
- Panel kanan berupa jendela bertumpuk dengan strip tab dan rel ikon vertikal berkelompok; lebarnya bisa digeser 280–1400 px mengikuti ukuran jendela.
- Mode plan dengan kartu rencana ringkas di chat dan dokumen lengkap di panel Rencana.
- Memory Claude Code per proyek tampil di panel Memory (baca-saja), dengan sinkron opsional memory proyek aktif Jejak ke folder memory Claude Code (hanya berkas `jejak_*`, dengan deteksi konflik).
- Revisi memory lewat `replaces` dengan blok Sebelum/Sesudah dan tombol Terapkan revisi; berkas memory bernama terbaca dengan judul H1 dan `INDEX.md` otomatis.
- Antrean pesan terlihat di bawah komposer, dengan Kirim sekarang dan hapus per pesan.
- Sesi yang terputus (aplikasi berhenti) bisa dilanjutkan; Approve, Revisi, dan jawaban pertanyaan tetap aktif setelah pemulihan.
- Komponen Select bersama menggantikan semua `<select>` bawaan peramban.
- Konfirmasi modal untuk hapus provider, memory, worktree, checkpoint, perubahan, MCP, workspace, runner, mundur percakapan, mulai tujuan, rollback SDK, dan restart pembaruan.

### Diubah

- Mengganti mode izin di tengah giliran langsung berlaku untuk izin berikutnya dan yang sedang menunggu.
- Mengganti sandbox saat sesi berjalan menghentikan giliran lalu melanjutkannya otomatis dengan mode baru.
- Jarak antara ringkasan langkah dan teks agen dirapatkan; baris tombol salin tidak lagi memakai ruang di layout.
- Tampilan panel Browser tajam di layar Retina (render 2×, kualitas JPEG 80, kanvas memakai rasio piksel layar).
- Profil tanpa model bawaan memakai model pertamanya, dan catatan identitas model ditambahkan di system prompt untuk penyedia non-Claude.
- Nama bawaan profil baru menjadi Provider dengan penomoran.

### Diperbaiki

- Browser menyingkirkan Chrome yatim yang menahan profil dan mencoba ulang sekali; port DevTools usang dibuang sebelum Chrome dijalankan, dan peluncuran gagal cepat bila Chrome berhenti.
- Browser tidak meninggalkan Chrome yatim saat Jejak berhenti atau server berhenti di tengah peluncuran.
- Back, forward, dan reload browser menunggu navigasi selesai.
- Penjaga rahasia memory tidak lagi menolak jalur berkas panjang; ringkasan sesi memakai jalur relatif dan galat penyimpanannya dicatat.
- Pemulihan setelah restart menutup permintaan izin yang menggantung sebagai sesi dihentikan.
- Entitlement JIT untuk sidecar Bun agar Claude Agent SDK dapat dimuat di Jejak.app.
- Pemutaran ulang event sesi lama dibatch agar antarmuka tidak membeku.
- Isi memory dirender sebagai Markdown.

## [0.1.0-beta.3] - 2026-11-14

### Diubah

- Workflow GitHub memakai `actions/checkout` v5 (Node 24).

## [0.1.0-beta.2] - 2026-11-14

### Diperbaiki

- Tes proses versi data tidak lagi gagal pada versi pra-rilis, sehingga gerbang rilis lolos.

## [0.1.0-beta.1] - 2026-11-14

### Ditambah

- CLI dan server Jejak: perintah `serve`, `doctor`, `--version`, serta autentikasi opsional dengan sandi tunggal.
- Panel klien: sidebar sesi, timeline percakapan, komposer bergaya chip, panel kanan, mode terang/gelap, dan palet perintah.
- Sesi paralel dengan buffer event berurutan, streaming SSE, persistensi SQLite, sambung ulang, dan mundur percakapan.
- Panel Git dan worktree terisolasi per sesi: status, stage, commit draf, riwayat, hapus, dan pulihkan.
- Panel Berkas dan Perubahan: penjelajah folder, editor berkas, pencarian teks, diff per hunk, tolak, dan urungkan hunk.
- Memory lapis 1 dan 2 dengan berkas Markdown sebagai sumber, halaman Memory, dan jembatan MCP (`memory_search`, `memory_propose`).
- Workspace multi-repo: daftar workspace, repo tambahan per sesi, danIkhtisar layanan repo untuk agent.
- Server MCP eksternal dan internal: halaman pengelolaan, tes koneksi, dan pemasangan ke sesi.
- Indexer repo GitLab dan folder lokal dengan klon dangkal hanya-baca, tool pengindeksan, dan antarmuka pengindeksan.
- Mode Goal: perintah `/goal`, batas giliran, penanda di timeline, dan notifikasi tujuan.
- Peluncur perintah proyek: skrip package dan perintah kustom dengan konfirmasi berhash, tab Commands, dan terminal PTY.
- Audit log append-only dengan penyamaran rahasia, retensi, dan halaman log audit.
- Mode izin per tool, mode bypass dengan kill switch, sandbox Bash terarah, dan pemblokiran akses berkas rahasia.
- Halaman penggunaan, anggaran, instruksi, penyedia, dan pengindeksan.
- Dikte suara di komposer dengan persetujuan privasi dan pilihan bahasa.
- PWA: service worker, manifest, ikon, dan area aman notch untuk layar mobile.
- Tab Wiki GitLab: pohon halaman, tautan antarhalaman, penyegaran, dan kutip ke komposer.

### Diubah

- Tampilan jawaban dan langkah agent dirapikan menjadi timeline ringkas ala Claude.
- Jendela konteks dihitung per model, termasuk tarif per model dan estimasi biaya.
- Penyimpanan lampiran pesan memakai folder lampiran terpisah yang boleh dibaca agent.
- Penyedia dan model dapat diganti langsung dari bar balasan, berlaku untuk giliran berikutnya.
- Provider punya profil cadangan yang dipakai otomatis bila giliran gagal sebelum ada output.

### Diperbaiki

- Pencarian memory untuk agent memakai OR antar kata, sehingga kueri model tidak lagi sering kosong.
- Ukuran konteks mengikuti batas pemadatan (compact) terbaru, bukan angka dari giliran lama.
- Jalur `/tmp` dan `/private/tmp` dianggap sama, dan sesi worktree dikelompokkan di bawah repo asal.
- `/btw` memisahkan blok teks dengan paragraf baru.
- Popover konteks dan panel geser menutup saat klik di luar atau tekan Esc.

## [0.0.1]
