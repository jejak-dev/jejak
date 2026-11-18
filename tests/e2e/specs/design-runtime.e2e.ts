import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Frame, type Page } from "@playwright/test";
import { assemblePage } from "../../../src/server/design/assemble";

/**
 * Spec mandiri: tidak memakai server aplikasi. Halaman host dirakit dengan
 * `page.setContent`, isi frame berasal dari `assemblePage` lewat `srcdoc`.
 */

const CHANNEL = "jejak-design-v1";

const HALAMAN = `<!doctype html>
<html>
<head>
<style>
  body { margin: 0; font-family: sans-serif; min-height: 1400px; }
  h1, button, a, img, .kartu, .dupe { display: block; margin: 20px; }
  .dupe { padding: 10px; border: 1px solid #ccc; }
</style>
</head>
<body>
  <h1 id="judul">Judul Halaman</h1>
  <div class="kartu" data-testid="kartu">Kartu Uji</div>
  <span class="dupe dupe-satu">Duplikat satu</span>
  <span class="dupe dupe-dua">Duplikat dua</span>
  <button id="tombol">Klik Saya</button>
  <a id="luar" href="https://contoh.test/">Tautan luar</a>
  <a id="dalam" href="#a">Tautan dalam</a>
  <img id="gambar" alt="titik" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">
  <div id="penanda">Konten asli</div>
</body>
</html>`;

let dir: string;
let html: string;

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-e2e-"));
  await mkdir(join(dir, "design", "pages"), { recursive: true });
  await writeFile(join(dir, "design", "pages", "beranda.html"), HALAMAN, "utf8");
  html = (await assemblePage(dir, "beranda")).html;
});

test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

async function pasangFrame(page: Page): Promise<Frame> {
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <script>
      window.__pesan = [];
      window.addEventListener("message", function (e) { window.__pesan.push(e.data); });
    </script>
    <iframe id="frame" sandbox="allow-scripts" style="width:800px;height:600px;border:0;display:block"></iframe>
  </body></html>`);
  await page.evaluate((isi) => {
    const f = document.getElementById("frame") as HTMLIFrameElement;
    f.srcdoc = isi;
  }, html);
  await expect.poll(async () => (await pesanBertipe(page, "ready")).length).toBeGreaterThan(0);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error("frame desain tidak ditemukan");
  return frame;
}

async function kirimKeFrame(page: Page, data: unknown): Promise<void> {
  await page.evaluate((d) => {
    const f = document.getElementById("frame") as HTMLIFrameElement;
    f.contentWindow?.postMessage(d, "*");
  }, data);
}

async function titik(frame: Frame, selector: string): Promise<{ x: number; y: number }> {
  return frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { x: -1, y: -1 };
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
}

async function titikHalaman(
  page: Page,
  frame: Frame,
  selector: string,
): Promise<{ x: number; y: number }> {
  const kotak = await page.locator("#frame").boundingBox();
  if (!kotak) throw new Error("iframe tak terlihat");
  const lokal = await titik(frame, selector);
  return { x: kotak.x + lokal.x, y: kotak.y + lokal.y };
}

async function periksaSelector(
  frame: Frame,
  selector: string,
  teks: string,
): Promise<void> {
  const hasil = await frame.evaluate((sel) => {
    const els = document.querySelectorAll(sel);
    return { jumlah: els.length, teks: els[0]?.textContent?.trim() ?? "" };
  }, selector);
  expect(hasil.jumlah).toBe(1);
  expect(hasil.teks).toContain(teks);
}

test("ready dikirim dengan slug", async ({ page }) => {
  await pasangFrame(page);
  const ready = await pesanBertipe(page, "ready");
  expect(ready[0]?.slug).toBe("beranda");
  expect(ready[0]?.channel).toBe(CHANNEL);
});

test("size mengikuti tinggi isi", async ({ page }) => {
  const frame = await pasangFrame(page);
  await expect.poll(async () => (await pesanBertipe(page, "size")).length).toBeGreaterThan(0);
  const ukuran = await pesanBertipe(page, "size");
  const terakhir = ukuran[ukuran.length - 1] as { height: number } | undefined;
  const nyata = await frame.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  expect(terakhir?.height).toBe(nyata);
  expect(terakhir?.height).toBeGreaterThanOrEqual(1200);
});

test("mode select: hover dan klik memberi selector yang tepat", async ({ page }) => {
  const frame = await pasangFrame(page);
  await kirimKeFrame(page, { channel: CHANNEL, type: "mode", tool: "select" });

  const judul = await titikHalaman(page, frame, "#judul");
  await page.mouse.move(judul.x, judul.y);
  await expect.poll(async () => (await pesanBertipe(page, "hover")).length).toBeGreaterThan(0);
  const hover = (await pesanBertipe(page, "hover")).at(-1) as Pesan;
  expect(hover.tag).toBe("h1");
  expect(hover.label).toBe("Teks");

  await page.mouse.click(judul.x, judul.y);
  await expect.poll(async () => (await pesanBertipe(page, "select")).length).toBe(1);
  const olehId = (await pesanBertipe(page, "select")).at(-1) as Pesan;
  expect(olehId.selector).toBe('[id="judul"]');
  await periksaSelector(frame, String(olehId.selector), "Judul Halaman");

  const kartu = await titikHalaman(page, frame, '[data-testid="kartu"]');
  await page.mouse.click(kartu.x, kartu.y);
  await expect.poll(async () => (await pesanBertipe(page, "select")).length).toBe(2);
  const olehTestid = (await pesanBertipe(page, "select")).at(-1) as Pesan;
  expect(olehTestid.selector).toBe('[data-testid="kartu"]');
  await periksaSelector(frame, String(olehTestid.selector), "Kartu Uji");

  const duplikat = await titikHalaman(page, frame, ".dupe-dua");
  await page.mouse.click(duplikat.x, duplikat.y);
  await expect.poll(async () => (await pesanBertipe(page, "select")).length).toBe(3);
  const olehRantai = (await pesanBertipe(page, "select")).at(-1) as Pesan;
  await periksaSelector(frame, String(olehRantai.selector), "Duplikat dua");
  expect(String(olehRantai.selector)).not.toContain("[id=");
});

test("mode preview: klik tombol tidak mengirim select", async ({ page }) => {
  const frame = await pasangFrame(page);
  const tombol = await titikHalaman(page, frame, "#tombol");
  await page.mouse.click(tombol.x, tombol.y);
  await page.waitForTimeout(200);
  expect(await pesanBertipe(page, "select")).toHaveLength(0);
});

test("tautan luar menampilkan toast dan tidak berpindah", async ({ page }) => {
  const frame = await pasangFrame(page);
  const luar = await titikHalaman(page, frame, "#luar");
  await page.mouse.click(luar.x, luar.y);
  await expect(frame.locator("[data-jejak-toast]")).toBeVisible();
  await expect(frame.locator("[data-jejak-toast]")).toContainText("Tautan luar tidak dibuka dari frame");
  await expect(frame.locator("#penanda")).toBeVisible();
});

test("tautan # memicu route", async ({ page }) => {
  const frame = await pasangFrame(page);
  const dalam = await titikHalaman(page, frame, "#dalam");
  await page.mouse.click(dalam.x, dalam.y);
  await expect.poll(async () => (await pesanBertipe(page, "route")).length).toBeGreaterThan(0);
  const rute = (await pesanBertipe(page, "route")).at(-1) as Pesan;
  expect(rute.hash).toBe("#a");
});

test("wheel dengan Ctrl diteruskan", async ({ page }) => {
  await pasangFrame(page);
  const kotak = await page.locator("#frame").boundingBox();
  if (!kotak) throw new Error("iframe tak terlihat");
  await page.mouse.move(kotak.x + 100, kotak.y + 100);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await pesanBertipe(page, "wheel")).length).toBeGreaterThan(0);
  const roda = (await pesanBertipe(page, "wheel")).at(-1) as Pesan;
  expect(roda.ctrlKey).toBe(true);
  expect(typeof roda.deltaY).toBe("number");
});

test("mode diterima; channel salah dan sumber lain diabaikan", async ({ page }) => {
  const frame = await pasangFrame(page);

  await kirimKeFrame(page, { channel: CHANNEL, type: "mode", tool: "select" });
  const pertama = await titikHalaman(page, frame, "#tombol");
  await page.mouse.click(pertama.x, pertama.y);
  await expect.poll(async () => (await pesanBertipe(page, "select")).length).toBe(1);

  // Channel salah: mode kembali ke preview mestinya tidak terjadi.
  await kirimKeFrame(page, { channel: "kanal-lain", type: "mode", tool: "preview" });
  const kedua = await titikHalaman(page, frame, '[data-testid="kartu"]');
  await page.mouse.click(kedua.x, kedua.y);
  await expect.poll(async () => (await pesanBertipe(page, "select")).length).toBe(2);

  // Sumber lain (bukan window.parent): juga diabaikan.
  await frame.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "jejak-design-v1", type: "mode", tool: "preview" },
      }),
    );
  });
  const ketiga = await titikHalaman(page, frame, "#judul");
  await page.mouse.click(ketiga.x, ketiga.y);
  await expect.poll(async () => (await pesanBertipe(page, "select")).length).toBe(3);
});

test("permintaan jaringan dari frame gagal karena CSP", async ({ page }) => {
  const frame = await pasangFrame(page);
  const hasil = await frame.evaluate(async () => {
    try {
      await fetch("https://contoh.test/x");
      return "berhasil";
    } catch {
      return "gagal";
    }
  });
  expect(hasil).toBe("gagal");
});
