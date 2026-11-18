import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { BALASAN_MOCK, barisSesi, bukaBeranda } from "../helpers";

/**
 * E2E kanvas desain: perancah, dua frame, muat ulang tanpa reload halaman,
 * alat Pilih, sisip ke pesan, Esc berlapis, dan isolasi jaringan frame.
 *
 * Folder kerja sesi memakai direktori sementara sendiri (bukan `CWD_UJI`
 * bersama) supaya berkas `design/` tidak bercampur dengan spec lain.
 */

const BERANDA_AWAL = `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><title>Beranda</title></head>
<body>
  <h1 id="judul">Judul Beranda</h1>
  <button id="tombol">Klik</button>
  <img src="https://contoh.test/x.png" alt="contoh">
  <script>fetch("https://contoh.test/ping").catch(function () { window.__gagal = true; });</script>
</body>
</html>`;

const BERANDA_BARU = `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><title>Beranda</title></head>
<body>
  <h1 id="judul">Judul Beranda Baru</h1>
  <button id="tombol">Klik</button>
  <img src="https://contoh.test/x.png" alt="contoh">
  <script>fetch("https://contoh.test/ping").catch(function () { window.__gagal = true; });</script>
</body>
</html>`;

const MASUK = `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><title>Masuk</title></head>
<body><h1 id="judul">Masuk</h1></body>
</html>`;

const MANIFEST = {
  version: 1,
  pages: [
    { slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 },
    { slug: "masuk", title: "Masuk", device: "mobile", x: 1520, y: 0 },
  ],
};

let dir = "";

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-canvas-"));
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

test("kanvas desain: dua frame, muat ulang, pilih, sisip, Esc, jaringan terblokir", async ({
  page,
}) => {
  // Permintaan yang diblokir CSP tetap memicu event `request` (lalu gagal),
  // jadi isolasi jaringan diperiksa lewat `requestfinished`: tak ada yang tuntas.
  const permintaan: string[] = [];
  const selesai: string[] = [];
  const galatHalaman: string[] = [];
  page.on("request", (request) => permintaan.push(request.url()));
  page.on("requestfinished", (request) => selesai.push(request.url()));
  page.on("pageerror", (error) => galatHalaman.push(error.message));

  await bukaBeranda(page);
  await buatSesiDi(page, dir, "Uji e2e kanvas desain");
  // Perancah desain menolak sesi yang masih berjalan; tunggu giliran selesai.
  await expect(page.locator('.jk-state[aria-label="Selesai"]')).toBeVisible();

  // Panel kanan lalu tab Desain lewat rel ikon.
  await page.getByRole("button", { name: "Perubahan dan berkas" }).click();
  await page.getByRole("button", { name: "Desain", exact: true }).click();

  const mulai = page.getByRole("button", { name: "Mulai desain" });
  await expect(mulai).toBeVisible();
  await mulai.click();

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

  // Dua halaman uji menggantikan contoh bawaan supaya tepat dua frame.
  await writeFile(join(dir, "design", "pages", "beranda.html"), BERANDA_AWAL, "utf8");
  await writeFile(join(dir, "design", "pages", "masuk.html"), MASUK, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(MANIFEST, null, 2)}\n`, "utf8");
  await rm(join(dir, "design", "pages", "contoh.html"), { force: true });

  // Kanvas hanya dipasang di mode lebar.
  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();

  const kanvas = page.locator('section[aria-label="Kanvas desain"]');
  await expect(kanvas).toBeVisible();

  const iframes = page.locator(".jk-design-frame iframe");
  await expect(iframes).toHaveCount(2, { timeout: 15_000 });
  await expect(iframes.first()).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframes.nth(1)).toHaveAttribute("sandbox", "allow-scripts");

  const beranda = page.frameLocator('iframe[title="Halaman Beranda"]');
  await expect(beranda.locator("#judul")).toHaveText("Judul Beranda");

  // Ubah berkas di disk: polling memuat ulang frame tanpa reload halaman.
  await writeFile(join(dir, "design", "pages", "beranda.html"), BERANDA_BARU, "utf8");
  await expect(beranda.locator("#judul")).toHaveText("Judul Beranda Baru", {
    timeout: 15_000,
  });

  // Alat Pilih: klik elemen di dalam frame. Transform CSS pada dunia kanvas
  // membuat klik berbasis koordinat tak andal, jadi event dikirim langsung.
  const pilih = page.getByRole("button", { name: "Pilih elemen (V)" });
  await pilih.click();
  await expect(pilih).toHaveAttribute("aria-pressed", "true");

  const info = page.locator('aside[aria-label="Elemen terpilih"]');
  await expect
    .poll(
      async () => {
        await beranda.locator("#judul").dispatchEvent("click");
        return info.isVisible();
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  // Runtime memilih selector berjangkar id dalam bentuk `[id="judul"]`.
  await expect(info.locator(".jk-design-info-selector")).toHaveText('[id="judul"]');
  await expect(info.locator(".jk-design-info-text")).toHaveText("Judul Beranda Baru");

  await page.getByRole("button", { name: "Sisipkan ke pesan" }).click();
  const pesan = page.getByLabel("Pesan lanjutan");
  await expect(pesan).toHaveValue(
    /Elemen terpilih di halaman[\s\S]*design\/pages\/beranda\.html/,
  );

  // Skrip halaman gagal menghubungi jaringan dan menandainya. Diperiksa
  // sebelum kanvas ditutup karena handle frame hilang bersama iframe-nya.
  const handle = await page.locator('iframe[title="Halaman Beranda"]').elementHandle();
  const frame = await handle?.contentFrame();
  if (frame === null || frame === undefined) throw new Error("frame beranda tidak ditemukan");
  await expect
    .poll(
      async () =>
        frame.evaluate(
          () => (window as unknown as { __gagal?: boolean }).__gagal === true,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  // Esc pertama membuang pilihan; Esc kedua menutup kanvas.
  await kanvas.focus();
  await page.keyboard.press("Escape");
  await expect(info).toHaveCount(0);
  await expect(kanvas).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(kanvas).toHaveCount(0);

  // Jaringan frame diblokir CSP: tak ada permintaan ke host uji yang tuntas.
  const keContoh = permintaan.filter((url) => url.includes("contoh.test"));
  expect(keContoh.filter((url) => selesai.includes(url))).toHaveLength(0);
  expect(galatHalaman).toHaveLength(0);
});
