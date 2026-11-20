import { expect, test, type Page } from "@playwright/test";
import { parseFigBuffer } from "@open-pencil/fig";
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
<style>
body{margin:0;background:#f2ede0;color:#222;font-family:Georgia,serif}
nav{display:flex;gap:24px;align-items:center;padding:20px 40px;border-bottom:1px solid #c9bfa6}
nav b{font-size:20px;margin-right:auto}
nav a{color:#222;text-decoration:none;font-size:15px}
h1{margin:0;padding:40px 40px 0;font-size:40px;font-weight:700}
p.lead{margin:12px 40px 0;max-width:560px;font-size:18px;line-height:1.5;color:#4a443a}
#tombol{display:block;margin:24px 40px;width:240px;height:56px;background:#b3261e;color:#fff;border:2px solid #000;border-radius:12px;font-size:18px}
.kartu{display:flex;gap:20px;padding:0 40px 40px}
.kartu div{flex:1;background:#fff;border:1px solid #d8cfb8;border-radius:16px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.kartu h2{margin:0 0 8px;font-size:22px}
.kartu span{font-size:14px;color:#6b6456}
input{margin:0 40px 40px;padding:10px 12px;width:320px;border:1px solid #888;border-radius:6px;font-size:16px}
</style>
</head>
<body>
<nav><b>Rumah Tepi Danau</b><a href="#">Kamar</a><a href="#">Galeri</a><a href="#">Kontak</a></nav>
<div id="banner" style="margin:0 40px;height:60px;border-radius:12px;background:linear-gradient(90deg,#b3261e,#f2c94c)"></div>
<h1 id="judul">Rumah Tepi Danau</h1>
<p class="lead">Penginapan kecil di tepi danau, lima kamar, sarapan dari kebun sendiri.</p>
<button id="tombol">Pesan sekarang</button>
<div class="kartu">
<div><h2>Kamar Danau</h2><span>Rp 850.000 per malam</span></div>
<div><h2>Kamar Kebun</h2><span>Rp 650.000 per malam</span></div>
<div><h2>Paviliun</h2><span>Rp 1.200.000 per malam</span></div>
</div>
<img id="foto" alt="" width="400" height="240" style="margin:0 40px 40px;object-fit:cover;box-shadow:0 6px 16px rgba(0,0,0,.2);border-radius:12px" src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22400%22%20height%3D%22240%22%3E%3Crect%20width%3D%22400%22%20height%3D%22240%22%20fill%3D%22%239ec5d8%22%2F%3E%3Ccircle%20cx%3D%22300%22%20cy%3D%2260%22%20r%3D%2230%22%20fill%3D%22%23f2c94c%22%2F%3E%3Crect%20y%3D%22150%22%20width%3D%22400%22%20height%3D%2290%22%20fill%3D%22%233f7a9b%22%2F%3E%3C%2Fsvg%3E">
<svg id="ikon" width="40" height="40" viewBox="0 0 40 40" style="margin:0 40px"><circle cx="20" cy="20" r="18" fill="#b3261e"/></svg>
<input placeholder="Email untuk kabar kamar kosong">
</body>
</html>`;

const MANIFEST = {
  version: 1,
  pages: [{ slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 }],
};

let dir = "";

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-export-fig-"));
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

interface NodeBaca {
  effects?: unknown[];
  fillPaints?: Array<{ type: string }>;
  type: string;
  name: string;
  size?: { x: number; y: number };
  textData?: { characters: string };
  strokeWeight?: number;
  stackMode?: string;
  cornerRadius?: number;
}

test("ekspor Figma: frame, tombol, dan teks dibaca balik dari berkas .fig", async ({ page }) => {
  await bukaBeranda(page);
  await buatSesiDi(page, dir, "Uji e2e ekspor Figma");
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
  await rm(join(dir, "design", "pages", "contoh.html"), { force: true });
  await writeFile(manifestPath, `${JSON.stringify(MANIFEST, null, 2)}\n`, "utf8");

  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();
  await expect(page.locator('section[aria-label="Kanvas desain"]')).toBeVisible();
  await expect(page.locator('iframe[title="Halaman Beranda"]')).toHaveCount(1);

  await page.getByRole("button", { name: "Ekspor", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  const unduhan = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Berkas Figma (.fig)", exact: true }).click();
  const berkas = await unduhan;
  expect(berkas.suggestedFilename()).toBe("design.fig");
  // Opsional: simpan hasil untuk dibuka manual di Figma.
  if (process.env.FIG_OUT !== undefined) await berkas.saveAs(process.env.FIG_OUT);

  const buf = await readFile(await berkas.path());
  const salinan = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const hasil = await parseFigBuffer(salinan);
  const nodes = hasil.nodeChanges as unknown as NodeBaca[];

  expect(nodes.filter((n) => n.type === "CANVAS").map((n) => n.name)).toEqual(["Beranda"]);
  const teks = nodes.filter((n) => n.type === "TEXT").map((n) => n.textData?.characters);
  expect(teks).toContain("Rumah Tepi Danau");
  expect(teks).toContain("Pesan sekarang");
  const tombol = nodes.find((n) => n.type === "FRAME" && n.name === "button#tombol");
  expect(tombol).toBeDefined();
  expect(tombol?.size?.x).toBe(240);
  expect(tombol?.size?.y).toBe(56);
  expect(tombol?.strokeWeight).toBe(2);
  expect(tombol?.cornerRadius).toBe(12);
  // Gambar dan svg masuk arsip sebagai gambar; bayangan kartu menjadi efek.
  expect(hasil.images.length).toBeGreaterThanOrEqual(2);
  const gambar = nodes.filter((n) => n.name.startsWith("gambar:"));
  expect(gambar.length).toBe(2);
  for (const g of gambar) {
    expect(g.fillPaints?.some((p) => p.type === "IMAGE")).toBe(true);
    // Tanpa abu-abu cadangan di bawah gambar yang berhasil dirasterisasi.
    expect(g.fillPaints?.some((p) => p.type === "SOLID")).toBe(false);
  }
  expect(nodes.some((n) => (n.effects?.length ?? 0) > 0)).toBe(true);
  // Gradien linear dan auto layout (deretan kartu flex).
  const banner = nodes.find((n) => n.name === "div#banner");
  expect(banner?.fillPaints?.some((p) => p.type === "GRADIENT_LINEAR")).toBe(true);
  expect(nodes.some((n) => n.stackMode === "HORIZONTAL")).toBe(true);
});
