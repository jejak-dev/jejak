import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import {
  DESIGN_EDIT_DISABLED_MESSAGE,
  DesignTools,
} from "../src/server/design/design-tools";
import { initDesign } from "../src/server/design/write";

let dir: string;

const DOC = `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><title>Beranda</title></head>
<body>
  <h1 id="judul">Judul lama</h1>
  <p class="teks">satu</p>
  <p class="teks">dua</p>
  <button id="tombol" type="button">Klik</button>
</body>
</html>
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-tools-"));
  await initDesign(dir, { tracked: true });
  await writeFile(join(dir, "design", "pages", "home.html"), DOC, "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function pagePath(): string {
  return join(dir, "design", "pages", "home.html");
}

function tools(options: { editEnabled?: () => boolean; audit?: SqliteAuditStore } = {}): DesignTools {
  return new DesignTools({
    editEnabled: options.editEnabled ?? (() => true),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  });
}

function ctx(): { sessionId: string; cwd: string } {
  return { sessionId: "s_design", cwd: dir };
}

describe("definisi tool desain", () => {
  test("satu tool design_patch dengan skema benar", () => {
    const definitions = tools().definitions;
    expect(definitions).toHaveLength(1);
    const def = definitions[0]!;
    expect(def.name).toBe("design_patch");
    expect(def.inputSchema.additionalProperties).toBe(false);
    expect(def.inputSchema.required).toEqual(["slug", "selector", "op"]);
    const props = def.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.op?.enum).toEqual(["replace", "inner", "text", "attr", "remove", "before", "after"]);
  });
});

describe("design_patch perilaku", () => {
  test("op text pada [id] berhasil dan audit tercatat tanpa selector", async () => {
    const store = new SqliteAuditStore(":memory:");
    try {
      const hasil = await tools({ audit: store }).call(ctx(), "design_patch", {
        slug: "home",
        selector: '[id="judul"]',
        op: "text",
        value: "Judul baru",
      });
      expect(hasil.isError).toBe(false);
      expect(hasil.text).toContain("Berhasil");
      const isi = await readFile(pagePath(), "utf8");
      expect(isi).toContain("Judul baru");
      expect(isi).not.toContain("Judul lama");

      const entri = store.list();
      expect(entri).toHaveLength(1);
      expect(entri[0]?.kind).toBe("berkas");
      expect(entri[0]?.summary).toBe("Halaman desain diubah agent");
      expect(entri[0]?.meta.aksi).toBe("design-patch");
      expect(entri[0]?.meta.halaman).toBe("home");
      expect(entri[0]?.meta.op).toBe("text");
      expect(JSON.stringify(entri)).not.toContain("[id=");
      expect(JSON.stringify(entri)).not.toContain("Judul baru");
    } finally {
      store.close();
    }
  });

  test("editEnabled false ditolak dan berkas tak berubah", async () => {
    const hasil = await tools({ editEnabled: () => false }).call(ctx(), "design_patch", {
      slug: "home",
      selector: '[id="judul"]',
      op: "text",
      value: "baru",
    });
    expect(hasil.isError).toBe(true);
    expect(hasil.text).toBe(DESIGN_EDIT_DISABLED_MESSAGE);
    expect(await readFile(pagePath(), "utf8")).toBe(DOC);
  });

  test("selector cocok lebih dari satu / nol ditolak", async () => {
    const banyak = await tools().call(ctx(), "design_patch", {
      slug: "home",
      selector: "p",
      op: "remove",
    });
    expect(banyak.isError).toBe(true);
    expect(banyak.text).toContain("2 elemen");

    const nol = await tools().call(ctx(), "design_patch", {
      slug: "home",
      selector: "#tidak-ada",
      op: "remove",
    });
    expect(nol.isError).toBe(true);
  });

  test("baseMtime salah ditolak dengan pesan berubah", async () => {
    const hasil = await tools().call(ctx(), "design_patch", {
      slug: "home",
      selector: '[id="judul"]',
      op: "text",
      value: "baru",
      baseMtime: 1,
    });
    expect(hasil.isError).toBe(true);
    expect(hasil.text).toContain("berubah");
  });

  test("argumen tidak valid ditolak", async () => {
    const asing = await tools().call(ctx(), "design_patch", {
      slug: "home",
      selector: '[id="judul"]',
      op: "text",
      value: "x",
      rahasia: "y",
    });
    expect(asing.isError).toBe(true);
    expect(asing.text).toContain("tidak dikenal");

    const opSalah = await tools().call(ctx(), "design_patch", {
      slug: "home",
      selector: '[id="judul"]',
      op: 5,
    });
    expect(opSalah.isError).toBe(true);

    const bukanObjek = await tools().call(ctx(), "design_patch", ["x"]);
    expect(bukanObjek.isError).toBe(true);
  });

  test("nama tool tak dikenal ditolak", async () => {
    const hasil = await tools().call(ctx(), "design_hapus", {});
    expect(hasil.isError).toBe(true);
    expect(hasil.text).toContain("tidak dikenal");
  });

  test("pesan galat tak memuat isi value", async () => {
    const hasil = await tools().call(ctx(), "design_patch", {
      slug: "home",
      selector: "#tidak-ada",
      op: "text",
      value: "RAHASIA-123",
    });
    expect(hasil.isError).toBe(true);
    expect(hasil.text).not.toContain("RAHASIA-123");
  });
});
