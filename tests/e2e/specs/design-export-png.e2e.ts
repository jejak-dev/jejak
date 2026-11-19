import { expect, test, type Download, type Page } from "@playwright/test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BALASAN_MOCK, barisSesi, bukaBeranda } from "../helpers";

/**
 * E2E ekspor PNG desain: unduh PNG satu frame (1x dan 2x) dari menu frame,
 * lalu PNG seluruh kanvas dari chip Ekspor. Nama berkas dan ukuran IHDR PNG
 * diperiksa dari berkas yang benar-benar diunduh.
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

const SIGNATURE_PNG = [0x89, 0x50, 0x4e, 0x47];
/** Lebar frame desktop. */
const LEBAR_FRAME = 1440;

let dir = "";

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-export-png-"));
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

/** Baca header PNG: tanda tangan dan ukuran IHDR. */
async function bacaPng(unduh: Download): Promise<{ signature: number[]; width: number; height: number }> {
  const jalur = await unduh.path();
  const buf = await readFile(jalur);
  return {
    signature: Array.from(buf.subarray(0, 4)),
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

test("ekspor PNG: satu frame 1x dan 2x, lalu seluruh kanvas", async ({ page }) => {
  await bukaBeranda(page);
  await buatSesiDi(page, dir, "Uji e2e ekspor PNG desain");
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
  // Halaman contoh dari perancah dibuang: desain uji hanya dua halaman.
  await rm(join(dir, "design", "pages", "contoh.html"), { force: true });
  await writeFile(manifestPath, `${JSON.stringify(MANIFEST, null, 2)}\n`, "utf8");

  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();
  const kanvas = page.locator('section[aria-label="Kanvas desain"]');
  await expect(kanvas).toBeVisible();
  await expect(page.locator('iframe[title="Halaman Beranda"]')).toHaveCount(1);
  await expect(page.locator('iframe[title="Halaman Dua"]')).toHaveCount(1);

  // (a) Unduh PNG satu frame dari menu frame.
  await page.getByRole("button", { name: "Menu frame Beranda", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "Unduh PNG", exact: true })).toBeVisible();
  const unduhanSatu = page.waitForEvent("download");
  await page.getByRole("menuitemradio", { name: "Unduh PNG", exact: true }).click();
  const satu = await unduhanSatu;
  expect(satu.suggestedFilename()).toBe("beranda.png");
  const gambarSatu = await bacaPng(satu);
  expect(gambarSatu.signature).toEqual(SIGNATURE_PNG);
  expect(gambarSatu.width).toBe(LEBAR_FRAME);

  // (b) Unduh PNG 2x: lebar dua kali dan nama berkas memakai @2x.
  await page.getByRole("button", { name: "Menu frame Beranda", exact: true }).click();
  const unduhanDua = page.waitForEvent("download");
  await page.getByRole("menuitemradio", { name: "Unduh PNG 2x", exact: true }).click();
  const dua = await unduhanDua;
  expect(dua.suggestedFilename()).toBe("beranda@2x.png");
  const gambarDua = await bacaPng(dua);
  expect(gambarDua.signature).toEqual(SIGNATURE_PNG);
  expect(gambarDua.width).toBe(LEBAR_FRAME * 2);

  // (d) Selama ekspor, chip Ekspor dinonaktifkan dan status tampil.
  await page.evaluate(() => {
    const w = window as unknown as {
      __ekspor?: { nonaktif: boolean; status: boolean };
    };
    w.__ekspor = { nonaktif: false, status: false };
    const cek = (): void => {
      const chip = document.querySelector(".jk-design-export > button");
      if (chip?.hasAttribute("disabled") === true) w.__ekspor!.nonaktif = true;
      if (document.querySelector(".jk-design-export-status") !== null) {
        w.__ekspor!.status = true;
      }
    };
    new MutationObserver(cek).observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true,
    });
  });

  const jumlahIframeAwal = await page.locator(".jk-design-frame iframe").count();

  // (c) Ekspor PNG seluruh kanvas dari chip Ekspor.
  await page.getByRole("button", { name: "Ekspor", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  const unduhanKanvas = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "PNG seluruh kanvas", exact: true }).click();
  const kanvasPng = await unduhanKanvas;
  expect(kanvasPng.suggestedFilename()).toBe("kanvas-desain.png");
  const gambarKanvas = await bacaPng(kanvasPng);
  expect(gambarKanvas.signature).toEqual(SIGNATURE_PNG);
  // Dua frame tersusun: kanvas lebih lebar daripada satu frame.
  expect(gambarKanvas.width).toBeGreaterThan(LEBAR_FRAME);
  expect(gambarKanvas.height).toBeGreaterThan(0);

  // (d) Status ekspor pernah tampil dan chip pernah dinonaktifkan.
  const jejak = await page.evaluate(() => {
    const w = window as unknown as { __ekspor?: { nonaktif: boolean; status: boolean } };
    return w.__ekspor;
  });
  expect(jejak?.status).toBe(true);
  expect(jejak?.nonaktif).toBe(true);

  // (e) Jumlah iframe hidup kembali seperti semula.
  await expect
    .poll(async () => page.locator(".jk-design-frame iframe").count())
    .toBe(jumlahIframeAwal);
});
