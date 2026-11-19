import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICES, GAP, MAX_PAGES } from "../src/server/design/manifest";
import { DesignWriteError, createVariant, saveLayout } from "../src/server/design/write";

let dir: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-variant-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-design-variant-luar-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const HTML = "<!doctype html><html><body><h1>Beranda</h1></body></html>";

/** Manifest dasar: satu halaman "beranda" dengan kunci asing. */
const MANIFEST = {
  version: 1,
  judul: "Proyek",
  pages: [
    {
      slug: "beranda",
      title: "Beranda",
      route: "/",
      device: "desktop",
      x: 0,
      y: 0,
      catatan: "x",
    },
  ],
};

async function setup(manifest: unknown = MANIFEST, files: Record<string, string> = {}): Promise<void> {
  await mkdir(join(dir, "design", "pages"), { recursive: true });
  await writeFile(join(dir, "design", "design.json"), JSON.stringify(manifest, null, 2), "utf8");
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, "design", "pages", name), content, "utf8");
  }
}

async function readManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "design", "design.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function manifestPages(): Promise<Array<Record<string, unknown>>> {
  return (await readManifest()).pages as Array<Record<string, unknown>>;
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DesignWriteError);
  return (error as DesignWriteError).status;
}

describe("createVariant", () => {
  test("menyalin HTML dan menambah entri manifest", async () => {
    await setup(MANIFEST, { "beranda.html": HTML });

    const page = await createVariant(dir, { slug: "beranda", variant: "gelap" });
    expect(page).toEqual({
      slug: "beranda-gelap",
      title: "Beranda (gelap)",
      x: DEVICES.desktop.width + GAP,
      y: 0,
    });

    expect(await readFile(join(dir, "design", "pages", "beranda-gelap.html"), "utf8")).toBe(HTML);

    const manifest = await readManifest();
    expect(manifest.judul).toBe("Proyek");
    const pages = manifest.pages as Array<Record<string, unknown>>;
    expect(pages).toHaveLength(2);
    expect(pages[1]).toEqual({
      slug: "beranda-gelap",
      title: "Beranda (gelap)",
      device: "desktop",
      x: DEVICES.desktop.width + GAP,
      y: 0,
      variant: "gelap",
      group: "Beranda",
    });
    // Kunci asing pada entri sumber tetap utuh; group ditambahkan.
    expect(pages[0]).toEqual({
      slug: "beranda",
      title: "Beranda",
      route: "/",
      device: "desktop",
      x: 0,
      y: 0,
      catatan: "x",
      group: "Beranda",
    });
  });

  test("device dan posisi mengikuti halaman sumber", async () => {
    await setup(
      {
        version: 1,
        pages: [{ slug: "ponsel", title: "Ponsel", device: "mobile", x: 100, y: 40 }],
      },
      { "ponsel.html": HTML },
    );

    const page = await createVariant(dir, { slug: "ponsel", variant: "kosong" });
    expect(page.x).toBe(100 + DEVICES.mobile.width + GAP);
    expect(page.y).toBe(40);

    const pages = await manifestPages();
    expect(pages[1]?.device).toBe("mobile");
  });

  test("group dari input dipakai dan disetel pada halaman sumber", async () => {
    await setup(MANIFEST, { "beranda.html": HTML });

    await createVariant(dir, { slug: "beranda", variant: "galat", group: "Menu Utama" });
    const pages = await manifestPages();
    expect(pages[0]?.group).toBe("Menu Utama");
    expect(pages[1]?.group).toBe("Menu Utama");
    expect(pages[1]?.variant).toBe("galat");
  });

  test("group sumber dipakai bila ada", async () => {
    await setup(
      {
        version: 1,
        pages: [
          {
            slug: "beranda",
            title: "Beranda",
            device: "desktop",
            x: 0,
            y: 0,
            group: "Landing",
            variant: "terang",
          },
        ],
      },
      { "beranda.html": HTML },
    );

    await createVariant(dir, { slug: "beranda", variant: "gelap" });
    const pages = await manifestPages();
    expect(pages[0]?.group).toBe("Landing");
    expect(pages[1]?.group).toBe("Landing");
    expect(pages[1]?.variant).toBe("gelap");
  });

  test("posisi digeser bila bertumbukan dengan halaman lain", async () => {
    await setup(
      {
        version: 1,
        pages: [
          { slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 },
          { slug: "lain", title: "Lain", device: "desktop", x: DEVICES.desktop.width + GAP, y: 0 },
        ],
      },
      { "beranda.html": HTML },
    );

    const page = await createVariant(dir, { slug: "beranda", variant: "gelap" });
    expect(page.x).toBe((DEVICES.desktop.width + GAP) * 2);
    expect(page.y).toBe(0);
  });

  test("slug bentrok di manifest memakai akhiran -2", async () => {
    await setup(
      {
        version: 1,
        pages: [
          { slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 },
          { slug: "beranda-gelap", title: "Sudah ada", device: "desktop", x: 9000, y: 0 },
        ],
      },
      { "beranda.html": HTML, "beranda-gelap.html": HTML },
    );

    const page = await createVariant(dir, { slug: "beranda", variant: "gelap" });
    expect(page.slug).toBe("beranda-gelap-2");
  });

  test("berkas yang sudah ada tak ditimpa", async () => {
    await setup(MANIFEST, { "beranda.html": HTML, "beranda-gelap.html": "lama" });

    const page = await createVariant(dir, { slug: "beranda", variant: "gelap" });
    expect(page.slug).toBe("beranda-gelap-2");
    expect(await readFile(join(dir, "design", "pages", "beranda-gelap.html"), "utf8")).toBe("lama");
    expect(await readFile(join(dir, "design", "pages", "beranda-gelap-2.html"), "utf8")).toBe(HTML);
  });

  test("semua slug kandidat terpakai -> 409", async () => {
    const files: Record<string, string> = { "beranda.html": HTML };
    for (let index = 1; index <= 20; index += 1) {
      files[index === 1 ? "beranda-gelap.html" : `beranda-gelap-${index}.html`] = "lama";
    }
    await setup(MANIFEST, files);

    expect(await statusOf(createVariant(dir, { slug: "beranda", variant: "gelap" }))).toBe(409);
    const pages = await manifestPages();
    expect(pages).toHaveLength(1);
  });

  test("slug sumber tak ada di manifest -> 404", async () => {
    await setup(MANIFEST, { "beranda.html": HTML });
    expect(await statusOf(createVariant(dir, { slug: "halaman", variant: "gelap" }))).toBe(404);
  });

  test("berkas sumber hilang -> 404", async () => {
    await setup(MANIFEST);
    expect(await statusOf(createVariant(dir, { slug: "beranda", variant: "gelap" }))).toBe(404);
  });

  test("berkas sumber berupa symlink ditolak", async () => {
    const luar = join(outside, "beranda.html");
    await writeFile(luar, HTML, "utf8");
    await setup(MANIFEST);
    await symlink(luar, join(dir, "design", "pages", "beranda.html"));

    expect(await statusOf(createVariant(dir, { slug: "beranda", variant: "gelap" }))).toBe(400);
    expect(await readFile(luar, "utf8")).toBe(HTML);
    expect((await manifestPages()).length).toBe(1);
  });

  test("batas halaman tercapai -> 400", async () => {
    const pages = Array.from({ length: MAX_PAGES }, (_unused, index) => ({
      slug: `halaman-${index}`,
      title: `Halaman ${index}`,
      device: "desktop",
      x: index * 2000,
      y: 0,
    }));
    await setup({ version: 1, pages }, { "beranda.html": HTML });

    expect(await statusOf(createVariant(dir, { slug: "beranda", variant: "gelap" }))).toBe(400);
  });

  test("masukan tidak valid -> 400", async () => {
    await setup(MANIFEST, { "beranda.html": HTML });
    const cases: unknown[] = [
      { slug: "Beranda", variant: "gelap" },
      { slug: "beranda", variant: "" },
      { slug: "beranda", variant: "   " },
      { slug: "beranda", variant: "x".repeat(31) },
      { slug: "beranda", variant: "gelap", group: 12 },
      { slug: "beranda", variant: "gelap", group: "x".repeat(41) },
    ];
    for (const input of cases) {
      expect(await statusOf(createVariant(dir, input as never))).toBe(400);
    }
    expect((await manifestPages()).length).toBe(1);
  });
});

describe("saveLayout dengan group dan variant", () => {
  test("menyetel group dan variant", async () => {
    await setup(MANIFEST);

    const result = await saveLayout(dir, {
      pages: [{ slug: "beranda", x: 10, y: 20, group: "Beranda", variant: "gelap" }],
    });
    expect(result.pages).toBe(1);

    const pages = await manifestPages();
    expect(pages[0]?.group).toBe("Beranda");
    expect(pages[0]?.variant).toBe("gelap");
    expect(pages[0]?.x).toBe(10);
    expect(pages[0]?.y).toBe(20);
    // Kunci lain tetap utuh.
    expect(pages[0]?.route).toBe("/");
    expect(pages[0]?.catatan).toBe("x");
    expect((await readManifest()).judul).toBe("Proyek");
  });

  test("null menghapus kunci group dan variant", async () => {
    await setup({
      version: 1,
      pages: [
        {
          slug: "beranda",
          title: "Beranda",
          device: "desktop",
          x: 0,
          y: 0,
          group: "Beranda",
          variant: "gelap",
        },
      ],
    });

    await saveLayout(dir, {
      pages: [{ slug: "beranda", x: 0, y: 0, group: null, variant: null }],
    });

    const pages = await manifestPages();
    expect(pages[0]?.group).toBeUndefined();
    expect(pages[0]?.variant).toBeUndefined();
    expect("group" in (pages[0] ?? {})).toBe(false);
    expect("variant" in (pages[0] ?? {})).toBe(false);
  });

  test("label tak sah -> 400 dan berkas tak berubah", async () => {
    await setup(MANIFEST);
    const cases: unknown[] = [
      { slug: "beranda", x: 0, y: 0, group: 12 },
      { slug: "beranda", x: 0, y: 0, group: "" },
      { slug: "beranda", x: 0, y: 0, group: "x".repeat(41) },
      { slug: "beranda", x: 0, y: 0, variant: 12 },
      { slug: "beranda", x: 0, y: 0, variant: "x".repeat(31) },
    ];
    for (const input of cases) {
      expect(await statusOf(saveLayout(dir, input))).toBe(400);
    }
    const pages = await manifestPages();
    expect(pages[0]?.group).toBeUndefined();
    expect(pages[0]?.variant).toBeUndefined();
  });
});
