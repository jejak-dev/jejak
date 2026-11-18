import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePage } from "../src/server/design/assemble";
import { MAX_PAGES, readDesign } from "../src/server/design/manifest";
import { DesignWriteError, initDesign, saveLayout } from "../src/server/design/write";

let dir: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-write-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-design-write-luar-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function writeManifest(value: unknown): Promise<void> {
  await mkdir(join(dir, "design"), { recursive: true });
  await writeFile(join(dir, "design", "design.json"), JSON.stringify(value, null, 2), "utf8");
}

async function readManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "design", "design.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DesignWriteError);
  return (error as DesignWriteError).status;
}

async function noTempFiles(): Promise<void> {
  const names = await readdir(join(dir, "design"));
  expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
}

const MANIFEST = {
  version: 1,
  judul: "Proyek",
  pages: [
    { slug: "beranda", title: "Beranda", route: "/", device: "desktop", x: 0, y: 0, catatan: "x" },
    { slug: "tentang", title: "Tentang", device: "mobile", x: 100, y: 0 },
  ],
};

describe("saveLayout", () => {
  test("memperbarui x/y/device dan mempertahankan kunci lain", async () => {
    await writeManifest(MANIFEST);
    const result = await saveLayout(dir, {
      pages: [{ slug: "beranda", x: 10.6, y: -20.4, device: "tablet" }],
    });
    expect(result.pages).toBe(1);

    const manifest = await readManifest();
    expect(manifest.judul).toBe("Proyek");
    expect(manifest.version).toBe(1);
    const pages = manifest.pages as Array<Record<string, unknown>>;
    expect(pages[0]).toEqual({
      slug: "beranda",
      title: "Beranda",
      route: "/",
      device: "tablet",
      x: 11,
      y: -20,
      catatan: "x",
    });
    expect(pages[1]).toEqual({ slug: "tentang", title: "Tentang", device: "mobile", x: 100, y: 0 });
    await noTempFiles();
  });

  test("slug tak dikenal diabaikan dan tidak ditambahkan", async () => {
    await writeManifest(MANIFEST);
    const result = await saveLayout(dir, {
      pages: [
        { slug: "baru", x: 5, y: 5 },
        { slug: "tentang", x: 7, y: 8 },
      ],
    });
    expect(result.pages).toBe(1);
    const pages = (await readManifest()).pages as Array<Record<string, unknown>>;
    expect(pages).toHaveLength(2);
    expect(pages.some((page) => page.slug === "baru")).toBe(false);
  });

  test("pembulatan dan batas +/-100000", async () => {
    await writeManifest(MANIFEST);
    await saveLayout(dir, {
      pages: [{ slug: "beranda", x: 1e9, y: -1e9 }],
    });
    let pages = (await readManifest()).pages as Array<Record<string, unknown>>;
    expect(pages[0]!.x).toBe(100000);
    expect(pages[0]!.y).toBe(-100000);

    await saveLayout(dir, { pages: [{ slug: "beranda", x: 2.5, y: -2.5 }] });
    pages = (await readManifest()).pages as Array<Record<string, unknown>>;
    expect(pages[0]!.x).toBe(3);
    expect(pages[0]!.y).toBe(-2);
  });

  test("input tidak valid 400", async () => {
    await writeManifest(MANIFEST);
    const cases: unknown[] = [
      null,
      [],
      {},
      { pages: "x" },
      { pages: [{ slug: "beranda", x: Number.NaN, y: 0 }] },
      { pages: [{ slug: "beranda", x: 0, y: Number.POSITIVE_INFINITY }] },
      { pages: [{ slug: "beranda", x: "1", y: 0 }] },
      { pages: [{ slug: "beranda", x: 0, y: 0, device: "tv" }] },
      { pages: [{ slug: "Beranda", x: 0, y: 0 }] },
      { pages: [{ slug: "beranda", x: 0, y: 0 }, { slug: "beranda", x: 1, y: 1 }] },
      {
        pages: Array.from({ length: MAX_PAGES + 1 }, (_unused, index) => ({
          slug: `halaman-${index}`,
          x: 0,
          y: 0,
        })),
      },
    ];
    for (const input of cases) {
      expect(await statusOf(saveLayout(dir, input))).toBe(400);
    }
    expect(await readManifest()).toEqual(MANIFEST);
    await noTempFiles();
  });

  test("design.json tidak ada 404", async () => {
    expect(await statusOf(saveLayout(dir, { pages: [] }))).toBe(404);
    await mkdir(join(dir, "design"), { recursive: true });
    expect(await statusOf(saveLayout(dir, { pages: [] }))).toBe(404);
  });

  test("design.json rusak 409 dan berkas tak berubah", async () => {
    await mkdir(join(dir, "design"), { recursive: true });
    const path = join(dir, "design", "design.json");
    for (const content of ["{rusak", JSON.stringify({ version: 2, pages: [] }), "[]"]) {
      await writeFile(path, content, "utf8");
      expect(await statusOf(saveLayout(dir, { pages: [{ slug: "beranda", x: 1, y: 1 }] }))).toBe(409);
      expect(await readFile(path, "utf8")).toBe(content);
    }
    await noTempFiles();
  });

  test("symlink design.json keluar root ditolak", async () => {
    const luar = join(outside, "design.json");
    await writeFile(luar, JSON.stringify(MANIFEST), "utf8");
    await mkdir(join(dir, "design"), { recursive: true });
    await symlink(luar, join(dir, "design", "design.json"));
    expect(await statusOf(saveLayout(dir, { pages: [{ slug: "beranda", x: 1, y: 1 }] }))).toBe(404);
    expect(JSON.parse(await readFile(luar, "utf8"))).toEqual(MANIFEST);
  });
});

describe("initDesign", () => {
  test("membuat 4 berkas dan hasilnya valid", async () => {
    const result = await initDesign(dir);
    expect(result.created.sort()).toEqual([
      "design/DESIGN.md",
      "design/design.json",
      "design/pages/contoh.html",
      "design/tokens.css",
    ]);

    const design = await readDesign(dir);
    expect(design.exists).toBe(true);
    expect(design.manifestError).toBeUndefined();
    expect(design.warnings).toEqual([]);
    expect(design.pages.map((page) => page.slug)).toEqual(["contoh"]);

    const assembled = await assemblePage(dir, "contoh");
    expect(assembled.warnings).toEqual([]);
    expect(assembled.html).toContain("Content-Security-Policy");
    expect(assembled.html).toContain("--warna-latar");
  });

  test("panggilan kedua 409", async () => {
    await initDesign(dir);
    expect(await statusOf(initDesign(dir))).toBe(409);
  });

  test("tidak menimpa berkas yang sudah ada", async () => {
    await mkdir(join(dir, "design"), { recursive: true });
    await writeFile(join(dir, "design", "tokens.css"), ":root { --kustom: 1; }\n", "utf8");
    const result = await initDesign(dir);
    expect(result.created).not.toContain("design/tokens.css");
    expect(await readFile(join(dir, "design", "tokens.css"), "utf8")).toBe(
      ":root { --kustom: 1; }\n",
    );
    expect(result.created).toHaveLength(3);
  });

  test("design berupa symlink 400", async () => {
    const luar = join(outside, "design");
    await mkdir(luar, { recursive: true });
    await symlink(luar, join(dir, "design"));
    expect(await statusOf(initDesign(dir))).toBe(400);
    expect(await readdir(luar)).toEqual([]);
  });
});

describe("initDesign dan symlink subfolder", () => {
  test("design/pages berupa symlink keluar repo ditolak tanpa menulis ke luar", async () => {
    await mkdir(join(dir, "design"), { recursive: true });
    await symlink(outside, join(dir, "design", "pages"));
    await expect(initDesign(dir)).rejects.toMatchObject({ status: 400 });
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("initDesign dan .gitignore", () => {
  async function gitignoreOf(root: string): Promise<string | undefined> {
    try {
      return await readFile(join(root, ".gitignore"), "utf8");
    } catch {
      return undefined;
    }
  }

  test("repo git tanpa .gitignore membuat berisi design/", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    const result = await initDesign(dir);
    expect(result.created).toContain(".gitignore");
    expect(await gitignoreOf(dir)).toBe("design/\n");
    expect(result.created).toHaveLength(5);
  });

  test(".git berkas (bukan folder) juga dianggap repo", async () => {
    await writeFile(join(dir, ".git"), "gitdir: ../lain/.git\n", "utf8");
    const result = await initDesign(dir);
    expect(result.created).toContain(".gitignore");
    expect(await gitignoreOf(dir)).toBe("design/\n");
  });

  test(".gitignore tanpa newline akhir diberi pemisah baru", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), "node_modules", "utf8");
    const result = await initDesign(dir);
    expect(result.created).toContain(".gitignore");
    expect(await gitignoreOf(dir)).toBe("node_modules\ndesign/\n");
  });

  test(".gitignore berakhiran newline ditambah satu baris", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), "node_modules\n", "utf8");
    await initDesign(dir);
    expect(await gitignoreOf(dir)).toBe("node_modules\ndesign/\n");
  });

  test("baris /design/ yang sudah ada tidak mengubah apa pun", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    const original = "node_modules\n/design/\n";
    await writeFile(join(dir, ".gitignore"), original, "utf8");
    const result = await initDesign(dir);
    expect(result.created).not.toContain(".gitignore");
    expect(await gitignoreOf(dir)).toBe(original);
    expect(result.created).toHaveLength(4);
  });

  test("tracked true membiarkan .gitignore tak tersentuh", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    const result = await initDesign(dir, { tracked: true });
    expect(result.created).not.toContain(".gitignore");
    expect(await gitignoreOf(dir)).toBeUndefined();
    expect(result.created).toHaveLength(4);
  });

  test("bukan repo git tidak membuat .gitignore", async () => {
    const result = await initDesign(dir);
    expect(result.created).not.toContain(".gitignore");
    expect(await gitignoreOf(dir)).toBeUndefined();
  });

  test(".gitignore berupa symlink dilewati tanpa galat", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    const luar = join(outside, "gitignore");
    await writeFile(luar, "lama\n", "utf8");
    await symlink(luar, join(dir, ".gitignore"));
    const result = await initDesign(dir);
    expect(result.created).not.toContain(".gitignore");
    expect(result.created).toHaveLength(4);
    expect(await readFile(luar, "utf8")).toBe("lama\n");
  });

  test(".gitignore terlalu besar dilewati", async () => {
    await mkdir(join(dir, ".git"), { recursive: true });
    const besar = "x".repeat(256 * 1024 + 1);
    await writeFile(join(dir, ".gitignore"), besar, "utf8");
    const result = await initDesign(dir);
    expect(result.created).not.toContain(".gitignore");
    expect(await gitignoreOf(dir)).toBe(besar);
  });
});
