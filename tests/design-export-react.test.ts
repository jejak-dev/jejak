import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DesignError } from "../src/server/design/assemble";
import { exportReactProject } from "../src/server/design/export";

let dir: string;

interface ParsedEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Pembaca ZIP kecil untuk uji: cari EOCD, telusuri central directory, lalu
 * kembalikan nama dan isi tiap entri (.inflate bila method 8).
 */
function parseZip(archive: Uint8Array): ParsedEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let i = archive.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("EOCD tidak ditemukan");
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Header pusat rusak");
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("Header lokal rusak");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(start, start + compressedSize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(Buffer.from(raw))) : raw;
    entries.push({ name, data });
  }
  return entries;
}

/** Isi satu entri ZIP sebagai teks; undefined bila tak ada. */
function entryText(entries: ParsedEntry[], name: string): string | undefined {
  const entry = entries.find((item) => item.name === name);
  return entry === undefined ? undefined : new TextDecoder().decode(entry.data);
}

/** Menyiapkan folder design dengan halaman, token, dan satu aset. */
async function seedDesign(root: string): Promise<void> {
  await mkdir(join(root, "design", "pages"), { recursive: true });
  await mkdir(join(root, "design", "assets"), { recursive: true });
  await writeFile(
    join(root, "design", "design.json"),
    JSON.stringify({
      version: 1,
      pages: [
        { slug: "2-kamar", title: "Kamar Utama" },
        { slug: "kamar", title: "Kamar" },
        { slug: "kamar-2", title: "Kamar Kedua" },
        { slug: "kamar2", title: "Kamar Ketiga" },
      ],
    }),
    "utf8",
  );
  await writeFile(join(root, "design", "tokens.css"), ":root { --warna: #111; }\n", "utf8");
  await writeFile(join(root, "design", "assets", "a.png"), Buffer.from([137, 80, 78, 71, 13, 10]), "utf8");
  await writeFile(
    join(root, "design", "pages", "2-kamar.html"),
    '<html><head><style>.foto { background: url(../assets/a.png); }</style></head><body><img src="../assets/a.png" alt="Foto"><script>alert(1)</script></body></html>',
    "utf8",
  );
  await writeFile(
    join(root, "design", "pages", "kamar.html"),
    "<html><body><p>Kamar</p></body></html>",
    "utf8",
  );
  await writeFile(
    join(root, "design", "pages", "kamar-2.html"),
    "<html><body><p>Kamar kedua</p></body></html>",
    "utf8",
  );
  await writeFile(
    join(root, "design", "pages", "kamar2.html"),
    "<html><body><p>Kamar ketiga</p></body></html>",
    "utf8",
  );
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-react-"));
  await seedDesign(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("exportReactProject", () => {
  test("isi arsip memuat berkas proyek Vite + React", async () => {
    const hasil = await exportReactProject(dir);
    expect(hasil.filename).toBe("design-react.zip");
    const entries = parseZip(hasil.data);
    const names = entries.map((item) => item.name);
    expect(names).toEqual([...names].sort());
    for (const wajib of [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "index.html",
      ".gitignore",
      "README.md",
      "src/main.tsx",
      "src/App.tsx",
      "src/vite-env.d.ts",
      "src/styles/tokens.css",
      "public/assets/a.png",
    ]) {
      expect(names).toContain(wajib);
    }
    expect(hasil.files).toBe(names.length);
  });

  test("App.tsx memuat semua slug dan komponen halaman", async () => {
    const hasil = await exportReactProject(dir);
    const entries = parseZip(hasil.data);
    const app = entryText(entries, "src/App.tsx");
    expect(app).toBeDefined();
    for (const slug of ["2-kamar", "kamar", "kamar-2", "kamar2"]) {
      expect(app).toContain(JSON.stringify(slug));
    }
    expect(app).toContain('from "./pages/Halaman2Kamar"');
    expect(app).toContain('from "./pages/Kamar"');
    expect(app).toContain('from "./pages/Kamar2"');
    expect(app).toContain('from "./pages/Kamar22"');
  });

  test("nama komponen unik, valid, dan berawalan huruf", async () => {
    const hasil = await exportReactProject(dir);
    const entries = parseZip(hasil.data);
    const pages = entries
      .map((item) => item.name)
      .filter((name) => name.startsWith("src/pages/") && name.endsWith(".tsx"))
      .map((name) => name.slice("src/pages/".length, -".tsx".length));
    expect(pages).toEqual(["Halaman2Kamar", "Kamar", "Kamar2", "Kamar22"]);
    expect(new Set(pages).size).toBe(pages.length);
    for (const name of pages) expect(/^[A-Za-z][A-Za-z0-9]*$/.test(name)).toBe(true);
  });

  test("rujukan aset di JSX dan CSS menjadi /assets/...", async () => {
    const hasil = await exportReactProject(dir);
    const entries = parseZip(hasil.data);
    const komponen = entryText(entries, "src/pages/Halaman2Kamar.tsx");
    expect(komponen).toBeDefined();
    expect(komponen).toContain('src="/assets/a.png"');
    expect(komponen).not.toContain("../assets");
    const css = entryText(entries, "src/pages/Halaman2Kamar.css");
    expect(css).toBeDefined();
    expect(css).toContain('url("/assets/a.png")');
    expect(css).not.toContain("../assets");
  });

  test("package.json valid dengan script typecheck", async () => {
    const hasil = await exportReactProject(dir);
    const entries = parseZip(hasil.data);
    const teks = entryText(entries, "package.json");
    expect(teks).toBeDefined();
    const paket = JSON.parse(teks!) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(paket.scripts.typecheck).toBe("tsc --noEmit");
    expect(paket.dependencies.react).toBeDefined();
    expect(paket.dependencies["react-dom"]).toBeDefined();
  });

  test("README memuat catatan konversi bila ada peringatan", async () => {
    const hasil = await exportReactProject(dir);
    const entries = parseZip(hasil.data);
    const readme = entryText(entries, "README.md");
    expect(readme).toBeDefined();
    expect(readme).toContain("Catatan konversi");
    expect(readme).toContain("Skrip dibuang.");
  });

  test("dua kali ekspor menghasilkan byte identik", async () => {
    const pertama = await exportReactProject(dir);
    const kedua = await exportReactProject(dir);
    expect(new Uint8Array(kedua.data)).toEqual(new Uint8Array(pertama.data));
  });

  test("tanpa folder design -> 404", async () => {
    const kosong = await mkdtemp(join(tmpdir(), "jejak-design-react-kosong-"));
    try {
      const galat = await exportReactProject(kosong).catch((error: unknown) => error);
      expect(galat).toBeInstanceOf(DesignError);
      expect((galat as DesignError).status).toBe(404);
    } finally {
      await rm(kosong, { recursive: true, force: true });
    }
  });

  test("tanpa halaman -> 404", async () => {
    const tanpaHalaman = await mkdtemp(join(tmpdir(), "jejak-design-react-kosong-halaman-"));
    try {
      await mkdir(join(tanpaHalaman, "design"), { recursive: true });
      await writeFile(
        join(tanpaHalaman, "design", "design.json"),
        JSON.stringify({ version: 1, pages: [] }),
        "utf8",
      );
      const galat = await exportReactProject(tanpaHalaman).catch((error: unknown) => error);
      expect(galat).toBeInstanceOf(DesignError);
      expect((galat as DesignError).status).toBe(404);
    } finally {
      await rm(tanpaHalaman, { recursive: true, force: true });
    }
  });
});
