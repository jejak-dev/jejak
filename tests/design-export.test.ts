import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesignError } from "../src/server/design/assemble";
import { exportDesignZip, exportStandalonePage } from "../src/server/design/export";

let dir: string;
let luar: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-export-"));
  luar = await mkdtemp(join(tmpdir(), "jejak-design-export-luar-"));
  await mkdir(join(dir, "design", "pages"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(luar, { recursive: true, force: true });
});

/** Nama-nama entri di dalam arsip, dibaca dari central directory. */
function zipNames(archive: Uint8Array): string[] {
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
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    names.push(
      new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength)),
    );
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

describe("exportStandalonePage", () => {
  test("berkas mandiri: tanpa runtime, tanpa CSP, CSS tetap di-inline", async () => {
    await writeFile(join(dir, "design", "pages", "gaya.css"), "body { color: red; }", "utf8");
    await writeFile(
      join(dir, "design", "pages", "beranda.html"),
      '<html><head><link rel="stylesheet" href="gaya.css"></head><body><p>Halo</p></body></html>',
      "utf8",
    );

    const hasil = await exportStandalonePage(dir, "beranda");
    expect(hasil.filename).toBe("beranda.html");
    expect(hasil.html).not.toContain("jejak-design-v1");
    expect(hasil.html).not.toContain("data-jejak-design-runtime");
    expect(hasil.html).not.toContain("Content-Security-Policy");
    expect(hasil.html).toContain("<style>body { color: red; }</style>");
    expect(hasil.html).toContain("<p>Halo</p>");
  });

  test("slug tak sah 400 dan halaman hilang 404", async () => {
    const takSah = await exportStandalonePage(dir, "../x").catch((error: unknown) => error);
    expect(takSah).toBeInstanceOf(DesignError);
    expect((takSah as DesignError).status).toBe(400);

    const hilang = await exportStandalonePage(dir, "hilang").catch((error: unknown) => error);
    expect(hilang).toBeInstanceOf(DesignError);
    expect((hilang as DesignError).status).toBe(404);
  });
});

describe("exportDesignZip", () => {
  test("isi folder design masuk semua ke arsip", async () => {
    await writeFile(join(dir, "design", "pages", "beranda.html"), "<html></html>", "utf8");
    await writeFile(join(dir, "design", "tokens.css"), ":root { --warna: #000; }", "utf8");
    await writeFile(
      join(dir, "design", "design.json"),
      JSON.stringify({ version: 1, pages: [{ slug: "beranda" }] }),
      "utf8",
    );
    await writeFile(join(dir, "design", "DESIGN.md"), "# Desain\n", "utf8");

    const hasil = await exportDesignZip(dir);
    expect(hasil.filename).toBe("design.zip");
    expect(hasil.files).toBe(4);
    expect(hasil.skipped).toBe(0);
    const names = zipNames(hasil.data);
    expect(names).toContain("pages/beranda.html");
    expect(names).toContain("tokens.css");
    expect(names).toContain("design.json");
    expect(names).toContain("DESIGN.md");
  });

  test("symlink dan berkas tersembunyi dilewati", async () => {
    await writeFile(join(dir, "design", "pages", "beranda.html"), "<html></html>", "utf8");
    await writeFile(join(dir, "design", ".rahasia"), "jangan ikut", "utf8");
    const luarFile = join(luar, "rahasia.txt");
    await writeFile(luarFile, "jangan ikut", "utf8");
    await symlink(luarFile, join(dir, "design", "symlink-luar.txt"));
    await symlink(join(dir, "design", "pages", "beranda.html"), join(dir, "design", "symlink-dalam.txt"));

    const hasil = await exportDesignZip(dir);
    const names = zipNames(hasil.data);
    expect(names).toEqual(["pages/beranda.html"]);
    expect(hasil.files).toBe(1);
    expect(hasil.skipped).toBe(3);
  });

  test("tanpa folder design -> 404", async () => {
    const kosong = await mkdtemp(join(tmpdir(), "jejak-design-export-kosong-"));
    try {
      const galat = await exportDesignZip(kosong).catch((error: unknown) => error);
      expect(galat).toBeInstanceOf(DesignError);
      expect((galat as DesignError).status).toBe(404);
    } finally {
      await rm(kosong, { recursive: true, force: true });
    }
  });
});
