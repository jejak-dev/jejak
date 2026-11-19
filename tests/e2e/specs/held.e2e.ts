import { expect, test } from "@playwright/test";
import { CWD_UJI, kirimPrompt, bukaBeranda } from "../helpers";

/**
 * Sesi pertama memakai penanda `[izin]`: runner mock lalu meminta izin dan
 * menunggumu, jadi sesinya tetap berjalan tanpa bergantung pada penundaan
 * waktu. Sesi itulah yang bisa dipilih sebagai "Tunggu sesi".
 */
const PROMPT_BERJALAN = "Uji e2e sesi berjalan [izin]";
const PROMPT_TERTAHAN = "Uji e2e prompt tertahan";

test("prompt yang ditahan tampil di sidebar sebagai Tertahan", async ({ page }) => {
  await bukaBeranda(page);

  // Sesi pertama: masih berjalan karena mock menunggu keputusan izin.
  await kirimPrompt(page, PROMPT_BERJALAN);

  // Kembali ke beranda: composer di sana yang punya pilihan "Tunggu sesi".
  await page.getByRole("button", { name: "Sesi baru", exact: true }).click();

  const tunggu = page.getByRole("button", { name: "Tunggu sesi", exact: true });
  await expect(tunggu).toBeVisible();
  await tunggu.click();
  await page.getByRole("option", { name: new RegExp("Uji e2e sesi berjalan") }).click();

  // Prompt kedua ditahan sampai sesi yang dipilih selesai.
  await page.getByLabel("Folder kerja", { exact: true }).fill(CWD_UJI);
  await page.getByLabel("Tugas", { exact: true }).fill(PROMPT_TERTAHAN);
  await page.getByRole("button", { name: "Tahan prompt" }).click();

  // Sidebar menampilkan kelompok "Tertahan" berisi prompt yang ditahan.
  await expect(page.getByRole("heading", { name: "Tertahan" })).toBeVisible();
  await expect(page.getByText(PROMPT_TERTAHAN)).toBeVisible();
});
