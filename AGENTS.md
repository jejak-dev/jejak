# AGENTS.md

Kontrak untuk kontributor manusia dan agent.

## Perintah

- `bun install` : pasang dependensi
- `bun run typecheck` : cek tipe (harus lulus sebelum commit)
- `bun test` : jalankan tes
- `bun run dev` : server dengan hot reload

## Konvensi

- TypeScript strict. Runtime Bun, bukan Node.
- Commit memakai Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Server mendengarkan `127.0.0.1` secara default. Jangan mengubahnya menjadi terbuka tanpa autentikasi.
- Akses database dan broker eksternal hanya baca, kecuali ada keputusan tertulis lain.
- Rahasia (key, token, kredensial) tidak boleh masuk repo, log, atau memory.
- Memory selalu menyimpan asal (berkas, commit, tanggal) dan tingkat kepercayaan.

## Aturan perubahan

- Ubah satu hal per commit.
- Perubahan perilaku harus disertai tes.
- Baca docs/ROADMAP.md sebelum menambah fitur besar; sesuaikan dengan rilis yang berlaku.
- Jangan menambah dependensi tanpa alasan yang jelas di deskripsi perubahan.
