# CI dan Rilis Jejak

## `.github/workflows/ci.yml`
Berjalan pada setiap pull request dan push ke `main`.
- Job `tes`: matriks `macos-latest` dan `windows-latest` (checkout, Bun 1.4.2,
  `bun install --frozen-lockfile`, typecheck, `bun test`, `check:version`).
- Job `rust`: toolchain Rust stabil + cache cargo, `cargo test` dan
  `cargo clippy --all-targets -- -D warnings` di `src-tauri`. Sidecar kosong
  dibuat lebih dulu karena `tauri_build` menyalin `externalBin`.

## `.github/workflows/release.yml`
Berjalan pada push tag `v*.*.*` (termasuk `v1.0.0-beta.1`) dan manual.
- Job `gerbang`: typecheck, tes, dan `check:version -- --tag <tag>`; kanal
  rilis (`stable`/`beta`) diambil dari versi manifest.
- Job `bangun`: matriks macOS arm64, macOS x64, dan Windows x64; membangun
  binary sidecar, menguji hasilnya, lalu mengunggah lewat `tauri-action`.

## `.github/workflows/pages.yml`
Halaman unduh statis di `site/`. Hanya dipicu manual (`workflow_dispatch`), tidak
otomatis pada push. Folder `site/` diunggah apa adanya sebagai artefak Pages
(bersama salinan `install.sh`) memakai `actions/configure-pages`,
`actions/upload-pages-artifact`, lalu `actions/deploy-pages`. Izin yang dipakai:
`pages: write` dan `id-token: write`.

## Rahasia yang dibutuhkan (nama saja)
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

`GITHUB_TOKEN` disediakan GitHub secara otomatis.

## Cara rilis
Stabil: `bun run release 1.0.0` lalu `git push --follow-tags`. Rilis dibuat
sebagai draf; periksa lalu terbitkan.
Beta: `bun run release 1.0.0-beta.1` lalu `git push --follow-tags`. Rilis
memakai tag bergulir `beta`, ditandai prarilis, dan tidak berupa draf.

## Catatan
- Windows masih beta: kegagalan di runner Windows tidak memblokir PR/rilis.
- Action memakai tag mayor (`actions/checkout@v4`, `tauri-apps/tauri-action@v0`).
  Sebelum repo dipublikasikan, disarankan pin ke SHA commit.
- Uji "pasang N-1 lalu perbarui ke N" belum otomatis; uji manual lulus di R4a.
