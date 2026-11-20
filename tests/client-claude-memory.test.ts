import { describe, expect, test } from "bun:test";
import { Fragment } from "preact";
import type { ComponentChild, VNode } from "preact";
import {
  ClaudeMemoryRow,
  ClaudeMemorySectionView,
  claudeProjectsKey,
  defaultOpenProjects,
  loadClaudeProjectStates,
  mergeClaudeProjectStates,
  type ClaudeMemoryProjectState,
} from "../src/client/components/ClaudeMemorySection";
import type { ApiClient } from "../src/client/lib/api";
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

function detailsByClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    if (vnode.type !== "details") return false;
    const value = (vnode.props as Record<string, unknown>).class;
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

/** Ringkasan (summary) milik sebuah lipatan proyek. */
function projectSummary(details: VNode | undefined): VNode | undefined {
  const children = details?.props.children as ComponentChild[] | undefined;
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
  return list.find((child) => (child as VNode | undefined)?.type === "summary") as
    | VNode
    | undefined;
}

function toggleHandler(vnode: VNode | undefined): (event: { currentTarget: { open: boolean } }) => void {
  return propsOf(vnode)["onToggle"] as (event: { currentTarget: { open: boolean } }) => void;
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

/** Cari elemen tanpa menjalankan komponen fungsi (bebas hook). */
function findElements(node: ComponentChild, predicate: (vnode: VNode) => boolean): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findElements(child, predicate));
  const vnode = node as VNode;
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(findElements(vnode.props.children as ComponentChild, predicate));
}

describe("ClaudeMemoryRow", () => {
  test("baris berupa tombol yang membuka modal", () => {
    const calls: boolean[] = [];
    const node = ClaudeMemoryRow({
      item: makeItem(),
      onToggle: (next) => calls.push(next),
    }) as unknown as ComponentChild;
    const tombol = findElements(node, (vnode) => vnode.type === "button")[0];
    expect(propsOf(tombol)["class"]).toBe("jk-claude-row");
    expect(propsOf(tombol)["aria-haspopup"]).toBe("dialog");
    (propsOf(tombol)["onClick"] as () => void)();
    expect(calls).toEqual([true]);
  });

  test("isi memory hanya dirender di modal saat baris terbuka", () => {
    const tertutup = ClaudeMemoryRow({ item: makeItem() }) as unknown as ComponentChild;
    const terbuka = ClaudeMemoryRow({ item: makeItem(), open: true }) as unknown as ComponentChild;
    const modal = (node: ComponentChild) =>
      findElements(node, (vnode) => typeof vnode.type === "function" && vnode.type !== Fragment);
    expect(modal(tertutup)).toHaveLength(0);
    expect(modal(terbuka)).toHaveLength(1);
  });

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

/* ---------- Lipatan per proyek dan pemuatan ---------- */

describe("claudeProjectsKey", () => {
  test("referensi baru dengan isi sama punya kunci sama", () => {
    expect(claudeProjectsKey(["/a/satu", "/b/dua"])).toBe(
      claudeProjectsKey(["/a/satu", "/b/dua"]),
    );
  });

  test("isi berbeda punya kunci berbeda", () => {
    expect(claudeProjectsKey(["/a/satu"])).not.toBe(claudeProjectsKey(["/a/dua"]));
  });
});

describe("defaultOpenProjects", () => {
  test("satu proyek dibuka bawaan", () => {
    expect([...defaultOpenProjects(["/a/satu"])]).toEqual(["/a/satu"]);
  });

  test("banyak proyek semuanya tertutup", () => {
    expect(defaultOpenProjects(["/a/satu", "/b/dua"]).size).toBe(0);
  });
});

describe("mergeClaudeProjectStates", () => {
  const response = makeResponse([makeItem()]);

  test("muat ulang tak mengosongkan isi lama", () => {
    const merged = mergeClaudeProjectStates(
      [{ project: "/a/proyek", response, loading: false, error: undefined }],
      [{ project: "/a/proyek", response: undefined, loading: true, error: undefined }],
    );
    expect(merged[0]?.response).toBe(response);
    expect(merged[0]?.loading).toBe(true);
    expect(merged[0]?.error).toBeUndefined();
  });

  test("proyek baru tampil sebagai sedang memuat", () => {
    const merged = mergeClaudeProjectStates(
      [],
      [{ project: "/a/proyek", response: undefined, loading: true, error: undefined }],
    );
    expect(merged[0]?.response).toBeUndefined();
    expect(merged[0]?.loading).toBe(true);
  });

  test("isi baru menggantikan isi lama", () => {
    const newer = makeResponse([makeItem({ file: "baru.md" })]);
    const merged = mergeClaudeProjectStates(
      [{ project: "/a/proyek", response, loading: false, error: undefined }],
      [{ project: "/a/proyek", response: newer, loading: false, error: undefined }],
    );
    expect(merged[0]?.response).toBe(newer);
  });

  test("galat saat muat ulang tetap menyimpan isi lama", () => {
    const merged = mergeClaudeProjectStates(
      [{ project: "/a/proyek", response, loading: false, error: undefined }],
      [{ project: "/a/proyek", response: undefined, loading: false, error: "gagal" }],
    );
    expect(merged[0]?.response).toBe(response);
    expect(merged[0]?.error).toBe("gagal");
  });
});

describe("loadClaudeProjectStates", () => {
  function fakeApi(
    handler: (project: string) => Promise<ClaudeMemoryResponse>,
  ): { api: ApiClient; calls: string[] } {
    const calls: string[] = [];
    const api = {
      listClaudeMemory: (project: string) => {
        calls.push(project);
        return handler(project);
      },
    } as unknown as ApiClient;
    return { api, calls };
  }

  test("tiap proyek diambil satu kali", async () => {
    const { api, calls } = fakeApi(async () => makeResponse([makeItem()]));
    const loaded = await loadClaudeProjectStates(api, ["/a/satu", "/b/dua"]);
    expect(calls).toEqual(["/a/satu", "/b/dua"]);
    expect(loaded.map((state) => state.project)).toEqual(["/a/satu", "/b/dua"]);
    expect(loaded.every((state) => state.loading === false)).toBe(true);
  });

  test("galat satu proyek tak menggagalkan yang lain", async () => {
    const { api } = fakeApi(async (project) => {
      if (project === "/a/satu") throw new Error("rusak");
      return makeResponse([makeItem()]);
    });
    const loaded = await loadClaudeProjectStates(api, ["/a/satu", "/b/dua"]);
    expect(loaded[0]?.error).toBe("rusak");
    expect(loaded[1]?.error).toBeUndefined();
    expect(loaded[1]?.response).toBeDefined();
  });
});

describe("ClaudeMemorySectionView lipatan proyek", () => {
  const duaProyek: ClaudeMemoryProjectState[] = [
    {
      project: "/a/proyek-satu",
      response: makeResponse([makeItem(), makeItem({ file: "dua.md" })]),
      loading: false,
      error: undefined,
    },
    {
      project: "/b/proyek-dua",
      response: makeResponse([]),
      loading: false,
      error: undefined,
    },
  ];

  test("tiap proyek jadi lipatan tertutup bawaan", () => {
    const node = renderView(duaProyek);
    const details = detailsByClass(node, "jk-claude-project");
    expect(details).toHaveLength(2);
    for (const vnode of details) {
      expect(propsOf(vnode)["open"]).toBeUndefined();
    }
  });

  test("ringkasan memuat nama proyek dan jumlah memory", () => {
    const node = renderView(duaProyek);
    const details = detailsByClass(node, "jk-claude-project");
    const teks = textOf(projectSummary(details[0])?.props.children as ComponentChild);
    expect(teks).toContain("proyek-satu");
    expect(teks).toContain("2");
  });

  test("proyek tanpa memory tetap tampil di ringkasan", () => {
    const node = renderView(duaProyek);
    const details = detailsByClass(node, "jk-claude-project");
    const teks = textOf(projectSummary(details[1])?.props.children as ComponentChild);
    expect(teks).toContain("proyek-dua");
    expect(teks).toContain("kosong");
  });

  test("satu proyek terbuka bawaan", () => {
    const node = renderView([duaProyek[0] as ClaudeMemoryProjectState]);
    const details = detailsByClass(node, "jk-claude-project");
    expect(details).toHaveLength(1);
    expect(propsOf(details[0])["open"]).toBe(true);
  });

  test("isi lama tak dikosongkan saat muat ulang", () => {
    const node = renderView([
      {
        project: "/a/proyek",
        response: makeResponse([makeItem()]),
        loading: true,
        error: undefined,
      },
    ]);
    expect(textOf(node)).toContain("Judul");
    expect(textOf(node)).not.toContain("Memuat…");
  });

  test("keadaan terbuka proyek dikendalikan pemanggil", () => {
    const node = ClaudeMemorySectionView({
      states: duaProyek,
      openProjects: new Set<string>(["/a/proyek-satu"]),
    }) as unknown as ComponentChild;
    const details = detailsByClass(node, "jk-claude-project");
    expect(propsOf(details[0])["open"]).toBe(true);
    expect(propsOf(details[1])["open"]).toBeUndefined();
  });

  test("toggle lipatan diteruskan ke pemanggil", () => {
    const calls: Array<[string, boolean]> = [];
    const node = ClaudeMemorySectionView({
      states: duaProyek,
      onToggleProject: (project, open) => {
        calls.push([project, open]);
      },
    }) as unknown as ComponentChild;
    const details = detailsByClass(node, "jk-claude-project");
    toggleHandler(details[0])({ currentTarget: { open: true } });
    expect(calls).toEqual([["/a/proyek-satu", true]]);
  });

  test("kunci baris yang dibuka diteruskan ke baris", () => {
    const node = ClaudeMemorySectionView({
      states: [duaProyek[0] as ClaudeMemoryProjectState],
      openItems: new Set<string>(["proyek/satu.md"]),
    }) as unknown as ComponentChild;
    const rows = findElements(node, (vnode) => vnode.type === ClaudeMemoryRow);
    expect(rows).toHaveLength(2);
    expect(propsOf(rows[0])["open"]).toBe(true);
    expect(propsOf(rows[1])["open"]).toBe(false);
  });
});
