import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { CodeView } from "../src/client/components/CodeView";
import { FileTree } from "../src/client/components/FileTree";
import { FilesTab } from "../src/client/components/FilesTab";
import type { ApiClient, DirEntry, FileContent } from "../src/client/lib/api";
import {
  loadTreeHidden,
  parseTreeHidden,
  saveTreeHidden,
} from "../src/client/lib/file-tree";
import { findAll, find, fire, flushEffects, installDom, mount } from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
});

afterAll(() => {
  bersihkan?.();
});

function byClass(root: ReturnType<typeof mount>, name: string) {
  return findAll(root, (node) => node.className.split(/\s+/).includes(name));
}

describe("CodeView", () => {
  test("memberi kelas token, nomor baris, dan baris tersorot", () => {
    const root = mount(
      h(CodeView, {
        content: "const x = 1;\n// catatan",
        path: "a.ts",
        highlightLine: 2,
      }),
    );
    const keyword = byClass(root, "tok-keyword");
    expect(keyword.length).toBeGreaterThan(0);
    expect(keyword[0]?.textContent).toBe("const");
    const lines = byClass(root, "jk-perm-line");
    expect(lines.length).toBe(2);
    expect(lines[0]?.textContent).toContain("1");
    expect(lines[1]?.className).toContain("jk-line-hit");
    expect(byClass(root, "tok-comment").length).toBeGreaterThan(0);
  });

  test("bahasa plain tidak menghasilkan span token", () => {
    const root = mount(h(CodeView, { content: "halo dunia", path: "catatan.xyz" }));
    expect(byClass(root, "tok-keyword").length).toBe(0);
    expect(root.textContent).toContain("halo dunia");
  });
});

const LISTINGS: Record<string, DirEntry[]> = {
  "": [
    { name: "src", type: "dir" },
    { name: "README.md", type: "file" },
  ],
  src: [{ name: "app.ts", type: "file" }],
};

describe("FileTree", () => {
  test("folder terbuka menampilkan anak dan berkas aktif ditandai", () => {
    const root = mount(
      h(FileTree, {
        listings: LISTINGS,
        expanded: new Set(["src"]),
        activePath: "src/app.ts",
        filter: "",
        onFilterChange: () => {},
        onToggle: () => {},
        onOpen: () => {},
      }),
    );
    const rows = findAll(root, (node) => node.getAttribute("role") === "treeitem");
    expect(rows.map((row) => row.textContent)).toEqual(["src", "app.ts", "README.md"]);
    const active = rows.find((row) => row.getAttribute("aria-current") === "true");
    expect(active?.textContent).toBe("app.ts");
    expect(rows[0]?.getAttribute("aria-expanded")).toBe("true");
  });

  test("klik folder memanggil onToggle, klik berkas memanggil onOpen", () => {
    const toggled: string[] = [];
    const opened: string[] = [];
    const root = mount(
      h(FileTree, {
        listings: LISTINGS,
        expanded: new Set<string>(),
        filter: "",
        onFilterChange: () => {},
        onToggle: (path: string) => toggled.push(path),
        onOpen: (path: string) => opened.push(path),
      }),
    );
    const rows = findAll(root, (node) => node.getAttribute("role") === "treeitem");
    fire(rows[0]!, "click");
    fire(rows[1]!, "click");
    expect(toggled).toEqual(["src"]);
    expect(opened).toEqual(["README.md"]);
  });

  test("filter menyaring baris", () => {
    const root = mount(
      h(FileTree, {
        listings: LISTINGS,
        expanded: new Set(["src"]),
        filter: "app",
        onFilterChange: () => {},
        onToggle: () => {},
        onOpen: () => {},
      }),
    );
    const rows = findAll(root, (node) => node.getAttribute("role") === "treeitem");
    expect(rows.map((row) => row.textContent)).toEqual(["app.ts"]);
  });
});

describe("helper sembunyikan pohon", () => {
  test("parse hanya mengenali \"1\"", () => {
    expect(parseTreeHidden("1")).toBe(true);
    expect(parseTreeHidden("0")).toBe(false);
    expect(parseTreeHidden(null)).toBe(false);
  });

  test("muat dan simpan memakai penyimpanan", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(loadTreeHidden(storage)).toBe(false);
    saveTreeHidden(storage, true);
    expect(store.get("jejak.fileTreeHidden")).toBe("1");
    expect(loadTreeHidden(storage)).toBe(true);
  });

  test("penyimpanan rusak diabaikan", () => {
    const broken = {
      getItem: () => {
        throw new Error("diblokir");
      },
      setItem: () => {
        throw new Error("diblokir");
      },
    };
    expect(loadTreeHidden(broken)).toBe(false);
    expect(() => saveTreeHidden(broken, true)).not.toThrow();
  });
});

function fakeApi(file: FileContent): ApiClient {
  return {
    getFiles: async (id: string, path?: string) => ({
      path: path ?? "",
      entries: LISTINGS[path ?? ""] ?? [],
      truncated: false,
    }),
    getFile: async () => file,
  } as unknown as ApiClient;
}

async function renderTab(file: FileContent) {
  const root = mount(
    h(FilesTab, {
      api: fakeApi(file),
      sessionId: "s1",
      open: true,
      refreshToken: 0,
    }),
  );
  await flushEffects();
  const segments = file.path.split("/");
  const name = segments.pop() ?? "";
  for (const dirName of segments) {
    const dirEntry = find(
      root,
      (node) => node.className.split(/\s+/).includes("jk-panel-entry") && node.textContent.includes(dirName),
    );
    if (dirEntry !== undefined) {
      fire(dirEntry, "click");
      await flushEffects();
    }
  }
  const entry = find(
    root,
    (node) => node.className.split(/\s+/).includes("jk-panel-entry") && node.textContent.includes(name),
  );
  if (entry !== undefined) {
    fire(entry, "click");
    await flushEffects();
  }
  return root;
}

describe("FilesTab pratinjau Markdown", () => {
  test("berkas .md tampil sebagai pratinjau dengan tombol kode", async () => {
    const root = await renderTab({
      path: "README.md",
      size: 10,
      binary: false,
      truncated: false,
      content: "# Judul",
    });
    expect(find(root, (node) => node.className.includes("jk-md"))).toBeDefined();
    expect(find(root, (node) => node.getAttribute("aria-label") === "Tampilkan kode")).toBeDefined();
    expect(byClass(root, "jk-vs-code").length).toBe(0);
  });

  test("berkas .ts langsung mode kode tanpa tombol pratinjau", async () => {
    const root = await renderTab({
      path: "src/app.ts",
      size: 10,
      binary: false,
      truncated: false,
      content: "const x = 1;",
    });
    expect(byClass(root, "jk-vs-code").length).toBe(1);
    expect(find(root, (node) => node.getAttribute("aria-label") === "Tampilkan kode")).toBeUndefined();
  });
});
