import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Akar repo Jejak, diturunkan dari letak berkas ini (`tests/e2e/`).
 *
 * Dipakai, bukan `process.cwd()`: server uji dan `globalTeardown` berjalan
 * dari direktori yang berbeda, jadi keduanya harus sampai ke akar yang sama.
 */
export function akarRepo(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

/**
 * Direktori data untuk server uji.
 *
 * Namanya diturunkan dari akar repo, bukan acak: run berikutnya pada repo
 * yang sama memakai direktori yang sama dan membersihkan sisa run sebelumnya.
 * Playwright menutup server uji dengan SIGKILL, jadi penangan sinyal tak
 * sempat berjalan; karena itu penghapusan jadi tugas `globalTeardown`.
 */
export function direktoriDataUji(): string {
  const sidik = createHash("sha256").update(akarRepo()).digest("hex").slice(0, 12);
  return join(tmpdir(), `jejak-e2e-${sidik}`);
}
