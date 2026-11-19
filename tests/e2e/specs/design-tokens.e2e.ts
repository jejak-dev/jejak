import { expect, test, type Page } from "@playwright/test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BALASAN_MOCK, barisSesi, bukaBeranda } from "../helpers";

/**
 * E2E token desain: buka panel token, ubah nilai, simpan ke `tokens.css`,
 * lihat warna baru di frame, tambah dan hapus token, tolak nilai tak sah,
 * lalu Esc berlapis.
 *
 * Folder kerja sesi memakai direktori sementara sendiri agar `design/` tidak
 * bercampur dengan spec lain.
 */

const BERANDA = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title>Beranda</title>
<link rel="stylesheet" href="../tokens.css">
<style>
body { margin: 0; }
#kotak { width: 40px; height: 40px; background: var(--warna-aksen); }
</style>
</head>
<body><div id="kotak"></div></body>
</html>`;

const MANIFEST = {
  version: 1,
  pages: [{ slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 }],
};

let dir = "";

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-tokens-"));
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

/** Isi `design/tokens.css`; "" bila berkas belum ada. */
async function isiTokens(): Promise<string> {
  try {
    return await readFile(join(dir, "design", "tokens.css"), "utf8");
  } catch {
    return "";
  }
}

/** Isi blok otomatis dalam `design/DESIGN.md`; "" bila blok belum ada. */
async function isiBlokOtomatis(): Promise<string> {
  try {
    const isi = await readFile(join(dir, "design", "DESIGN.md"), "utf8");
    const awal = isi.indexOf("<!-- jejak:auto:start -->");
    const akhir = isi.indexOf("<!-- jejak:auto:end -->");
    if (awal === -1 || akhir === -1) return "";
    return isi.slice(awal, akhir);
  } catch {
    return "";
  }
}

test("token desain: ubah, simpan, lihat di frame, tambah, hapus, tolak nilai tak sah", async ({
  page,
}) => {
  await bukaBeranda(page);
  await buatSesiDi(page, dir, "Uji e2e token desain");
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
  await expect(beranda.locator("#kotak")).toBeVisible();

  // Chip "Token" membuka panel dengan token bawaan dari `tokens.css`.
  const chip = page.getByRole("button", { name: "Token", exact: true });
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await chip.click();
  const panel = page.locator('aside[aria-label="Token desain"]');
  await expect(panel).toBeVisible();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByText("--warna-aksen")).toBeVisible();
  await expect(panel.getByText("--jarak")).toBeVisible();

  // Ubah nilai warna aksen lalu simpan.
  const nilai = panel.getByLabel("Nilai --warna-aksen", { exact: true });
  await expect(nilai).toHaveValue("#2f6fed");
  await nilai.fill("#ff0000");
  const simpan = panel.getByRole("button", { name: /^Simpan token/ });
  await expect(simpan).toHaveText("Simpan token (1)");
  await simpan.click();

  // Berkas token di folder kerja sesi memuat nilai baru.
  await expect.poll(isiTokens, { timeout: 15_000 }).toContain("--warna-aksen: #ff0000");

  // Frame memakai warna baru: CSS di-frame di-inline ulang dari tokens.css.
  await expect
    .poll(
      async () =>
        beranda
          .locator("#kotak")
          .evaluate((el) => getComputedStyle(el).backgroundColor)
          .catch(() => ""),
      { timeout: 15_000 },
    )
    .toBe("rgb(255, 0, 0)");

  // Tambah token baru.
  await panel.getByLabel("Nama token baru", { exact: true }).fill("--warna-kustom");
  await panel.getByLabel("Nilai token baru", { exact: true }).fill("#00ff00");
  await panel.getByRole("button", { name: "Tambah token" }).click();
  await expect(panel.getByText("--warna-kustom")).toBeVisible();
  await expect(simpan).toHaveText("Simpan token (1)");
  await simpan.click();
  await expect.poll(isiTokens, { timeout: 15_000 }).toContain("--warna-kustom: #00ff00");

  // Blok otomatis DESIGN.md memuat token baru.
  await expect.poll(isiBlokOtomatis, { timeout: 15_000 }).toContain("--warna-kustom");

  // Tombol perbarui DESIGN.md menampilkan status.
  await panel.getByRole("button", { name: "Perbarui DESIGN.md" }).click();
  await expect(panel.getByRole("status")).toHaveText(/DESIGN\.md (diperbarui|sudah terbaru)\./);

  // Hapus token itu lagi.
  const baris = panel.locator("li", { hasText: "--warna-kustom" });
  await baris.getByRole("button", { name: "Hapus", exact: true }).click();
  await expect(panel.getByText("--warna-kustom")).toHaveCount(0);
  await expect(simpan).toHaveText("Simpan token (1)");
  await simpan.click();
  await expect
    .poll(async () => (await isiTokens()).includes("--warna-kustom"), { timeout: 15_000 })
    .toBe(false);

  // Nilai tak sah (mengandung ";") menonaktifkan tombol simpan.
  await nilai.fill("red; background: blue");
  await expect(simpan).toBeDisabled();
  await expect(panel.getByText("Nilai token tidak valid.")).toBeVisible();
  // Nilai sah yang berbeda mengaktifkan kembali tombol simpan.
  await nilai.fill("#00ff00");
  await expect(simpan).toBeEnabled();
  await expect(simpan).toHaveText("Simpan token (1)");

  // Token banyak: daftar bergulir sendiri, footer tetap terlihat tanpa
  // perlu menggulir panel.
  for (let index = 1; index <= 12; index += 1) {
    await panel.getByLabel("Nama token baru", { exact: true }).fill(`--warna-uji-${index}`);
    await panel.getByLabel("Nilai token baru", { exact: true }).fill("#0a0b0c");
    await panel.getByRole("button", { name: "Tambah token" }).click();
  }
  await expect(panel.getByText("--warna-uji-12")).toBeVisible();
  await expect(simpan).toBeInViewport();
  await expect(panel.getByRole("button", { name: "Perbarui DESIGN.md" })).toBeInViewport();
  // Daftar token yang bergulir tak menggeser panelnya.
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(0);

  // Tutup panel token (menutupi toolbar kiri), lalu Esc berlapis.
  await chip.click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "Pilih elemen (V)" }).click();
  const info = page.locator('aside[aria-label="Elemen terpilih"]');
  await expect
    .poll(
      async () => {
        await beranda.locator("#kotak").dispatchEvent("click");
        return info.isVisible();
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await kanvas.focus();
  await page.keyboard.press("Escape");
  await expect(info).toHaveCount(0);
  await expect(kanvas).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(kanvas).toHaveCount(0);
});
