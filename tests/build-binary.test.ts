import { describe, expect, test } from "bun:test";
import {
  BUILD_TARGETS,
  compiledEntrySource,
  generateEmbeddedModule,
  isBuildTarget,
  parseBuildArgs,
  targetOutputName,
  targetOutputPath,
  type BuildTarget,
  type EmbeddedEntry,
} from "../scripts/build-binary";
import { extractChunkRefs } from "../scripts/smoke-binary";

const ENTRI: EmbeddedEntry[] = [
  {
    name: "app.js",
    importPath: "./client/app.js",
    kind: "js",
    contentType: "application/javascript; charset=utf-8",
  },
  {
    name: "app.css",
    importPath: "./client/app.css",
    kind: "css",
    contentType: "text/css; charset=utf-8",
  },
  {
    name: "chunk-abc123.js",
    importPath: "./client/chunk-abc123.js",
    kind: "file",
    contentType: "application/javascript; charset=utf-8",
  },
];

describe("generateEmbeddedModule", () => {
  test("mengimpor tiap berkas statis dengan type file", () => {
    const teks = generateEmbeddedModule(ENTRI);

    expect(teks).toContain(
      'import f0 from "./client/app.js" with { type: "file" };',
    );
    expect(teks).toContain(
      'import f1 from "./client/app.css" with { type: "file" };',
    );
    expect(teks).toContain(
      'import f2 from "./client/chunk-abc123.js" with { type: "file" };',
    );
  });

  test("mendaftarkan js, css, dan peta berkas tambahan", () => {
    const teks = generateEmbeddedModule(ENTRI);

    expect(teks).toContain('import { registerEmbeddedClient } from "../src/server/client-source";');
    expect(teks).toContain("registerEmbeddedClient({");
    expect(teks).toContain("js: f0,");
    expect(teks).toContain("css: f1,");
    expect(teks).toContain(
      '"chunk-abc123.js": { path: f2, contentType: "application/javascript; charset=utf-8" },',
    );
  });

  test("menescape nama berkas aneh dengan JSON.stringify", () => {
    const aneh: EmbeddedEntry[] = [
      ENTRI[0] as EmbeddedEntry,
      ENTRI[1] as EmbeddedEntry,
      {
        name: 'a"b\\c.js',
        importPath: './client/a"b\\c.js',
        kind: "file",
        contentType: "application/octet-stream",
      },
    ];

    const teks = generateEmbeddedModule(aneh);

    expect(teks).toContain('"a\\"b\\\\c.js": { path: f2, contentType: "application/octet-stream" },');
    expect(teks).toContain('import f2 from "./client/a\\"b\\\\c.js" with { type: "file" };');
  });

  test("identifier mengikuti urutan entri", () => {
    const teks = generateEmbeddedModule([
      ENTRI[2] as EmbeddedEntry,
      ENTRI[0] as EmbeddedEntry,
      ENTRI[1] as EmbeddedEntry,
    ]);

    const posisi = (needle: string): number => teks.indexOf(needle);
    expect(posisi("import f0 from \"./client/chunk-abc123.js\"")).toBeGreaterThan(-1);
    expect(posisi("import f1 from \"./client/app.js\"")).toBeGreaterThan(posisi("import f0"));
    expect(posisi("import f2 from \"./client/app.css\"")).toBeGreaterThan(posisi("import f1"));
    expect(teks).toContain("js: f1,");
    expect(teks).toContain("css: f2,");
    expect(teks).toContain('"chunk-abc123.js": { path: f0,');
  });

  test("berkas tambahan tanpa chunk menghasilkan peta kosong", () => {
    const teks = generateEmbeddedModule([ENTRI[0] as EmbeddedEntry, ENTRI[1] as EmbeddedEntry]);

    expect(teks).toContain("files: {},");
  });

  test("entri js atau css yang hilang ditolak", () => {
    expect(() => generateEmbeddedModule([ENTRI[1] as EmbeddedEntry])).toThrow(
      "modul tertanam butuh satu entri js",
    );
    expect(() => generateEmbeddedModule([ENTRI[0] as EmbeddedEntry])).toThrow(
      "modul tertanam butuh satu entri css",
    );
  });
});

describe("compiledEntrySource", () => {
  test("mendaftarkan klien sebelum memuat CLI", () => {
    const teks = compiledEntrySource();

    expect(teks.indexOf('import "./embedded-client";')).toBeLessThan(
      teks.indexOf('import "../src/cli/index";'),
    );
  });
});

describe("parseBuildArgs", () => {
  const bawaan: BuildTarget = "bun-darwin-arm64";

  test("tanpa argumen memakai target bawaan", () => {
    const hasil = parseBuildArgs([], bawaan);
    expect(hasil.error).toBeUndefined();
    expect(hasil.targets).toEqual(["bun-darwin-arm64"]);
  });

  test("--target dengan nilai terpisah", () => {
    const hasil = parseBuildArgs(["--target", "bun-windows-x64"], bawaan);
    expect(hasil.error).toBeUndefined();
    expect(hasil.targets).toEqual(["bun-windows-x64"]);
  });

  test("--target dengan tanda sama", () => {
    const hasil = parseBuildArgs(["--target=bun-darwin-x64"], bawaan);
    expect(hasil.error).toBeUndefined();
    expect(hasil.targets).toEqual(["bun-darwin-x64"]);
  });

  test("--all memakai semua target sah", () => {
    const hasil = parseBuildArgs(["--all"], bawaan);
    expect(hasil.error).toBeUndefined();
    expect(hasil.targets).toEqual([...BUILD_TARGETS]);
  });

  test("target tidak dikenal ditolak", () => {
    const hasil = parseBuildArgs(["--target", "bun-freebsd-x64"], bawaan);
    expect(hasil.targets).toEqual([]);
    expect(hasil.error).toContain("Target tidak dikenal");
  });

  test("--target tanpa nilai ditolak", () => {
    const hasil = parseBuildArgs(["--target"], bawaan);
    expect(hasil.targets).toEqual([]);
    expect(hasil.error).toContain("--target butuh nilai");
  });

  test("--all dan --target bersamaan ditolak", () => {
    const hasil = parseBuildArgs(["--all", "--target", "bun-darwin-arm64"], bawaan);
    expect(hasil.targets).toEqual([]);
    expect(hasil.error).toContain("tidak boleh dipakai bersamaan");
  });

  test("argumen asing ditolak", () => {
    const hasil = parseBuildArgs(["--wat"], bawaan);
    expect(hasil.targets).toEqual([]);
    expect(hasil.error).toContain("Argumen tidak dikenal");
  });

  test("platform tanpa target sah menghasilkan galat", () => {
    const hasil = parseBuildArgs([], null);
    expect(hasil.targets).toEqual([]);
    expect(hasil.error).toContain("tidak punya target sah");
  });
});

describe("pemetaan target ke nama keluaran", () => {
  test("windows mendapat akhiran .exe", () => {
    expect(targetOutputName("bun-windows-x64")).toBe("jejak-windows-x64.exe");
  });

  test("macOS tidak mendapat akhiran", () => {
    expect(targetOutputName("bun-darwin-arm64")).toBe("jejak-darwin-arm64");
    expect(targetOutputName("bun-darwin-x64")).toBe("jejak-darwin-x64");
  });

  test("path keluaran berada di folder dist", () => {
    expect(targetOutputPath("bun-darwin-arm64")).toMatch(/dist[/\\]jejak-darwin-arm64$/);
    expect(targetOutputPath("bun-windows-x64")).toMatch(/dist[/\\]jejak-windows-x64\.exe$/);
  });
});

describe("isBuildTarget", () => {
  test("menerima target sah dan menolak yang lain", () => {
    expect(isBuildTarget("bun-darwin-arm64")).toBe(true);
    expect(isBuildTarget("bun-windows-x64")).toBe(true);
    expect(isBuildTarget("bun-freebsd-x64")).toBe(false);
    expect(isBuildTarget("bun-linux-x64")).toBe(true);
    expect(isBuildTarget("bun-linux-arm64")).toBe(true);
    expect(isBuildTarget("")).toBe(false);
  });
});

describe("extractChunkRefs", () => {
  test("menemukan nama chunk yang dirujuk", () => {
    const js = 'import("./chunk-abc123.js");import("./chunk-zz9.js");';
    expect(extractChunkRefs(js)).toEqual(["chunk-abc123.js", "chunk-zz9.js"]);
  });

  test("nama chunk unik tidak diulang", () => {
    const js = '"./chunk-a.js";"./chunk-a.js";"./chunk-b.js";';
    expect(extractChunkRefs(js)).toEqual(["chunk-a.js", "chunk-b.js"]);
  });

  test("bundel tanpa chunk mengembalikan daftar kosong", () => {
    expect(extractChunkRefs("console.log('halo');")).toEqual([]);
  });
});
