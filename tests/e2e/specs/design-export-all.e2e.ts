import { expect, test, type Download, type Page } from "@playwright/test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BALASAN_MOCK, barisSesi, bukaBeranda } from "../helpers";

/**
 * E2E ekspor lengkap desain: HTML per frame dari menu frame, ZIP folder dan
 * proyek React dari chip Ekspor, serta prompt pemecahan komponen React yang
 * hanya menempel ke komposer (tidak mengirim).
 *
 * Folder kerja sesi memakai direktori sementara sendiri agar `design/` tidak
 * bercampur dengan spec lain.
 */

const BERANDA = `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><title>Beranda</title>
<style>body{margin:0;background:#1b3a5c;color:#fff;font-family:sans-serif}h1{padding:40px}</style>
</head>
<body><h1 id="judul">Judul Beranda</h1></body>
</html>`;

const KEDUA = `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><title>Halaman Dua</title>
<style>body{margin:0;background:#e8d9b0;color:#222;font-family:sans-serif}h1{padding:40px}</style>
</head>
<body><h1 id="judul">Judul Dua</h1></body>
</html>`;

const MANIFEST = {
  version: 1,
  pages: [
    { slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 },
    { slug: "kedua", title: "Dua", device: "desktop", x: 1520, y: 0 },
  ],
};

let dir = "";

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-export-all-"));
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

/** Baca dua byte pertama berkas unduhan (tanda tangan ZIP "PK"). */
async function duaByteAwal(unduh: Download): Promise<number[]> {
  const buf = await readFile(await unduh.path());
  return [buf[0] ?? 0, buf[1] ?? 0];
}

test("ekspor lengkap: HTML frame, ZIP folder, proyek React, prompt komponen", async ({
  page,
}) => {
  await bukaBeranda(page);
  await buatSesiDi(page, dir, "Uji e2e ekspor lengkap desain");
  await expect(page.locator('.jk-state[aria-label="Selesai"]')).toBeVisible();

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
  await writeFile(join(dir, "design", "pages", "kedua.html"), KEDUA, "utf8");
  await rm(join(dir, "design", "pages", "contoh.html"), { force: true });
  await writeFile(manifestPath, `${JSON.stringify(MANIFEST, null, 2)}\n`, "utf8");

  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();
  const kanvas = page.locator('section[aria-label="Kanvas desain"]');
  await expect(kanvas).toBeVisible();
  await expect(page.locator('iframe[title="Halaman Beranda"]')).toHaveCount(1);
  await expect(page.locator('iframe[title="Halaman Dua"]')).toHaveCount(1);

  // (a) Unduh HTML satu frame dari menu frame.
  await page.getByRole("button", { name: "Menu frame Beranda", exact: true }).click();
  const unduhanHtml = page.waitForEvent("download");
  await page.getByRole("menuitemradio", { name: "Unduh HTML", exact: true }).click();
  const html = await unduhanHtml;
  expect(html.suggestedFilename()).toBe("beranda.html");
  const isiHtml = await readFile(await html.path(), "utf8");
  expect(isiHtml).toContain("Judul Beranda");
  expect(isiHtml).not.toContain("Content-Security-Policy");

  // (b) ZIP folder desain dari chip Ekspor.
  await page.getByRole("button", { name: "Ekspor", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  const unduhanZip = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Folder desain (ZIP)", exact: true }).click();
  const zip = await unduhanZip;
  expect(zip.suggestedFilename()).toBe("design.zip");
  expect(await duaByteAwal(zip)).toEqual([0x50, 0x4b]);

  // (c) ZIP proyek React dari chip Ekspor.
  await page.getByRole("button", { name: "Ekspor", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  const unduhanReact = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Proyek React (ZIP)", exact: true }).click();
  const react = await unduhanReact;
  expect(react.suggestedFilename()).toBe("design-react.zip");
  expect(await duaByteAwal(react)).toEqual([0x50, 0x4b]);

  // (d) Prompt pemecahan komponen hanya ditempel, tidak dikirim.
  const jumlahPesanAwal = await page.locator(".jk-user").count();
  await page.getByRole("button", { name: "Ekspor", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Minta agent memecah komponen React", exact: true })
    .click();
  const pesan = page.getByLabel("Pesan lanjutan");
  await expect(pesan).toHaveValue(/tsc --noEmit/);
  const nilai = await pesan.inputValue();
  expect(nilai).toContain("beranda");
  expect(nilai).toContain("kedua");
  expect(await page.locator(".jk-user").count()).toBe(jumlahPesanAwal);
});
