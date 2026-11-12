# Changelog

Semua perubahan penting pada Jejak dicatat di berkas ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/), dan nomor versi mengikuti [SemVer](https://semver.org/lang/id/).

## [Belum dirilis]

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
