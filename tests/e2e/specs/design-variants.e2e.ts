import { expect, test, type Page } from "@playwright/test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BALASAN_MOCK, barisSesi, bukaBeranda } from "../helpers";

/**
 * E2E varian desain: buat varian dari menu frame, lihat frame kedua dan
 * berkas barunya, kotak kelompok halaman, lalu varian dengan nama sama
 * menghasilkan slug `-2`.
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
  dir = await mkdtemp(join(tmpdir(), "jejak-design-variants-"));
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

/** Isi `design/design.json`; "" bila berkas belum ada. */
async function isiManifest(): Promise<string> {
  try {
    return await readFile(join(dir, "design", "design.json"), "utf8");
  } catch {
    return "";
  }
}

test("varian desain: buat varian, kelompok halaman, dan slug varian kedua", async ({
  page,
}) => {
  await bukaBeranda(page);
  await buatSesiDi(page, dir, "Uji e2e varian desain");
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
  await writeFile(manifestPath, `${JSON.stringify(MANIFEST, null, 2)}\n`, "utf8");

  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();
  const kanvas = page.locator('section[aria-label="Kanvas desain"]');
  await expect(kanvas).toBeVisible();
  const beranda = page.frameLocator('iframe[title="Halaman Beranda"]');
  await expect(beranda.locator("#judul")).toHaveText("Judul Beranda");

  // Menu frame membuka bagian "Varian".
  await page.getByRole("button", { name: "Menu frame Beranda", exact: true }).click();
  await expect(page.getByRole("menuitemradio", { name: "Buat varian…" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Buat varian…" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const tombolBuat = dialog.getByRole("button", { name: "Buat varian", exact: true });
  // Nama varian kosong menonaktifkan tombol simpan.
  await expect(tombolBuat).toBeDisabled();
  // Saran nama mengisi kolom varian.
  await dialog.getByRole("button", { name: "gelap", exact: true }).click();
  await expect(dialog.getByLabel("Nama varian")).toHaveValue("gelap");
  await expect(tombolBuat).toBeEnabled();
  await tombolBuat.click();
  await expect(dialog).toHaveCount(0);

  // Frame kedua muncul; muat semua supaya frame di luar layar ikut tampil.
  await page.getByRole("button", { name: "Muat semua" }).click();
  const varian = page.frameLocator('iframe[title="Halaman Beranda (gelap)"]');
  await expect(varian.locator("#judul")).toHaveText("Judul Beranda");

  // Berkas varian tersalin utuh di folder kerja sesi.
  await expect
    .poll(
      async () => {
        try {
          return await readFile(join(dir, "design", "pages", "beranda-gelap.html"), "utf8");
        } catch {
          return "";
        }
      },
      { timeout: 15_000 },
    )
    .toBe(BERANDA);

  // Kedua halaman masuk kelompok yang sama.
  await expect
    .poll(
      async () => {
        try {
          const isi = JSON.parse(await isiManifest()) as {
            pages: { slug: string; group?: string }[];
          };
          return isi.pages.map((item) => item.group ?? "").join(",");
        } catch {
          return "";
        }
      },
      { timeout: 15_000 },
    )
    .toBe("Beranda,Beranda");

  // Kotak kelompok digambar sekali.
  await expect(page.locator(".jk-design-group")).toHaveCount(1);

  // Varian dengan nama sama lagi membuat slug `-2`.
  await page.getByRole("button", { name: "Menu frame Beranda", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Buat varian…" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Nama varian").fill("gelap");
  await dialog.getByRole("button", { name: "Buat varian", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect
    .poll(
      async () => {
        try {
          await access(join(dir, "design", "pages", "beranda-gelap-2.html"));
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
});
