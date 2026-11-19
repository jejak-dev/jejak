# Changelog

Semua perubahan penting pada Jejak dicatat di berkas ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id/1.1.0/), dan nomor versi mengikuti [SemVer](https://semver.org/lang/id/).

## [Belum dirilis]

### Ditambahkan

- Design (D1): tab Desain dan kanvas frame. Desain berupa HTML biasa di folder `design/` repo (`design.json`, `pages/`, `tokens.css`); tiap halaman tampil sebagai frame iframe tersandbox (tanpa jaringan, CSP ketat) dengan preset desktop, tablet, dan mobile, zoom, geser, dan tata letak tersimpan. Alat Pilih menampilkan info elemen (selector, gaya, HTML) dan menyisipkannya ke pesan untuk diubah agent. Mode lebar menyempitkan sidebar agar kanvas leluasa.
- Design (D2): agent mengubah desain dari kanvas. Alat `design_patch` (perubahan terarah per elemen dengan `baseMtime`), `design_screenshot` (tangkapan frame dari kanvas yang terbuka), `design_comments` dan `design_comment_resolve`. Pengguna menambah komentar pada elemen terpilih, pin bernomor tampil di frame, dan daftar komentar bisa dikirim ke agent. Mode Fokus (tombol atau F) membuat kanvas memenuhi jendela dengan baris pesan melayang.
- Design (D3): sistem desain. Panel Token menyunting variabel `design/tokens.css` (warna, ukuran, font) dan frame memuat ulang setelah disimpan. `design/DESIGN.md` memuat blok otomatis berisi token dan halaman terkini yang dibaca agent. Halaman bisa dibuat varian (mis. gelap, kosong, galat) dan halaman sekelompok digambar dalam satu kotak berlabel. Catatan tempel bebas di kanvas disimpan di `design.json`.
- Design: `DESIGN.md` bawaan kini memuat bagian "Kualitas visual (anti-slop)" agar agent merancang halaman dari subjek, bukan template (rencana palet/font/tata letak, isi teks nyata, penanda khas generator, tipografi, dan kualitas dasar seperti responsif 390 px serta `prefers-reduced-motion`).
- Design: skill `design-antislop` dipasang otomatis ke `.claude/skills/` proyek saat Mulai desain, sehingga agent memakainya tanpa langkah tambahan.

## [0.1.0-beta.15] - 2026-11-18

### Diubah

- Terminal memakai emulator xterm.js (mendukung vim, htop, kursor, warna penuh, seleksi/salin) dan soket WebSocket dua arah yang menyambung ulang otomatis dengan layar dipulihkan dari riwayat terbaru; memperbaiki layar terminal yang kadang gantung tanpa prompt. Menambah dependensi @xterm/xterm dan @xterm/addon-fit.

## [0.1.0-beta.14] - 2026-11-18

### Ditambahkan

- Gambar dan video buatan agent di folder kerja sesi (png, jpg, gif, webp, mp4, webm, mov) tampil sebagai thumbnail di timeline, termasuk berkas yang dibaca lewat Read; klik membuka pratinjau besar dengan navigasi, video bisa diputar. URL luar tidak dirender.
- Gambar lampiran di komposer dan pesan terkirim bisa dipratinjau (lightbox).

### Diperbaiki

- `/compact` tak lagi menampilkan galat "Giliran kosong" padahal kompaksi berhasil.
- Menu "/" di komposer langsung memuat ulang daftar perintah setelah pengaturan Claude, skill, atau plugin diubah (sebelumnya basi sampai halaman dimuat ulang).
- Tab Skills memperingatkan bila skill pengguna (~/.claude) belum dipakai sesi karena "Muat pengaturan pengguna" mati (penyebab skill tak muncul di menu "/").
- Nama folder di sidebar dan label path di Windows kini hanya nama foldernya (bukan path penuh `C:\...`).
- Pilihan Proyek di halaman Instruksi dan skills kini mengutamakan folder sesi, bukan folder data aplikasi.
- Halaman Instruksi dan skills (CLAUDE.md, Skills, Subagent, Hooks) di Windows tidak lagi menolak cwd bergaya `C:\...` dengan "cwd harus berupa path absolut".

## [0.1.0-beta.13] - 2026-11-18

### Diperbaiki

- Tes kode QR tidak lagi gagal acak di CI lambat (menunggu tombol muncul, bukan jeda tetap 60 ms); ini yang menggagalkan gerbang rilis beta.12.

## [0.1.0-beta.12] - 2026-11-18

### Diperbaiki

- Browser: popup atau tab yang tertutup sebelum sempat diaktifkan tidak lagi mematikan server ("Server Jejak berhenti", `Tab tidak ditemukan`).

## [0.1.0-beta.11] - 2026-11-18

### Ditambah

- Windows: tombol "Pilih folder" membuka dialog folder Explorer (lewat PowerShell), seperti Finder di macOS.

### Diperbaiki

- Windows: sesi baru tanpa pilihan sandbox eksplisit dibuat tanpa sandbox, sehingga prompt pertama tidak lagi gagal dengan "Sandbox required but unavailable".

## [0.1.0-beta.10] - 2026-11-18

### Diperbaiki

- Tes PTY env tersaring tidak lagi balapan dengan gema perintah (menggagalkan gerbang rilis beta.9; beta.9 tidak terbit).

## [0.1.0-beta.9] - 2026-11-18

### Diperbaiki

- Windows: CLI `claude` yang ditemukan sebagai shim npm (`claude.cmd`) diganti target aslinya (`claude.exe` atau `cli.js`), sehingga sesi tidak lagi gagal dengan `spawn ... EINVAL`.
- Popover "Pilih folder" muncul di bawah baris opsi komposer, bukan di pojok halaman.

## [0.1.0-beta.8] - 2026-11-18

### Ditambah

- Akses dari mana saja lewat Cloudflare Tunnel: hostname, token, dan saklar di Pengaturan, Jejak menjalankan `cloudflared` sendiri. Token tersimpan 0600, perubahan hanya dari komputer server.
- Tempel JSON konfigurasi (`mcpServers`) untuk menambah server MCP sekaligus, dengan pratinjau sebelum disimpan; nilai rahasia tidak ditampilkan.
- Tab Terminal bergaya Claude: permukaan polos, langsung terbuka, kursor blok berkedip.

### Diubah

- Pratinjau Markdown berkas dan dokumen Rencana/PRD dirapikan seperti Claude: tipografi, warna, tabel berlebar alami dengan scroll, dan tombol perbesar ke modal.

### Diperbaiki

- Warna seleksi di penyunting berkas kini transparan sehingga teks yang diblok tetap terbaca.

## [0.1.0-beta.7] - 2026-11-17

### Ditambah

- APK Android klien tipis yang membuka server Jejak lewat WebView; dibangun dengan `bun run build:apk` dan dilampirkan ke rilis GitHub bila rahasia keystore diisi.
- Tata letak mobile satu kolom: layar sesi, chat, dan panel terpisah dengan tombol kembali, bukan laci.

## [0.1.0-beta.6] - 2026-11-17

### Ditambah

- Agent boleh membaca `.env` dengan nilai rahasia disamarkan (host, port, dan nama basis data tetap terlihat; kata sandi, token, dan kredensial dalam URL disembunyikan).
- Env untuk perintah: kredensial dari berkas `.env` dipasang ke semua perintah Bash tanpa pernah dilihat agent; diatur di bagian "Env untuk perintah" pada tab Rahasia.
- Agent boleh membuat berkas `.env` baru atau menyalin dari `.env.sample`, tanpa menimpa yang sudah ada.

### Diperbaiki

- Drop berkas dan gambar ke komposer berfungsi di app desktop.
- Giliran kosong dan kompaksi yang gagal tampil sebagai gagal, bukan "selesai" tanpa hasil.
- Angka konteks yang tak masuk akal (melewati jendela, mis. 100% palsu) dikoreksi dari ringkasan usage giliran.
- Pesan "data lebih baru" menyebut lokasi aplikasi yang sedang berjalan.

## [0.1.0-beta.5] - 2026-11-16

### Ditambah

- Atur sandi akses dari Pengaturan (Akses & sandi); Keluar tampil setelah sandi dibuat.
- Akses dari perangkat lain: Pengaturan (Akses & sandi) bisa menyalakan listener kedua di jaringan (port 4747, bisa diubah) supaya Jejak dibuka dari HP atau laptop lain; hanya menyala bila sandi tersimpan ada.
- Kode QR untuk tiap alamat akses jaringan di Pengaturan, supaya HP tinggal memindai.
- Arahkan pesan antrean ke giliran yang sedang berjalan (steering) tanpa menghentikannya.
- Pencarian teks di tab Files memakai `git grep` (menghormati `.gitignore`), dengan regex PCRE, kata utuh, glob sertakan/kecualikan, sorotan kecocokan, dan hasil per berkas.
- Prompt tertahan: sesi baru bisa menunggu sesi lain selesai ("Tunggu sesi" di komposer), daftar "Tertahan" di sidebar, dan Batal memulihkan draf.
- Tugas terjadwal: halaman Schedules untuk sesi otomatis sekali, berulang, atau harian (waktu lokal server); mode tanpa izin tidak diizinkan.
- Tab Konteks di panel kanan: pemakaian jendela konteks, token, biaya, hitungan alat, dan giliran per sesi.
- Saran prompt berikutnya sebagai chip di atas komposer; konsolidasi ringkasan sesi di halaman Memory.
- Tes e2e Playwright (`bun run test:e2e`) dan job CI-nya.
- Plugin Claude Code: tab Plugin di halaman Instruksi (daftar terpasang, saklar per plugin) dan sub-tab Jelajahi untuk memasang atau mencopot plugin dari marketplace.
- Beranda menampilkan daftar "Lanjutkan sesi"; keadaan kosong Jadwal punya tombol "Buat tugas pertama".

### Diubah

- Pengaturan dipecah jadi bagian Provider, Keamanan, Biaya, Fitur, dan Sistem; footer sidebar dikelompokkan.
- Proses kerja giliran yang selesai dilipat jadi satu blok "Bekerja, N langkah"; tombol Hentikan pindah ke komposer.
- Label antarmuka diseragamkan ke bahasa Indonesia; tab dan saklar halaman Instruksi lebih jelas; pertanyaan agent yang sudah dijawab dilipat; header sesi lebih ringkas, terutama di HP.
- Tipografi memakai skala token (jawaban agen serif 15.5px, dasar 14px, teks terkecil 12px); lencana header tidak terpotong dan persen konteks tampil.

### Diperbaiki

- Tombol Keluar tidak lagi tampil di aplikasi desktop (sandi internalnya tidak dikenal pengguna, sehingga keluar berarti terkunci sampai restart).
- Kartu Akses dari jaringan langsung menyegarkan status setelah sandi dibuat atau dihapus.
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
