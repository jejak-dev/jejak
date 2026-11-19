import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { assemblePage } from "../../../src/server/design/assemble";

/**
 * Spec mandiri untuk runtime tangkapan layar: halaman host dirakit dengan
 * `page.setContent`, isi frame dari `assemblePage` lewat `srcdoc`. PNG hasil
 * tangkapan dibaca langsung dari data URL di sisi Node.
 */

const CHANNEL = "jejak-design-v1";
const SIGNATURE_PNG = [0x89, 0x50, 0x4e, 0x47];

const HALAMAN = `<!doctype html>
<html>
<head>
<style>
  :root { --ink: #14213d; --acc: #e76f51; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Georgia, serif; background: linear-gradient(180deg, #fefae0, #faedcd); color: var(--ink); }
  .hero { padding: 64px 32px; }
  h1 { font-size: 44px; margin: 0 0 12px; }
  .btn { display: inline-block; padding: 12px 20px; border-radius: 999px; background: var(--acc); color: #fff; box-shadow: 0 6px 18px rgba(0, 0, 0, .25); }
  .kartu { border: 2px solid var(--ink); border-radius: 16px; padding: 20px; background: #fff; }
  .garis { height: 600px; background: repeating-linear-gradient(90deg, #2a9d8f, #2a9d8f 20px, #264653 20px, #264653 40px); }
</style>
</head>
<body>
  <div class="hero">
    <h1 id="judul">Halo Dunia</h1>
    <p id="paragraf">Teks paragraf contoh.</p>
    <span class="btn" id="tombol">Mulai</span>
    <div class="kartu" id="kartu">
      <img id="gambar" alt="" width="80" height="80" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Ccircle cx='40' cy='40' r='38' fill='%23e76f51'/%3E%3C/svg%3E">
      <p>Kartu dengan gambar data.</p>
    </div>
  </div>
  <div class="garis"></div>
</body>
</html>`;

const HALAMAN_TINGGI = `<!doctype html><html><head><style>
  body { margin: 0; background: #fff; }
  .blok { height: 9000px; background: linear-gradient(180deg, #fff, #222); }
</style></head><body><div class="blok"></div></body></html>`;

type Pesan = Record<string, unknown>;

function daftarPesan(page: Page): Promise<Pesan[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __pesan: Pesan[] };
    return w.__pesan;
  });
}

async function pesanBertipe(page: Page, tipe: string): Promise<Pesan[]> {
  const semua = await daftarPesan(page);
  return semua.filter((p) => p.type === tipe);
}

async function pasangFrame(page: Page, isiHalaman: string, lebar = 800): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jejak-design-capture-"));
  await mkdir(join(dir, "design", "pages"), { recursive: true });
  await writeFile(join(dir, "design", "pages", "beranda.html"), isiHalaman, "utf8");
  const html = (await assemblePage(dir, "beranda")).html;
  await rm(dir, { recursive: true, force: true });

  await page.setContent(`<!doctype html><html><body style="margin:0">
    <script>
      window.__pesan = [];
      window.addEventListener("message", function (e) { window.__pesan.push(e.data); });
    </script>
    <iframe id="frame" sandbox="allow-scripts" style="width:${lebar}px;height:600px;border:0;display:block"></iframe>
  </body></html>`);
  await page.evaluate((isi) => {
    const f = document.getElementById("frame") as HTMLIFrameElement;
    f.srcdoc = isi;
  }, html);
  await expect.poll(async () => (await pesanBertipe(page, "ready")).length).toBeGreaterThan(0);
}

async function kirimKeFrame(page: Page, data: unknown): Promise<void> {
  await page.evaluate((d) => {
    const f = document.getElementById("frame") as HTMLIFrameElement;
    f.contentWindow?.postMessage(d, "*");
  }, data);
}

/** Membaca lebar/tinggi dari header IHDR PNG (offset 16 dan 20). */
function ukuranPng(dataUrl: string): { signature: number[]; width: number; height: number } {
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  return {
    signature: Array.from(buf.subarray(0, 4)),
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

async function tungguShot(page: Page, id: string): Promise<Pesan> {
  await expect
    .poll(async () => (await pesanBertipe(page, "shot")).filter((p) => p.id === id).length)
    .toBe(1);
  return (await pesanBertipe(page, "shot")).find((p) => p.id === id) as Pesan;
}

test("capture menghasilkan satu shot PNG berukuran frame", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await kirimKeFrame(page, { channel: CHANNEL, type: "capture", id: "satu" });

  const shot = await tungguShot(page, "satu");
  expect(shot.channel).toBe(CHANNEL);
  expect(shot.id).toBe("satu");
  const dataUrl = String(shot.dataUrl);
  expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  expect(dataUrl.length).toBeGreaterThan(1024);

  const { signature, width, height } = ukuranPng(dataUrl);
  expect(signature).toEqual(SIGNATURE_PNG);
  expect(width).toBe(shot.width);
  expect(width).toBe(800);
  expect(height).toBe(shot.height);
  expect(height).toBeGreaterThan(1000);
  expect(await pesanBertipe(page, "shot-error")).toHaveLength(0);
});

test("scale 2 menghasilkan gambar dua kali", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await kirimKeFrame(page, { channel: CHANNEL, type: "capture", id: "satu" });
  const biasa = await tungguShot(page, "satu");
  await kirimKeFrame(page, { channel: CHANNEL, type: "capture", id: "dua", scale: 2 });
  const ganda = await tungguShot(page, "dua");

  const a = ukuranPng(String(biasa.dataUrl));
  const b = ukuranPng(String(ganda.dataUrl));
  expect(ganda.width).toBe(Number(biasa.width) * 2);
  expect(b.width).toBe(a.width * 2);
  expect(b.height).toBe(a.height * 2);
});

test("overlay runtime tidak ikut dan capture tetap satu balasan", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await kirimKeFrame(page, { channel: CHANNEL, type: "mode", tool: "select" });
  await kirimKeFrame(page, { channel: CHANNEL, type: "highlight", selector: "#judul" });
  await kirimKeFrame(page, { channel: CHANNEL, type: "capture", id: "satu" });

  const shot = await tungguShot(page, "satu");
  expect(String(shot.dataUrl).startsWith("data:image/png;base64,")).toBe(true);
  const balasan = (await daftarPesan(page)).filter(
    (p) => p.type === "shot" || p.type === "shot-error",
  );
  expect(balasan).toHaveLength(1);
});

test("halaman sangat tinggi dibatasi 6000 px", async ({ page }) => {
  await pasangFrame(page, HALAMAN_TINGGI);
  await kirimKeFrame(page, { channel: CHANNEL, type: "capture", id: "tinggi" });
  const shot = await tungguShot(page, "tinggi");
  expect(shot.height).toBeLessThanOrEqual(6000);
  expect(ukuranPng(String(shot.dataUrl)).height).toBeLessThanOrEqual(6000);
});

test("id tak sah tidak dibalas", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await kirimKeFrame(page, { channel: CHANNEL, type: "capture", id: "id tidak sah" });
  await kirimKeFrame(page, { channel: CHANNEL, type: "capture", id: "a".repeat(65) });
  await page.waitForTimeout(500);
  expect(await pesanBertipe(page, "shot")).toHaveLength(0);
  expect(await pesanBertipe(page, "shot-error")).toHaveLength(0);
});

test("dua capture cepat: setiap id tepat satu balasan", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await page.evaluate(() => {
    const f = document.getElementById("frame") as HTMLIFrameElement;
    f.contentWindow?.postMessage({ channel: "jejak-design-v1", type: "capture", id: "cepat-1" }, "*");
    f.contentWindow?.postMessage({ channel: "jejak-design-v1", type: "capture", id: "cepat-2" }, "*");
  });
  await expect
    .poll(async () => {
      const semua = await daftarPesan(page);
      return semua.filter((p) => p.type === "shot" || p.type === "shot-error").length;
    })
    .toBe(2);

  const semua = (await daftarPesan(page)).filter(
    (p) => p.type === "shot" || p.type === "shot-error",
  );
  expect(semua.filter((p) => p.id === "cepat-1")).toHaveLength(1);
  expect(semua.filter((p) => p.id === "cepat-2")).toHaveLength(1);
});

test("decode menggantung dibatalkan batas waktu, capture berikutnya berhasil", async ({ page }) => {
  test.setTimeout(30000);
  await pasangFrame(page, HALAMAN);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  expect(frame).toBeTruthy();

  await frame!.evaluate(() => {
    const w = window as unknown as { __decodeAsli?: () => Promise<void> };
    w.__decodeAsli = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      return new Promise<void>(function () {});
    };
  });

  const mulai = Date.now();
  await kirimKeFrame(page, { channel: CHANNEL, type: "capture", id: "gantung" });
  await expect
    .poll(
      async () => (await pesanBertipe(page, "shot-error")).filter((p) => p.id === "gantung").length,
      { timeout: 15000 },
    )
    .toBe(1);
  expect(Date.now() - mulai).toBeLessThanOrEqual(12000);

  const galat = (await pesanBertipe(page, "shot-error")).find((p) => p.id === "gantung") as Pesan;
  expect(galat.reason).toBe("failed");

  await frame!.evaluate(() => {
    const w = window as unknown as { __decodeAsli?: () => Promise<void> };
    if (w.__decodeAsli) HTMLImageElement.prototype.decode = w.__decodeAsli;
  });

  await kirimKeFrame(page, { channel: CHANNEL, type: "capture", id: "lanjut" });
  const shot = await tungguShot(page, "lanjut");
  expect(String(shot.dataUrl).startsWith("data:image/png;base64,")).toBe(true);
  expect((await pesanBertipe(page, "shot-error")).filter((p) => p.id === "lanjut")).toHaveLength(0);
});

/** Frame halaman aktif (selain halaman host). */
function bingkaiHalaman(page: Page) {
  return page.frameLocator("#frame");
}

test("pins menggambar pin bernomor di sekitar sudut kanan-atas elemen", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await kirimKeFrame(page, {
    channel: CHANNEL,
    type: "pins",
    pins: [{ id: "c_1", selector: "#tombol", n: 1, done: false }],
  });

  const pin = bingkaiHalaman(page).locator("[data-jejak-pin]");
  await expect(pin).toHaveCount(1);
  await expect(pin).toHaveText("1");
  await expect(pin).toHaveAttribute("data-status", "open");
  await expect(pin).toHaveAttribute("role", "button");
  await expect(pin).toHaveAttribute("aria-label", "Komentar 1");

  const frame = page.frames().find((f) => f !== page.mainFrame());
  expect(frame).toBeTruthy();
  const posisi = await frame!.evaluate(() => {
    const el = document.getElementById("tombol")!;
    const p = document.querySelector("[data-jejak-pin]") as HTMLElement;
    const r = el.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    return {
      dx: pr.left - r.right,
      dy: pr.top - r.top,
      lebar: pr.width,
      tinggi: pr.height,
    };
  });
  // Pin 20px ditempel perkiraan di sudut kanan-atas (geser -12).
  expect(posisi.lebar).toBe(20);
  expect(posisi.tinggi).toBe(20);
  expect(Math.abs(posisi.dx + 12)).toBeLessThanOrEqual(2);
  expect(Math.abs(posisi.dy + 12)).toBeLessThanOrEqual(2);
});

test("pin done berwarna abu dan pin tanpa elemen/selector tak sah dilewati", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await kirimKeFrame(page, {
    channel: CHANNEL,
    type: "pins",
    pins: [
      { id: "c_1", selector: "#judul", n: 2, done: true },
      { id: "c_2", selector: "#tidak-ada", n: 3, done: false },
      { id: "c_3", selector: "[[[", n: 4, done: false },
      { id: "c_4", selector: "#paragraf", n: 5, done: "ya" },
    ],
  });

  const pin = bingkaiHalaman(page).locator("[data-jejak-pin]");
  await expect(pin).toHaveCount(1);
  await expect(pin).toHaveText("2");
  await expect(pin).toHaveAttribute("data-status", "done");
  expect(await pesanBertipe(page, "shot-error")).toHaveLength(0);
});

test("pins kosong menghapus semua pin", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await kirimKeFrame(page, {
    channel: CHANNEL,
    type: "pins",
    pins: [{ id: "c_1", selector: "#judul", n: 1, done: false }],
  });
  const pin = bingkaiHalaman(page).locator("[data-jejak-pin]");
  await expect(pin).toHaveCount(1);

  await kirimKeFrame(page, { channel: CHANNEL, type: "pins", pins: [] });
  await expect(pin).toHaveCount(0);
});

test("klik pin mengirim satu pesan pin tanpa select walau mode select", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await kirimKeFrame(page, { channel: CHANNEL, type: "mode", tool: "select" });
  await kirimKeFrame(page, {
    channel: CHANNEL,
    type: "pins",
    pins: [{ id: "c_9", selector: "#judul", n: 1, done: false }],
  });

  const pin = bingkaiHalaman(page).locator("[data-jejak-pin]");
  await expect(pin).toHaveCount(1);
  await pin.click();

  await expect
    .poll(async () => (await pesanBertipe(page, "pin")).length)
    .toBe(1);
  const kirim = await pesanBertipe(page, "pin");
  expect(kirim[0]!.id).toBe("c_9");
  expect(await pesanBertipe(page, "select")).toHaveLength(0);
});

test("dua pin pada elemen sama tidak bertumpuk persis", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await kirimKeFrame(page, {
    channel: CHANNEL,
    type: "pins",
    pins: [
      { id: "c_1", selector: "#judul", n: 1, done: false },
      { id: "c_2", selector: "#judul", n: 2, done: false },
    ],
  });

  const pin = bingkaiHalaman(page).locator("[data-jejak-pin]");
  await expect(pin).toHaveCount(2);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  expect(frame).toBeTruthy();
  const kotak = await frame!.evaluate(() => {
    const semua = document.querySelectorAll("[data-jejak-pin]");
    return Array.from(semua).map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
  });
  expect(kotak).toHaveLength(2);
  expect(kotak[0]!.left).not.toBe(kotak[1]!.left);
  expect(kotak[0]!.top).toBe(kotak[1]!.top);
});

test("capture setelah pins tetap sukses dan pin dibuang dari klon", async ({ page }) => {
  await pasangFrame(page, HALAMAN);
  await kirimKeFrame(page, {
    channel: CHANNEL,
    type: "pins",
    pins: [{ id: "c_1", selector: "#judul", n: 1, done: false }],
  });
  await expect(bingkaiHalaman(page).locator("[data-jejak-pin]")).toHaveCount(1);

  const frame = page.frames().find((f) => f !== page.mainFrame());
  expect(frame).toBeTruthy();
  // Bungkus serializer di dalam frame untuk mencatat string yang diserialkan.
  await frame!.evaluate(() => {
    const w = window as unknown as { __xml?: string; __asli?: (n: Node) => string };
    const asli = XMLSerializer.prototype.serializeToString;
    w.__asli = asli;
    XMLSerializer.prototype.serializeToString = function (node: Node) {
      const hasil = asli.call(this, node);
      w.__xml = hasil;
      return hasil;
    };
  });

  await kirimKeFrame(page, { channel: CHANNEL, type: "capture", id: "satu" });
  const shot = await tungguShot(page, "satu");
  expect(String(shot.dataUrl).startsWith("data:image/png;base64,")).toBe(true);

  const xml = await frame!.evaluate(() => (window as unknown as { __xml?: string }).__xml);
  expect(typeof xml).toBe("string");
  expect(xml).not.toContain("data-jejak-pin");
});
