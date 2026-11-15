import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import {
  ClaudeMemoryRow,
  ClaudeMemorySectionView,
  type ClaudeMemoryProjectState,
} from "../src/client/components/ClaudeMemorySection";
import {
  claudeMemoryCount,
  claudeMemoryDescriptionLine,
  claudeMemoryTypeLabel,
  parseClaudeMemoryResponse,
  sortClaudeMemoryItems,
  type ClaudeMemoryItem,
  type ClaudeMemoryResponse,
} from "../src/client/lib/claude-memory";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function textOf(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    return textOf((vnode.type as (props: unknown) => ComponentChild)(vnode.props));
  }
  return textOf(vnode.props.children as ComponentChild);
}

function findNodes(node: ComponentChild, predicate: (vnode: VNode) => boolean): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, predicate));
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return findNodes(rendered, predicate);
  }
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(findNodes(vnode.props.children as ComponentChild, predicate));
}

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = (vnode.props as Record<string, unknown>).class;
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

function buttons(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => vnode.type === "button");
}

function makeItem(overrides: Partial<ClaudeMemoryItem> = {}): ClaudeMemoryItem {
  return {
    file: "satu.md",
    title: "Judul",
    description: "Deskripsi singkat",
    type: "project",
    body: "Isi memory.",
    updatedAt: "2026-11-08T10:00:00.000Z",
    truncated: false,
    ...overrides,
  };
}

function makeResponse(items: ClaudeMemoryItem[]): ClaudeMemoryResponse {
  return {
    project: "proyek",
    dirs: [{ label: "proyek", dirExists: true, items }],
  };
}

function renderView(
  states: ClaudeMemoryProjectState[],
): ComponentChild {
  return ClaudeMemorySectionView({ states }) as unknown as ComponentChild;
}

/* ---------- Logika murni ---------- */

describe("claudeMemoryTypeLabel", () => {
  test("tipe dikenal punya label Indonesia", () => {
    expect(claudeMemoryTypeLabel("user")).toBe("Pengguna");
    expect(claudeMemoryTypeLabel("feedback")).toBe("Masukan");
    expect(claudeMemoryTypeLabel("project")).toBe("Proyek");
    expect(claudeMemoryTypeLabel("reference")).toBe("Referensi");
  });

  test("tipe unknown punya label", () => {
    expect(claudeMemoryTypeLabel("unknown")).toBe("Tanpa tipe");
  });
});

describe("claudeMemoryDescriptionLine", () => {
  test("baris baru jadi spasi", () => {
    expect(
      claudeMemoryDescriptionLine(makeItem({ description: "satu\ndua\t tiga" })),
    ).toBe("satu dua tiga");
  });

  test("deskripsi kosong jadi string kosong", () => {
    expect(claudeMemoryDescriptionLine(makeItem({ description: "   " }))).toBe("");
  });
});

describe("sortClaudeMemoryItems", () => {
  test("urut dari yang terbaru", () => {
    const items = [
      makeItem({ file: "lama.md", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeItem({ file: "baru.md", updatedAt: "2026-06-01T00:00:00.000Z" }),
    ];
    expect(sortClaudeMemoryItems(items).map((item) => item.file)).toEqual([
      "baru.md",
      "lama.md",
    ]);
  });
});

describe("parseClaudeMemoryResponse", () => {
  test("respons sah dibaca utuh", () => {
    const parsed = parseClaudeMemoryResponse({
      project: "proyek",
      dirs: [
        {
          label: "proyek",
          dirExists: true,
          items: [
            {
              file: "a.md",
              title: "A",
              description: "d",
              type: "user",
              body: "isi",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    expect(parsed?.dirs[0]?.items[0]?.title).toBe("A");
    expect(parsed?.dirs[0]?.items[0]?.truncated).toBe(false);
  });

  test("tipe tak dikenal ditolak", () => {
    expect(
      parseClaudeMemoryResponse({
        project: "p",
        dirs: [
          {
            label: "p",
            dirExists: true,
            items: [
              {
                file: "a.md",
                title: "A",
                description: "d",
                type: "entah",
                body: "isi",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  test("bentuk tak dikenal ditolak", () => {
    expect(parseClaudeMemoryResponse(null)).toBeNull();
    expect(parseClaudeMemoryResponse({ project: "p" })).toBeNull();
    expect(parseClaudeMemoryResponse({ project: "p", dirs: "bukan" })).toBeNull();
  });
});

describe("claudeMemoryCount", () => {
  test("menjumlahkan item seluruh folder", () => {
    const response: ClaudeMemoryResponse = {
      project: "p",
      dirs: [
        { label: "a", dirExists: true, items: [makeItem(), makeItem({ file: "b.md" })] },
        { label: "b", dirExists: true, items: [makeItem({ file: "c.md" })] },
      ],
    };
    expect(claudeMemoryCount(response)).toBe(3);
  });
});

/* ---------- Tampilan ---------- */

describe("ClaudeMemorySectionView", () => {
  test("bagian tampil dengan judul dan keterangan baca-saja", () => {
    const node = renderView([
      {
        project: "/a/proyek",
        response: makeResponse([makeItem()]),
        loading: false,
        error: undefined,
      },
    ]);
    const text = textOf(node);
    expect(text).toContain("Dari Claude Code");
    expect(text).toContain("Hanya baca; dikelola Claude Code.");
    expect(text).toContain("Judul");
  });

  test("keadaan kosong menampilkan pesan yang diminta", () => {
    const node = renderView([
      {
        project: "/a/proyek",
        response: makeResponse([]),
        loading: false,
        error: undefined,
      },
    ]);
    expect(textOf(node)).toContain("Belum ada memory Claude Code untuk proyek ini.");
  });

  test("galat tampil sebaris", () => {
    const node = renderView([
      {
        project: "/a/proyek",
        response: undefined,
        loading: false,
        error: "gagal memuat",
      },
    ]);
    expect(textOf(node)).toContain("gagal memuat");
    const alerts = findNodes(node, (vnode) => propsOf(vnode)["role"] === "alert");
    expect(alerts).toHaveLength(1);
  });

  test("tidak ada tombol sunting, hapus, atau setujui", () => {
    const node = renderView([
      {
        project: "/a/proyek",
        response: makeResponse([makeItem()]),
        loading: false,
        error: undefined,
      },
    ]);
    const labels = buttons(node).map((vnode) => textOf(propsOf(vnode).children as ComponentChild));
    expect(labels).not.toContain("Ubah");
    expect(labels).not.toContain("Hapus");
    expect(labels).not.toContain("Terima");
    expect(labels).not.toContain("Tolak");
    expect(labels).not.toContain("Arsipkan");
  });

  test("lencana asal Claude tampil pada baris", () => {
    const node = renderView([
      {
        project: "/a/proyek",
        response: makeResponse([makeItem()]),
        loading: false,
        error: undefined,
      },
    ]);
    expect(textOf(node)).toContain("Claude");
  });

  test("satu lencana tipe per baris", () => {
    const node = renderView([
      {
        project: "/a/proyek",
        response: makeResponse([makeItem()]),
        loading: false,
        error: undefined,
      },
    ]);
    expect(byClass(node, "jk-claude-type")).toHaveLength(1);
  });

  test("tanpa proyek diketahui menampilkan catatan", () => {
    const node = renderView([]);
    expect(textOf(node)).toContain("Belum ada folder proyek yang dikenal.");
  });

  test("nama proyek tampil bila ada beberapa proyek", () => {
    const node = renderView([
      {
        project: "/a/proyek-satu",
        response: makeResponse([makeItem()]),
        loading: false,
        error: undefined,
      },
      {
        project: "/b/proyek-dua",
        response: makeResponse([makeItem()]),
        loading: false,
        error: undefined,
      },
    ]);
    const text = textOf(node);
    expect(text).toContain("proyek-satu");
    expect(text).toContain("proyek-dua");
  });

  test("saat memuat, isi lama belum tampil", () => {
    const node = renderView([
      {
        project: "/a/proyek",
        response: undefined,
        loading: true,
        error: undefined,
      },
    ]);
    expect(textOf(node)).toContain("Memuat…");
    expect(textOf(node)).not.toContain("Belum ada memory Claude Code untuk proyek ini.");
  });
});

describe("ClaudeMemoryRow", () => {
  test("baris menampilkan judul, deskripsi, tipe, dan waktu", () => {
    const node = ClaudeMemoryRow({
      item: makeItem(),
    }) as unknown as ComponentChild;
    const text = textOf(node);
    expect(text).toContain("Judul");
    expect(text).toContain("Deskripsi singkat");
    expect(text).toContain("Proyek");
    expect(text).toContain("Claude");
  });

  test("baris tanpa tombol aksi", () => {
    const node = ClaudeMemoryRow({ item: makeItem() }) as unknown as ComponentChild;
    const labels = buttons(node).map((vnode) => textOf(propsOf(vnode).children as ComponentChild));
    expect(labels).not.toContain("Ubah");
    expect(labels).not.toContain("Hapus");
    expect(labels).not.toContain("Terima");
    expect(labels).not.toContain("Tolak");
  });
});
