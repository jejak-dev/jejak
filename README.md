# Jejak

Workbench web untuk agent coding yang tidak terikat satu penyedia model, dengan
**memory lintas repo**: agent tahu service, tabel database, dan queue yang saling
terhubung, dan bisa menghitung dampak perubahan sebelum menyentuh kode.

> Status: tahap awal (v0.0.1). Rencana lengkap ada di [docs/ROADMAP.md](docs/ROADMAP.md).

## Persyaratan

- Bun 1.4 atau lebih baru

## Mulai

```bash
bun install
bun run doctor     # periksa lingkungan
bun run start      # jalankan server di http://127.0.0.1:3000
```

Perintah CLI (setelah `bun link`):

```bash
jejak doctor
jejak serve
jejak serve --port 3001        # atau --port=3001
jejak serve --mock             # agent tiruan, tanpa SDK
jejak --version
```

Server hanya mendengarkan `127.0.0.1` secara default. Ubah dengan `HOST` dan `PORT`.

Petunjuk pasang lengkap (clone, tarball, git) ada di [docs/PASANG.md](docs/PASANG.md).

## Struktur

```
src/cli/        perintah jejak
src/server/     API dan WebSocket (Elysia)
src/client/     UI (Preact)
src/shared/     tipe dan utilitas bersama
packages/sdk/   kontrak plugin (extractor, panel, adapter)
packages/ui/    kit komponen UI
docs/           roadmap dan dokumentasi
```

## Lisensi

MIT
