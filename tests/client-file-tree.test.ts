import { describe, expect, test } from "bun:test";
import type { DirEntry } from "../src/client/lib/api";
import {
  ancestorDirs,
  filterRows,
  flattenTree,
  isMarkdownPath,
  MARKDOWN_EXT,
  toggleExpanded,
  type TreeRow,
} from "../src/client/lib/file-tree";

const dir = (name: string): DirEntry => ({ name, type: "dir" });
const file = (name: string): DirEntry => ({ name, type: "file" });

describe("isMarkdownPath", () => {
  test("mengenali ekstensi markdown tanpa peduli kapital", () => {
    expect(isMarkdownPath("README.MD")).toBe(true);
    expect(isMarkdownPath("a/b/c.markdown")).toBe(true);
    expect(isMarkdownPath("x.mdx")).toBe(true);
    expect(isMarkdownPath("a.ts")).toBe(false);
    expect(isMarkdownPath("md")).toBe(false);
  });

  test("daftar ekstensi tetap", () => {
    expect(MARKDOWN_EXT).toEqual([".md", ".markdown", ".mdx"]);
  });
});

describe("ancestorDirs", () => {
  test("akar selalu pertama", () => {
    expect(ancestorDirs("a/b/c.ts")).toEqual(["", "a", "a/b"]);
  });

  test("berkas tingkat atas hanya akar", () => {
    expect(ancestorDirs("a.ts")).toEqual([""]);
  });

  test("path kosong hanya akar", () => {
    expect(ancestorDirs("")).toEqual([""]);
  });
});

describe("flattenTree", () => {
  const listings: Record<string, DirEntry[]> = {
    "": [file("b.ts"), dir("src"), file("A.md")],
    src: [file("z.ts"), dir("lib"), file("a.ts")],
    "src/lib": [file("x.ts")],
  };

  test("folder dulu lalu berkas, nama tanpa peduli kapital", () => {
    const rows = flattenTree(listings, new Set());
    expect(rows.map((row) => row.path)).toEqual(["src", "A.md", "b.ts"]);
    expect(rows[0]).toMatchObject({ name: "src", depth: 0, isDir: true, expanded: false });
  });

  test("folder terbuka diikuti anaknya secara rekursif", () => {
    const rows = flattenTree(listings, new Set(["src", "src/lib"]));
    expect(rows.map((row) => row.path)).toEqual([
      "src",
      "src/lib",
      "src/lib/x.ts",
      "src/a.ts",
      "src/z.ts",
      "A.md",
      "b.ts",
    ]);
    expect(rows[1]).toMatchObject({ depth: 1, isDir: true, expanded: true });
    expect(rows[2]).toMatchObject({ depth: 2, isDir: false });
  });

  test("folder terbuka tanpa isi termuat tidak punya anak", () => {
    const rows = flattenTree({ "": [dir("kosong")] }, new Set(["kosong"]));
    expect(rows.map((row) => row.path)).toEqual(["kosong"]);
    expect(rows[0]?.expanded).toBe(true);
  });

  test("daftar kosong menghasilkan baris kosong", () => {
    expect(flattenTree({}, new Set())).toEqual([]);
  });
});

describe("filterRows", () => {
  const rows: TreeRow[] = [
    { path: "src", name: "src", depth: 0, isDir: true, expanded: true },
    { path: "src/a.ts", name: "a.ts", depth: 1, isDir: false, expanded: false },
    { path: "README.md", name: "README.md", depth: 0, isDir: false, expanded: false },
  ];

  test("query kosong mengembalikan semua", () => {
    expect(filterRows(rows, "")).toEqual(rows);
    expect(filterRows(rows, "   ")).toEqual(rows);
  });

  test("menyaring nama tanpa peduli kapital, depth tetap", () => {
    const result = filterRows(rows, "readme");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ path: "README.md", depth: 0 });
  });

  test("tidak memutasi masukan", () => {
    const before = [...rows];
    filterRows(rows, "a");
    expect(rows).toEqual(before);
  });
});

describe("toggleExpanded", () => {
  test("menambah dan menghapus tanpa memutasi masukan", () => {
    const before = new Set(["a"]);
    const opened = toggleExpanded(before, "b");
    expect([...opened].sort()).toEqual(["a", "b"]);
    expect([...before]).toEqual(["a"]);

    const closed = toggleExpanded(opened, "a");
    expect([...closed]).toEqual(["b"]);
  });
});
