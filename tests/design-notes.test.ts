import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_NOTES, parseManifest, readDesign } from "../src/server/design/manifest";
import { DesignWriteError, saveLayout, saveNotes } from "../src/server/design/write";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-notes-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MANIFEST = {
  version: 1,
  judul: "Proyek",
  pages: [{ slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 }],
};

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

describe("parseManifest: catatan", () => {
  test("catatan sah dibaca apa adanya", () => {
    const parsed = parseManifest({
      version: 1,
      pages: [],
      notes: [{ id: "n_0123abcd", x: 10, y: -20, text: "Cek kontras" }],
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.notes).toEqual([{ id: "n_0123abcd", x: 10, y: -20, text: "Cek kontras" }]);
    expect(parsed.warnings).toEqual([]);
  });

  test("daftar catatan bukan daftar diabaikan dengan peringatan", () => {
    const parsed = parseManifest({ version: 1, pages: [], notes: "bukan daftar" });
    expect(parsed.notes).toEqual([]);
    expect(parsed.warnings.length).toBe(1);
  });

  test("entri tak sah dibuang dengan peringatan", () => {
    const parsed = parseManifest({
      version: 1,
      pages: [],
      notes: [
        { id: "bukan-id", x: 0, y: 0, text: "a" },
        { id: "n_0123abcd", x: "x", y: 0, text: "b" },
        { id: "n_0123abce", x: 0, y: 0, text: 12 },
        { id: "n_0123abcf", x: 0, y: 0, text: "ok\u0000jahat" },
        "bukan objek",
      ],
    });
    expect(parsed.notes).toEqual([]);
    expect(parsed.warnings.length).toBe(5);
  });

  test("daftar dipotong ke 50 catatan dengan peringatan", () => {
    const notes = Array.from({ length: 60 }, (_, index) => ({
      id: `n_${index.toString(16).padStart(8, "0")}`,
      x: index,
      y: 0,
      text: "x",
    }));
    const parsed = parseManifest({ version: 1, pages: [], notes });
    expect(parsed.notes).toHaveLength(MAX_NOTES);
    expect(parsed.warnings.some((text) => text.includes("dipotong"))).toBe(true);
  });

  test("manifest tanpa catatan menghasilkan daftar kosong", () => {
    const parsed = parseManifest({ version: 1, pages: [] });
    expect(parsed.notes).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });
});

describe("readDesign: catatan", () => {
  test("catatan dibaca dari manifest", async () => {
    await writeManifest({
      version: 1,
      pages: [],
      notes: [{ id: "n_0123abcd", x: 5, y: 6, text: "halo" }],
    });
    const result = await readDesign(dir);
    expect(result.notes).toEqual([{ id: "n_0123abcd", x: 5, y: 6, text: "halo" }]);
  });

  test("folder desain belum ada -> catatan kosong", async () => {
    const result = await readDesign(dir);
    expect(result.exists).toBe(false);
    expect(result.notes).toEqual([]);
  });
});

describe("saveNotes", () => {
  test("entri tanpa id diberi id baru dan daftar lama diganti", async () => {
    await writeManifest({
      ...MANIFEST,
      notes: [{ id: "n_aaaaaaaa", x: 1, y: 2, text: "lama" }],
    });
    const result = await saveNotes(dir, { notes: [{ x: 30, y: 40, text: "baru" }] });
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.id).toMatch(/^n_[0-9a-f]{8}$/);
    expect(result.notes[0]?.x).toBe(30);
    expect(result.notes[0]?.text).toBe("baru");

    const manifest = await readManifest();
    const notes = manifest.notes as Array<Record<string, unknown>>;
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toBe("baru");
    await noTempFiles();
  });

  test("id yang diberikan dipertahankan", async () => {
    await writeManifest(MANIFEST);
    const result = await saveNotes(dir, {
      notes: [{ id: "n_0123abcd", x: 1, y: 2, text: "tetap" }],
    });
    expect(result.notes[0]?.id).toBe("n_0123abcd");
    const manifest = await readManifest();
    expect((manifest.notes as Array<Record<string, unknown>>)[0]?.id).toBe("n_0123abcd");
  });

  test("daftar kosong menghapus seluruh catatan", async () => {
    await writeManifest({
      ...MANIFEST,
      notes: [{ id: "n_aaaaaaaa", x: 1, y: 2, text: "lama" }],
    });
    const result = await saveNotes(dir, { notes: [] });
    expect(result.notes).toEqual([]);
    const manifest = await readManifest();
    expect(manifest.notes).toEqual([]);
  });

  test("kunci lain di manifest tetap utuh", async () => {
    await writeManifest(MANIFEST);
    await saveNotes(dir, { notes: [{ x: 0, y: 0, text: "catatan" }] });
    const manifest = await readManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.judul).toBe("Proyek");
    const pages = manifest.pages as Array<Record<string, unknown>>;
    expect(pages).toHaveLength(1);
    expect(pages[0]?.slug).toBe("beranda");
  });

  test("entri tak sah ditolak 400", async () => {
    await writeManifest(MANIFEST);
    const cases: unknown[] = [
      { notes: [{ x: 0, y: 0, text: 12 }] },
      { notes: [{ x: "x", y: 0, text: "a" }] },
      { notes: [{ x: 0, y: 0, text: "a".repeat(501) }] },
      { notes: [{ x: 0, y: 0, text: "a\u0000b" }] },
      { notes: [{ id: "bukan-id", x: 0, y: 0, text: "a" }] },
      { notes: [{ id: "n_0123abcd", x: 0, y: 0, text: "a" }, { id: "n_0123abcd", x: 1, y: 1, text: "b" }] },
      { notes: "bukan daftar" },
      { notes: ["bukan objek"] },
      {},
      [],
    ];
    for (const body of cases) {
      expect(await statusOf(saveNotes(dir, body))).toBe(400);
    }
    const manifest = await readManifest();
    expect(manifest.notes).toBeUndefined();
  });

  test("lebih dari 50 catatan ditolak 400", async () => {
    await writeManifest(MANIFEST);
    const notes = Array.from({ length: 51 }, (_, index) => ({
      x: index,
      y: 0,
      text: "x",
    }));
    expect(await statusOf(saveNotes(dir, { notes }))).toBe(400);
  });

  test("koordinat dijepit ke batas", async () => {
    await writeManifest(MANIFEST);
    const result = await saveNotes(dir, { notes: [{ x: 999999, y: -999999, text: "a" }] });
    expect(result.notes[0]?.x).toBe(100000);
    expect(result.notes[0]?.y).toBe(-100000);
  });

  test("folder desain belum ada -> 404", async () => {
    expect(await statusOf(saveNotes(dir, { notes: [] }))).toBe(404);
  });

  test("saveLayout tidak menghapus catatan", async () => {
    await writeManifest(MANIFEST);
    await saveNotes(dir, { notes: [{ id: "n_0123abcd", x: 7, y: 8, text: "tetap" }] });
    await saveLayout(dir, { pages: [{ slug: "beranda", x: 100, y: 200 }] });
    const manifest = await readManifest();
    const notes = manifest.notes as Array<Record<string, unknown>>;
    expect(notes).toHaveLength(1);
    expect(notes[0]?.text).toBe("tetap");
    expect(notes[0]?.x).toBe(7);
    const pages = manifest.pages as Array<Record<string, unknown>>;
    expect(pages[0]?.x).toBe(100);
    await noTempFiles();
  });
});
