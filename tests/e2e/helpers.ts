/**
 * Pembantu yang dipakai beberapa spec e2e.
 *
 * Berkas ini bukan spec: akhirannya `.ts` biasa, bukan `.e2e.ts`, jadi
 * `playwright test` tak pernah memuatnya sebagai berkas uji.
 */

import { tmpdir } from "node:os";
import { expect, type Page } from "@playwright/test";

/**
 * Folder kerja untuk sesi uji. `tmpdir()` pasti ada di semua platform dan
 * tak bergantung pada direktori kerja pemeriksa test.
 */
export const CWD_UJI = tmpdir();

/** Potongan balasan mock runner yang dipakai sebagai penanda "sesi selesai". */
export const BALASAN_MOCK = "Berkas berhasil dibaca";

/** Navigasi ke beranda Jejak. */
export async function bukaBeranda(page: Page): Promise<void> {
  await page.goto("/");
}

/**
 * Isi composer beranda (folder kerja + prompt) lalu kirim.
 *
 * Folder kerja selalu diisi eksplisit: `/api/info` mengisinya sendiri, tapi
 * nilainya bisa tiba setelah prompt diketik.
 */
export async function kirimPrompt(page: Page, prompt: string): Promise<void> {
  await page.getByLabel("Working directory", { exact: true }).fill(CWD_UJI);
  await page.getByLabel("Tugas", { exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Mulai sesi" }).click();
}

/** Daftar sesi di sidebar; dipakai untuk memeriksa sesi muncul. */
function daftarSesi(page: Page) {
  return page.getByRole("navigation", { name: "Daftar sesi" });
}

/**
 * Baris satu sesi di sidebar.
 *
 * Dicari lewat teks yang ditampilkan, bukan nama aksesibel: nama baris
 * berakhiran waktu ("… baru") dan berubah, sementara tombol "Aksi sesi …"
 * punya nama aksesibel yang memuat judul sesi juga.
 */
export function barisSesi(page: Page, judul: string) {
  return daftarSesi(page).getByRole("button").filter({ hasText: judul });
}

/**
 * Buat satu sesi lewat composer dan tunggu sampai barisnya muncul di sidebar
 * serta balasan mock tampil di linimasa.
 */
export async function buatSesi(page: Page, prompt: string): Promise<void> {
  await kirimPrompt(page, prompt);
  await expect(barisSesi(page, prompt)).toBeVisible();
  await expect(page.getByText(BALASAN_MOCK)).toBeVisible();
}
