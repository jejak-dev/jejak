import { expect, test, type Page } from "@playwright/test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BALASAN_MOCK, barisSesi, bukaBeranda } from "../helpers";

/**
 * E2E mode fokus: kanvas mengisi seluruh jendela utama, header sesi hilang,
 * baris pesan melayang di bawah-tengah, dan draf tidak hilang saat keluar-masuk
 * fokus.
 *
 * Folder kerja sesi memakai direktori sementara sendiri agar `design/` tidak
 * bercampur dengan spec lain.
 */

const BERANDA = `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><title>Beranda</title></head>
<body><h1 id="judul">Judul Beranda</h1></body>
</html>`;

const MANIFEST = {
  version: 1,
  pages: [{ slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 }],
};

let dir = "";

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-focus-"));
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Buat sesi dengan folder kerja sendiri, bukan `CWD_UJI` bersama. */
async function buatSesiDi(page: Page, cwd: string, prompt: string): Promise<void> {
  await page.getByLabel("Folder kerja", { exact: true }).fill(cwd);
  await page.getByLabel("Tugas", { exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Mulai sesi" }).click();
  await expect(barisSesi(page, prompt)).toBeVisible();
  await expect(page.getByText(BALASAN_MOCK)).toBeVisible();
}

/** Siapkan satu halaman desain lalu buka kanvas lebar. */
async function bukaKanvas(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Perubahan dan berkas" }).click();
  await page.getByRole("button", { name: "Desain", exact: true }).click();
  await page.getByRole("button", { name: "Mulai desain" }).click();

  const manifestPath = join(dir, "design", "design.json");
  await expect
    .poll(
      async () => {
        try {
          await access(manifestPath);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  await writeFile(join(dir, "design", "pages", "beranda.html"), BERANDA, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(MANIFEST, null, 2)}\n`, "utf8");

  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();
  await expect(page.locator('section[aria-label="Kanvas desain"]')).toBeVisible();
}

test("mode fokus: kanvas penuh, header hilang, pesan melayang, draf bertahan", async ({
  page,
}) => {
  await bukaBeranda(page);
  await buatSesiDi(page, dir, "Uji e2e mode fokus desain");
  await expect(page.locator('.jk-state[aria-label="Selesai"]')).toBeVisible();

  await bukaKanvas(page);

  const body = page.locator(".jk-main-body");
  const kanvas = page.locator('section[aria-label="Kanvas desain"]');
  const pesan = page.getByLabel("Pesan lanjutan");
  const ukuran = page.viewportSize();
  expect(ukuran).not.toBeNull();

  // (a) Tombol "Mode fokus" ada dan menyalakan mode fokus.
  const tombolFokus = page.getByRole("button", { name: "Mode fokus" });
  await expect(tombolFokus).toBeVisible();
  await expect(tombolFokus).toHaveAttribute("aria-pressed", "false");

  const lebarSebelum = (await kanvas.boundingBox())?.width ?? 0;
  await tombolFokus.click();

  await expect(body).toHaveClass(/is-design-focus/);
  // Header sesi disembunyikan lewat `.jk-main.is-design-focus > .jk-top`.
  await expect(page.locator("header.jk-top")).toBeHidden();
  // Kolom pesan tetap ada dan melayang di bawah-tengah jendela.
  await expect(pesan).toBeVisible();
  const kotakPesan = await pesan.boundingBox();
  expect(kotakPesan).not.toBeNull();
  const tengahPesan = kotakPesan!.x + kotakPesan!.width / 2;
  // Toleransi memberi ruang untuk pembulatan subpiksel dan scrollbar.
  expect(Math.abs(tengahPesan - ukuran!.width / 2)).toBeLessThanOrEqual(48);
  const kotakKartu = await page.locator("form.jk-reply").boundingBox();
  expect(kotakKartu).not.toBeNull();
  // Tepi bawah kartu dekat tepi bawah jendela.
  expect(ukuran!.height - (kotakKartu!.y + kotakKartu!.height)).toBeLessThanOrEqual(40);
  // Kanvas melebar mendekati seluruh lebar jendela.
  const lebarFokus = (await kanvas.boundingBox())?.width ?? 0;
  expect(lebarFokus).toBeGreaterThan(ukuran!.width * 0.85);
  expect(lebarFokus).toBeGreaterThan(lebarSebelum);

  // (b) Draf di kolom pesan tidak hilang dan ReplyBar tidak dipasang ulang.
  await pesan.fill("draf mode fokus");
  await pesan.evaluate((el) => {
    el.setAttribute("data-jk-penanda", "1");
  });
  await page.getByRole("button", { name: "Keluar dari fokus" }).click();
  await expect(body).not.toHaveClass(/is-design-focus/);
  await page.getByRole("button", { name: "Mode fokus" }).click();
  await expect(body).toHaveClass(/is-design-focus/);
  await expect(pesan).toHaveValue("draf mode fokus");
  await expect(pesan).toHaveAttribute("data-jk-penanda", "1");

  // (c) Chip berubah menjadi "Keluar dari fokus" dan mengembalikannya.
  await expect(page.getByRole("button", { name: "Keluar dari fokus" })).toBeVisible();
  await page.getByRole("button", { name: "Keluar dari fokus" }).click();
  await expect(body).not.toHaveClass(/is-design-focus/);
  await expect(page.locator("header.jk-top")).toBeVisible();

  // (d) Pintasan "f" mengalihkan fokus; kanvas harus difokus dulu.
  await kanvas.focus();
  await page.keyboard.press("f");
  await expect(body).toHaveClass(/is-design-focus/);
  await kanvas.focus();
  await page.keyboard.press("f");
  await expect(body).not.toHaveClass(/is-design-focus/);

  // (e) Esc berlapis: keluar fokus dulu, baru keluar mode lebar.
  await kanvas.focus();
  await page.keyboard.press("f");
  await expect(body).toHaveClass(/is-design-focus/);
  await kanvas.focus();
  await page.keyboard.press("Escape");
  await expect(body).not.toHaveClass(/is-design-focus/);
  await expect(kanvas).toBeVisible();
  await kanvas.focus();
  await page.keyboard.press("Escape");
  await expect(kanvas).toHaveCount(0);

  // (f) Keluar dari mode lebar mematikan fokus; membuka lagi tidak meng hidupkan.
  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();
  await expect(kanvas).toBeVisible();
  await page.getByRole("button", { name: "Mode fokus" }).click();
  await expect(body).toHaveClass(/is-design-focus/);
  await page.getByRole("button", { name: "Keluar dari mode lebar" }).click();
  await expect(body).not.toHaveClass(/is-design-focus/);
  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();
  await expect(kanvas).toBeVisible();
  await expect(body).not.toHaveClass(/is-design-focus/);
});
