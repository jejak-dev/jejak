import { expect, test, type Page } from "@playwright/test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BALASAN_MOCK, barisSesi, bukaBeranda } from "../helpers";

/**
 * E2E komentar desain: pilih elemen, tambah komentar, panel daftar, ubah
 * status, kirim ke agent (tanpa mengirim), hapus, dan Esc berlapis.
 *
 * Folder kerja sesi memakai direktori sementara sendiri agar `design/` tidak
 * bercampur dengan spec lain.
 */

const BERANDA = `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><title>Beranda</title></head>
<body><h1 id="judul">Judul Beranda</h1></body>
</html>`;

const MASUK = `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><title>Masuk</title></head>
<body><h1 id="judul-masuk">Masuk</h1></body>
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
  dir = await mkdtemp(join(tmpdir(), "jejak-design-comments-"));
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

test("komentar desain: tambah, status, kirim ke agent, hapus, Esc berlapis", async ({
  page,
}) => {
  await bukaBeranda(page);
  await buatSesiDi(page, dir, "Uji e2e komentar desain");
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
  await writeFile(join(dir, "design", "pages", "masuk.html"), MASUK, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(MANIFEST, null, 2)}\n`, "utf8");

  await page.getByRole("button", { name: "Buka kanvas lebar" }).click();
  const kanvas = page.locator('section[aria-label="Kanvas desain"]');
  await expect(kanvas).toBeVisible();
  const beranda = page.frameLocator('iframe[title="Halaman Beranda"]');
  await expect(beranda.locator("#judul")).toHaveText("Judul Beranda");

  // Pilih elemen lewat alat Pilih seperti design-canvas.e2e.
  const pilih = page.getByRole("button", { name: "Pilih elemen (V)" });
  await pilih.click();
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
  await expect(info.locator(".jk-design-info-selector")).toHaveText('[id="judul"]');

  // Chip dimulai tanpa hitungan karena belum ada komentar.
  const chip = page.getByRole("button", { name: /^Komentar/ });
  await expect(chip).toHaveText("Komentar");

  // Tambah komentar dari kartu Elemen terpilih.
  await page.getByLabel("Komentar untuk elemen ini").fill("Perbesar judul");
  await page.getByRole("button", { name: "Tambah komentar" }).click();

  const panel = page.locator('aside[aria-label="Komentar desain"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Perbesar judul")).toBeVisible();
  await expect(chip).toHaveText("Komentar (1)");

  // Pin bernomor 1 muncul di frame, ditempel pada elemen berkomentar.
  const pin = beranda.locator("[data-jejak-pin]");
  await expect(pin).toHaveCount(1);
  await expect(pin).toHaveText("1");
  await expect(pin).toHaveAttribute("data-status", "open");

  // Berkas komentar tersimpan di folder kerja sesi.
  const commentsPath = join(dir, "design", "comments.json");
  await expect
    .poll(
      async () => {
        try {
          const isi = JSON.parse(await readFile(commentsPath, "utf8")) as {
            comments: { id: string; selector: string; status: string }[];
          };
          return isi.comments[0];
        } catch {
          return undefined;
        }
      },
      { timeout: 15_000 },
    )
    .toMatchObject({ selector: '[id="judul"]', status: "open" });
  const komentarId = (
    JSON.parse(await readFile(commentsPath, "utf8")) as {
      comments: { id: string }[];
    }
  ).comments[0]!.id;

  // Selesai: chip kembali tanpa hitungan, baris berstatus selesai.
  await panel.getByRole("button", { name: "Selesai" }).click();
  await expect(chip).toHaveText("Komentar");
  await expect(panel.locator(".jk-design-comment")).toHaveAttribute("data-status", "done");
  await expect(pin).toHaveAttribute("data-status", "done");

  // Tutup panel dulu, lalu klik pin: panel harus terbuka ulang dengan baris
  // komentarnya ditandai.
  await chip.click();
  await expect(panel).toHaveCount(0);
  await pin.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator(".jk-design-comment")).toHaveAttribute("aria-current", "true");
  await expect(panel.locator(".jk-design-comment")).toHaveClass(/is-focused/);

  // Buka lagi mengembalikan status open.
  await panel.getByRole("button", { name: "Buka lagi" }).click();
  await expect(chip).toHaveText("Komentar (1)");
  await expect(pin).toHaveAttribute("data-status", "open");

  // Kirim ke agent hanya menempel teks; sesi tidak mengirim apa pun.
  // Composer sudah berisi contoh prompt dari "Mulai desain"; tombol ini
  // menggantinya dengan daftar komentar, bukan menambah pesan.
  const pesan = page.getByLabel("Pesan lanjutan");
  await panel.getByRole("button", { name: "Kirim ke agent" }).click();
  await expect(pesan).toHaveValue(/design_comment_resolve/);
  await expect(pesan).toHaveValue(new RegExp(komentarId));
  await expect(page.locator('.jk-state[aria-label="Berjalan"]')).toHaveCount(0);

  // Hapus mengosongkan daftar, chip kembali "Komentar", dan pin hilang.
  await panel.getByRole("button", { name: "Hapus" }).click();
  await expect(panel.getByText("Perbesar judul")).toHaveCount(0);
  await expect(chip).toHaveText("Komentar");
  await expect(panel.getByText("Belum ada komentar.")).toBeVisible();
  await expect(beranda.locator("[data-jejak-pin]")).toHaveCount(0);

  // Esc pertama membuang pilihan; Esc kedua menutup kanvas.
  await kanvas.focus();
  await page.keyboard.press("Escape");
  await expect(info).toHaveCount(0);
  await expect(kanvas).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(kanvas).toHaveCount(0);
});
