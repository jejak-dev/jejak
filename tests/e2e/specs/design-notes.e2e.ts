import { expect, test, type Page } from "@playwright/test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BALASAN_MOCK, barisSesi, bukaBeranda } from "../helpers";

/**
 * E2E catatan tempel di kanvas desain: buat catatan lewat chip, ketik teks,
 * seret pegangan, muat ulang kanvas, hapus catatan, lalu pastikan menyimpan
 * tata letak tidak menghapus catatan.
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
  dir = await mkdtemp(join(tmpdir(), "jejak-design-notes-"));
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

interface Catatan {
  id: string;
  x: number;
  y: number;
  text: string;
}

/** Catatan di `design/design.json`; kosong bila berkas tak ada atau rusak. */
async function bacaCatatan(): Promise<Catatan[]> {
  try {
    const isi = JSON.parse(await readFile(join(dir, "design", "design.json"), "utf8")) as {
      notes?: Catatan[];
    };
    return Array.isArray(isi.notes) ? isi.notes : [];
  } catch {
    return [];
  }
}

/** Seret elemen dari titik tengah kotaknya sejauh dx/dy piksel. */
async function seret(page: Page, locator: ReturnType<Page["locator"]>, dx: number, dy: number) {
  const kotak = await locator.boundingBox();
  if (kotak === null) throw new Error("elemen tak terlihat");
  const x = kotak.x + kotak.width / 2;
  const y = kotak.y + kotak.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("catatan desain: buat, ketik, seret, muat ulang, dan hapus", async ({ page }) => {
  await bukaBeranda(page);
  await buatSesiDi(page, dir, "Uji e2e catatan desain");
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

  // Perancah selesai dibuat: tunggu halaman contoh, lalu ganti dengan satu
  // halaman uji saja.
  await expect
    .poll(
      async () => {
        try {
          await access(join(dir, "design", "pages", "contoh.html"));
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await rm(join(dir, "design", "pages", "contoh.html"), { force: true });
  await writeFile(join(dir, "design", "pages", "beranda.html"), BERANDA, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(MANIFEST, null, 2)}\n`, "utf8");

  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();
  const kanvas = page.locator('section[aria-label="Kanvas desain"]');
  await expect(kanvas).toBeVisible();

  // Chip Catatan menambah catatan kosong di tengah viewport.
  await page.getByRole("button", { name: "Catatan", exact: true }).click();
  const kolom = page.locator('textarea[aria-label="Catatan"]');
  await expect(kolom).toHaveCount(1);
  await expect(kolom).toBeFocused();

  // Teks catatan tersimpan ke design/design.json setelah jeda singkat.
  await kolom.fill("Cek kontras tombol");
  await expect
    .poll(
      async () => (await bacaCatatan()).map((note) => `${note.id}:${note.text}`).join("|"),
      { timeout: 15_000 },
    )
    .toContain("Cek kontras tombol");

  const catatanAwal = await bacaCatatan();
  expect(catatanAwal).toHaveLength(1);
  expect(catatanAwal[0]?.id).toMatch(/^n_[0-9a-f]{8}$/);

  // Seret pegangan: posisi di berkas berubah.
  await seret(page, page.locator(".jk-design-note-handle").first(), 90, 50);
  await expect
    .poll(
      async () => {
        const notes = await bacaCatatan();
        return notes.length === 1 ? `${notes[0]?.x},${notes[0]?.y}` : "";
      },
      { timeout: 15_000 },
    )
    .not.toBe(`${catatanAwal[0]?.x},${catatanAwal[0]?.y}`);

  // Muat ulang kanvas: keluar-masuk mode lebar.
  await page.getByRole("button", { name: "Keluar dari mode lebar" }).click();
  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();
  await expect(page.locator('section[aria-label="Kanvas desain"]')).toBeVisible();
  const kolomLama = page.locator('textarea[aria-label="Catatan"]');
  await expect(kolomLama).toHaveCount(1);
  await expect(kolomLama).toHaveValue("Cek kontras tombol");

  // Catatan kedua, lalu hapus lewat tombol "Hapus catatan".
  await page.getByRole("button", { name: "Catatan", exact: true }).click();
  await expect(page.locator('textarea[aria-label="Catatan"]')).toHaveCount(2);
  await page.locator('textarea[aria-label="Catatan"]').nth(1).fill("Catatan kedua");
  await expect
    .poll(async () => (await bacaCatatan()).length, { timeout: 15_000 })
    .toBe(2);

  await page
    .locator(".jk-design-note")
    .nth(1)
    .getByRole("button", { name: "Hapus catatan" })
    .click();
  await expect
    .poll(async () => (await bacaCatatan()).length, { timeout: 15_000 })
    .toBe(1);
  const tersisa = await bacaCatatan();
  expect(tersisa[0]?.text).toBe("Cek kontras tombol");

  // Menyimpan tata letak (geser frame) tak menghapus catatan.
  await seret(page, page.locator(".jk-design-frame-label").first(), 60, 30);
  await expect
    .poll(
      async () => {
        const notes = await bacaCatatan();
        return notes.length === 1 ? notes[0]?.text ?? "" : "";
      },
      { timeout: 15_000 },
    )
    .toBe("Cek kontras tombol");
});
