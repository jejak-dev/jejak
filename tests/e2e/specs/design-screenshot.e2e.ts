import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { BALASAN_MOCK, barisSesi, bukaBeranda } from "../helpers";

/**
 * E2E alur tangkapan layar penuh: agent meminta (lewat rute uji
 * `POST /__uji/design-screenshot`), klien menangkap frame di kanvas, lalu
 * mengunggah PNG. Rute uji hanya ada di server e2e, tidak di `src/`.
 */

const BERANDA = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8"><title>Beranda</title>
<style>
  body { margin: 0; font-family: Georgia, serif; background: linear-gradient(180deg, #fefae0, #faedcd); color: #14213d; }
  .hero { padding: 64px 32px; }
  h1 { font-size: 44px; margin: 0 0 12px; }
  .btn { display: inline-block; padding: 12px 20px; border-radius: 999px; background: #e76f51; color: #fff; }
  .garis { height: 420px; background: repeating-linear-gradient(90deg, #2a9d8f, #2a9d8f 20px, #264653 20px, #264653 40px); }
</style>
</head>
<body>
  <div class="hero">
    <h1 id="judul">Judul Beranda</h1>
    <p>Teks contoh untuk tangkapan layar.</p>
    <span class="btn" id="tombol">Mulai</span>
  </div>
  <div class="garis"></div>
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

interface HasilTangkap {
  isError: boolean;
  text: string;
  imageBytes: number;
  width: number;
  height: number;
  mimeType: string;
}

let dir = "";
let dirTanpaKanvas = "";

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-shot-"));
  dirTanpaKanvas = await mkdtemp(join(tmpdir(), "jejak-design-shot-mati-"));
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(dirTanpaKanvas, { recursive: true, force: true });
});

/** Tulis folder desain dua halaman ke direktori kerja. */
async function tulisDesain(target: string): Promise<void> {
  await mkdir(join(target, "design", "pages"), { recursive: true });
  await writeFile(join(target, "design", "pages", "beranda.html"), BERANDA, "utf8");
  await writeFile(join(target, "design", "pages", "masuk.html"), MASUK, "utf8");
  await writeFile(
    join(target, "design", "design.json"),
    `${JSON.stringify(MANIFEST, null, 2)}\n`,
    "utf8",
  );
}

/** Buat sesi dengan folder kerja sendiri lewat composer beranda. */
async function buatSesiDi(page: Page, cwd: string, prompt: string): Promise<void> {
  await page.getByLabel("Folder kerja", { exact: true }).fill(cwd);
  await page.getByLabel("Tugas", { exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Mulai sesi" }).click();
  await expect(barisSesi(page, prompt)).toBeVisible();
  await expect(page.getByText(BALASAN_MOCK)).toBeVisible();
}

/** Id sesi yang prompt-nya cocok, dibaca dari API. */
async function idSesi(page: Page, prompt: string): Promise<string> {
  const response = await page.request.get("/api/sessions");
  const data = (await response.json()) as { sessions: Array<{ id: string; prompt: string }> };
  const sesi = data.sessions.find((item) => item.prompt === prompt);
  if (sesi === undefined) throw new Error(`sesi "${prompt}" tidak ditemukan`);
  return sesi.id;
}

/** Panggil tool `design_screenshot` lewat rute khusus uji. */
async function tangkap(
  page: Page,
  sessionId: string,
  cwd: string,
  slug: string,
  scale?: 1 | 2,
): Promise<HasilTangkap> {
  const response = await page.request.post("/__uji/design-screenshot", {
    data: { sessionId, cwd, slug, ...(scale === undefined ? {} : { scale }) },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as HasilTangkap;
}

test("kanvas menjawab tangkapan layar dan scale 2 menggandakan ukuran", async ({ page }) => {
  test.setTimeout(90_000);
  await tulisDesain(dir);
  await bukaBeranda(page);
  const prompt = "Uji e2e tangkapan layar desain";
  await buatSesiDi(page, dir, prompt);
  await expect(page.locator('.jk-state[aria-label="Selesai"]')).toBeVisible();

  await page.getByRole("button", { name: "Perubahan dan berkas" }).click();
  await page.getByRole("button", { name: "Desain", exact: true }).click();
  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();

  const kanvas = page.locator('section[aria-label="Kanvas desain"]');
  await expect(kanvas).toBeVisible();
  await expect(page.locator(".jk-design-frame iframe")).toHaveCount(2, { timeout: 15_000 });
  const beranda = page.frameLocator('iframe[title="Halaman Beranda"]');
  await expect(beranda.locator("#judul")).toHaveText("Judul Beranda");

  const sessionId = await idSesi(page, prompt);

  // (a) Halaman yang hidup di kanvas ditangkap sebagai PNG layar penuh.
  const biasa = await tangkap(page, sessionId, dir, "beranda");
  expect(biasa.isError).toBe(false);
  expect(biasa.text).toContain("Tangkapan beranda");
  expect(biasa.mimeType).toBe("image/png");
  expect(biasa.imageBytes).toBeGreaterThan(1000);
  expect(biasa.width).toBe(1440);
  expect(biasa.height).toBeGreaterThan(200);

  // (b) Scale 2 menghasilkan gambar dua kali lebih besar di kedua sisi.
  const ganda = await tangkap(page, sessionId, dir, "beranda", 2);
  expect(ganda.isError).toBe(false);
  expect(ganda.width).toBe(biasa.width * 2);
  expect(ganda.height).toBe(biasa.height * 2);
  expect(ganda.imageBytes).toBeGreaterThan(biasa.imageBytes);

  // (c) Slug yang tidak terdaftar di design.json ditolak sebelum menunggu frame.
  const asing = await tangkap(page, sessionId, dir, "tidak-ada");
  expect(asing.isError).toBe(true);
  expect(asing.text).toBe("Halaman tidak ditemukan.");
  expect(asing.imageBytes).toBe(0);
});

test("tanpa kanvas terbuka tangkapan ditolak dengan pesan membuka kanvas", async ({ page }) => {
  test.setTimeout(60_000);
  await tulisDesain(dirTanpaKanvas);
  await bukaBeranda(page);
  const prompt = "Uji e2e tangkapan tanpa kanvas";
  // Sesi dibuat lewat API agar tab Desain tak pernah dibuka di klien.
  const response = await page.request.post("/api/sessions", {
    data: { prompt, cwd: dirTanpaKanvas },
  });
  expect(response.status()).toBe(201);
  const sessionId = await idSesi(page, prompt);

  // Penonton kanvas kedaluwarsa setelah 5 detik tanpa polling stamp.
  await page.waitForTimeout(6500);

  const hasil = await tangkap(page, sessionId, dirTanpaKanvas, "beranda");
  expect(hasil.isError).toBe(true);
  expect(hasil.text).toBe("Buka kanvas desain di Jejak agar tangkapan layar tersedia.");
  expect(hasil.imageBytes).toBe(0);
});
