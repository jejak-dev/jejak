import { expect, test } from "@playwright/test";
import { BALASAN_MOCK, barisSesi, kirimPrompt, bukaBeranda } from "../helpers";

test("prompt di composer membuat sesi dan balasan mock tampil", async ({ page }) => {
  await bukaBeranda(page);

  await kirimPrompt(page, "Uji e2e sesi dasar");

  // Sesi baru muncul di sidebar dengan judul yang sama dengan prompt.
  await expect(barisSesi(page, "Uji e2e sesi dasar")).toBeVisible();

  // Balasan runner mock tampil di linimasa sesi.
  await expect(page.getByText(BALASAN_MOCK)).toBeVisible();
});
