import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICES,
  MAX_PAGE_BYTES,
  designStamp,
  deviceFromMeta,
  parseManifest,
  placeNext,
  readDesign,
} from "../src/server/design/manifest";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-manifest-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeManifest(value: unknown): Promise<void> {
  await mkdir(join(dir, "design"), { recursive: true });
  await writeFile(join(dir, "design", "design.json"), JSON.stringify(value), "utf8");
}

async function writePage(slug: string, content = "<!doctype html><html><body>x</body></html>"): Promise<void> {
  await mkdir(join(dir, "design", "pages"), { recursive: true });
  await writeFile(join(dir, "design", "pages", `${slug}.html`), content, "utf8");
}

describe("deviceFromMeta", () => {
  test("membaca perangkat dari meta dan menolak nilai tak dikenal", () => {
    expect(deviceFromMeta('<head><meta name="jejak:device" content="mobile"></head>')).toBe("mobile");
    expect(deviceFromMeta('<meta content="tablet" name="jejak:device">')).toBe("tablet");
    expect(deviceFromMeta('<meta name="jejak:device" content="tv">')).toBeUndefined();
    expect(deviceFromMeta("<head></head>")).toBeUndefined();
  });
});

describe("placeNext", () => {
  test("halaman pertama di 0,0 dan berikutnya di kanan halaman terakhir", () => {
    expect(placeNext([])).toEqual({ x: 0, y: 0 });
    expect(placeNext([{ x: 100, y: 0, device: "mobile" }])).toEqual({
      x: 100 + DEVICES.mobile.width + 80,
      y: 0,
    });
    expect(
      placeNext([
        { x: 0, y: 0, device: "desktop" },
        { x: 1520, y: 0, device: "mobile" },
      ]),
    ).toEqual({ x: 1520 + DEVICES.mobile.width + 80, y: 0 });
  });
});

describe("parseManifest", () => {
  test("slug tak sah dan duplikat dibuang dengan warning", () => {
    const parsed = parseManifest({
      version: 1,
      pages: [{ slug: "Besar" }, { slug: "ganda" }, { slug: "ganda" }],
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.pages.map((page) => page.slug)).toEqual(["ganda"]);
    expect(parsed.warnings).toHaveLength(2);
  });
});

describe("readDesign", () => {
  test("tanpa folder design", async () => {
    const result = await readDesign(dir);
    expect(result.exists).toBe(false);
    expect(result.pages).toEqual([]);
    expect(result.tokens.mtime).toBeNull();
    expect(result.manifestError).toBeUndefined();
  });

  test("manifest valid dipakai apa adanya", async () => {
    await writeManifest({
      version: 1,
      pages: [{ slug: "beranda", title: "Beranda", route: "/beranda", device: "mobile", x: 100, y: 50 }],
    });
    await writePage("beranda");

    const result = await readDesign(dir);
    expect(result.exists).toBe(true);
    expect(result.manifestError).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.slug).toBe("beranda");
    expect(page.title).toBe("Beranda");
    expect(page.route).toBe("/beranda");
    expect(page.device).toBe("mobile");
    expect(page.x).toBe(100);
    expect(page.y).toBe(50);
    expect(page.mtime).toBeGreaterThan(0);
    expect(page.missing).toBe(false);
    expect(page.tooLarge).toBe(false);
  });

  test("halaman baru otomatis: perangkat dari meta, posisi di kanan halaman terakhir", async () => {
    await writeManifest({
      version: 1,
      pages: [{ slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 }],
    });
    await writePage("beranda");
    await writePage(
      "tentang",
      '<!doctype html><html><head><meta name="jejak:device" content="mobile"></head><body>y</body></html>',
    );

    const result = await readDesign(dir);
    expect(result.pages.map((page) => page.slug)).toEqual(["beranda", "tentang"]);
    const tentang = result.pages[1]!;
    expect(tentang.title).toBe("tentang");
    expect(tentang.device).toBe("mobile");
    expect(tentang.x).toBe(DEVICES.desktop.width + 80);
    expect(tentang.y).toBe(0);
    expect(tentang.missing).toBe(false);
  });

  test("entri manifest tanpa berkas ditandai missing", async () => {
    await writeManifest({
      version: 1,
      pages: [{ slug: "hilang", title: "Hilang", device: "tablet", x: 5, y: 6 }],
    });

    const result = await readDesign(dir);
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.slug).toBe("hilang");
    expect(page.missing).toBe(true);
    expect(page.mtime).toBe(0);
  });

  test("device, x, y, dan route tak valid diperbaiki dengan warning", async () => {
    await writeManifest({
      version: 1,
      pages: [{ slug: "a", device: "tv", x: "kiri", y: 999999, route: "tanpa-garis" }],
    });

    const result = await readDesign(dir);
    const page = result.pages[0]!;
    expect(page.device).toBe("desktop");
    expect(page.x).toBe(0);
    expect(page.y).toBe(100000);
    expect(page.route).toBeUndefined();
    expect(result.warnings.length).toBe(4);
  });

  test("JSON rusak melaporkan manifestError tanpa mengubah berkas", async () => {
    await mkdir(join(dir, "design"), { recursive: true });
    await writeFile(join(dir, "design", "design.json"), "{rusak", "utf8");

    const result = await readDesign(dir);
    expect(result.exists).toBe(true);
    expect(result.manifestError).toContain("design.json tidak valid");
    expect(result.pages).toEqual([]);
    expect(await readFile(join(dir, "design", "design.json"), "utf8")).toBe("{rusak");
  });

  test("versi bukan 1 melaporkan manifestError", async () => {
    await writeManifest({ version: 2, pages: [] });

    const result = await readDesign(dir);
    expect(result.manifestError).toBe("design.json tidak valid: versi harus 1.");
  });

  test("berkas halaman di atas 512 KB ditandai tooLarge", async () => {
    await writeManifest({ version: 1, pages: [{ slug: "besar" }] });
    await writePage("besar", "x".repeat(MAX_PAGE_BYTES + 1));

    const result = await readDesign(dir);
    expect(result.pages[0]!.tooLarge).toBe(true);
  });

  test("symlink design yang keluar root menghasilkan exists false", async () => {
    const outside = await mkdtemp(join(tmpdir(), "jejak-design-outside-"));
    try {
      await writeFile(join(outside, "design.json"), JSON.stringify({ version: 1, pages: [] }), "utf8");
      await symlink(outside, join(dir, "design"));

      const result = await readDesign(dir);
      expect(result.exists).toBe(false);
      expect(result.pages).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("symlink di pages diabaikan", async () => {
    const outside = await mkdtemp(join(tmpdir(), "jejak-design-outside-"));
    try {
      await writeFile(join(outside, "luar.html"), "<html></html>", "utf8");
      await writeManifest({ version: 1, pages: [{ slug: "asli" }] });
      await writePage("asli");
      await symlink(join(outside, "luar.html"), join(dir, "design", "pages", "tautan.html"));

      const result = await readDesign(dir);
      expect(result.pages.map((page) => page.slug)).toEqual(["asli"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("lebih dari 50 halaman dipotong dengan warning", async () => {
    await writeManifest({ version: 1, pages: [] });
    for (let index = 0; index < 55; index += 1) {
      await writePage(`h${String(index).padStart(2, "0")}`);
    }

    const result = await readDesign(dir);
    expect(result.pages).toHaveLength(50);
    expect(result.warnings.some((warning) => warning.includes("dipotong"))).toBe(true);
  });
});

describe("designStamp", () => {
  test("tetap saat tidak berubah dan berubah saat berkas berubah", async () => {
    await mkdir(join(dir, "design", "pages"), { recursive: true });
    await writeFile(join(dir, "design", "tokens.css"), ":root {}", "utf8");
    await writeFile(join(dir, "design", "pages", "a.html"), "<html>a</html>", "utf8");

    const first = await designStamp(dir);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(await designStamp(dir)).toBe(first);

    await writeFile(join(dir, "design", "pages", "a.html"), "<html>berubah lebih panjang</html>", "utf8");
    expect(await designStamp(dir)).not.toBe(first);
  });

  test("tanpa folder design menghasilkan nilai tetap", async () => {
    const empty = await designStamp(dir);
    expect(empty).toMatch(/^[0-9a-f]{12}$/);
    expect(await designStamp(dir)).toBe(empty);
  });

  test("perubahan mtime saja mengubah stamp", async () => {
    await mkdir(join(dir, "design"), { recursive: true });
    await writeFile(join(dir, "design", "design.json"), "{}", "utf8");
    const first = await designStamp(dir);

    const later = new Date(Date.now() + 60_000);
    await utimes(join(dir, "design", "design.json"), later, later);
    expect(await designStamp(dir)).not.toBe(first);
  });
});
