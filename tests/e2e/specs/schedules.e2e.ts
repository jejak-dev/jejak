import { expect, test, type Page } from "@playwright/test";
import { barisSesi, CWD_UJI } from "../helpers";

const NAMA_TUGAS = "Uji e2e tugas terjadwal";

/** Hapus semua tugas yang masih ada; dipakai supaya spec tak bergantung pada sisa run sebelumnya. */
async function bersihkanTugas(page: Page): Promise<void> {
  while (true) {
    const hapus = page.getByRole("button", { name: /^Hapus tugas / });
    if ((await hapus.count()) === 0) return;
    await hapus.first().click();
    await page.getByRole("button", { name: /^Konfirmasi hapus tugas / }).click();
    await expect(hapus).toHaveCount(0);
  }
}

test("halaman tugas terjadwal membuat, menjalankan, dan menghapus tugas", async ({ page }) => {
  await page.goto("/#/schedules");

  await bersihkanTugas(page);
  await expect(page.getByText("Belum ada tugas terjadwal.")).toBeVisible();

  // Buat tugas berulang tiap 30 menit.
  await page.getByRole("button", { name: "Tugas baru" }).click();
  await page.getByLabel("Nama tugas", { exact: true }).fill(NAMA_TUGAS);
  await page.getByLabel("Prompt", { exact: true }).fill("Periksa status repo");
  await page.getByLabel("Folder kerja", { exact: true }).fill(CWD_UJI);
  await page.getByRole("radio", { name: "Berulang" }).check();
  await page.getByLabel("Interval (menit)", { exact: true }).fill("30");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();

  // Baris tugas tampil dengan ringkasan jadwalnya.
  await expect(page.getByText("Tiap 30 menit")).toBeVisible();

  // Jalankan sekali: sesi baru dibuat dari tugas.
  await page.getByRole("button", { name: `Jalankan tugas ${NAMA_TUGAS} sekarang` }).click();
  await expect(page.getByRole("link", { name: "Lihat sesi" })).toBeVisible();
  await expect(barisSesi(page, NAMA_TUGAS)).toBeVisible();

  // Hapus lewat dialog konfirmasi.
  await page.getByRole("button", { name: `Hapus tugas ${NAMA_TUGAS}` }).click();
  await page.getByRole("button", { name: `Konfirmasi hapus tugas ${NAMA_TUGAS}` }).click();
  await expect(page.getByText("Belum ada tugas terjadwal.")).toBeVisible();
});
