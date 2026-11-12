import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientBundle } from "../src/server/client-bundle";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-client-bundle-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildClientBundle", () => {
  test("menghasilkan js dan css dari entri bawaan", async () => {
    const bundle = await buildClientBundle();
    expect(bundle.js.length).toBeGreaterThan(0);
    expect(bundle.js).toContain("Jejak");
    expect(bundle.css.length).toBeGreaterThan(0);
    expect(bundle.css).toContain("--ink");
  });

  test("entri dengan sintaks rusak melempar Error Bahasa Indonesia", async () => {
    const entry = join(dir, "rusak.tsx");
    await writeFile(entry, "export const x = <div>;\n", "utf8");

    let error: unknown;
    try {
      await buildClientBundle(entry);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("gagal membangun klien");
    expect(message).not.toContain(dir);
  });

  test("import dinamis menghasilkan chunk terpisah pada berkas tambahan", async () => {
    await writeFile(join(dir, "lazy.ts"), 'export const isi = "isi-lazy-marker";\n', "utf8");
    const entry = join(dir, "entri.ts");
    await writeFile(
      entry,
      'export async function muat() { const m = await import("./lazy.ts"); return m.isi; }\n',
      "utf8",
    );

    const bundle = await buildClientBundle(entry);
    expect(bundle.files.size).toBeGreaterThanOrEqual(1);
    expect(bundle.js).not.toContain("isi-lazy-marker");
    for (const name of bundle.files.keys()) {
      expect(name).toMatch(/^chunk-[A-Za-z0-9]+\.js$/);
    }
    const chunks = [...bundle.files.values()].map((file) => file.body).join("");
    expect(chunks).toContain("isi-lazy-marker");
  });

  test("entri tanpa import dinamis tidak menghasilkan berkas tambahan", async () => {
    const entry = join(dir, "sederhana.ts");
    await writeFile(entry, 'export const teks = "sederhana";\n', "utf8");

    const bundle = await buildClientBundle(entry);
    expect(bundle.files.size).toBe(0);
    expect(bundle.js).toContain("sederhana");
  });

  test("bundel bawaan menyimpan kode mermaid di chunk, bukan di js utama", async () => {
    const bundle = await buildClientBundle();
    expect(bundle.js.length).toBeLessThan(3_000_000);
    expect(bundle.files.size).toBeGreaterThanOrEqual(1);
    // Penanda khas internals mermaid: hanya ada di chunk.
    expect(bundle.js).not.toContain("mermaidAPI");
    expect(bundle.js).not.toContain("DOMPurify");
    const chunks = [...bundle.files.values()].map((file) => file.body).join("");
    expect(chunks).toContain("mermaidAPI");
  });

  test("chunk mengimpor entri dengan nama app.js yang disajikan server", async () => {
    const bundle = await buildClientBundle();
    const chunks = [...bundle.files.values()].map((file) => file.body).join("");
    // Chunk diimpor relatif terhadap URL-nya sendiri, jadi harus menunjuk
    // nama entri yang sama dengan yang disajikan di /app.js.
    expect(chunks).toContain('from"./app.js"');
    expect(chunks).not.toContain('from"./main.js"');
  });
});
