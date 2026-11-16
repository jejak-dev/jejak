import { expect, test } from "@playwright/test";
import { buatSesi, bukaBeranda } from "../helpers";

test("tab Konteks di panel kanan menampilkan blok Pemakaian dan Alat", async ({ page }) => {
  await bukaBeranda(page);
  await buatSesi(page, "Uji e2e panel konteks");

  // Panel kanan dibuka lewat tombol di header sesi.
  await page.getByRole("button", { name: "Perubahan dan berkas" }).click();

  // Rel ikon panel: tombol berlabel "Konteks".
  await page.getByRole("button", { name: "Konteks", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Pemakaian" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Alat" })).toBeVisible();
  // Alat yang dipakai runner mock (Read) tercatat di tabel alat.
  await expect(page.getByRole("cell", { name: "Read" })).toBeVisible();
});
