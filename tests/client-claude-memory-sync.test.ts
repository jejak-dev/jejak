import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import {
  ClaudeMemorySyncView,
  CLAUDE_SYNC_EXPLANATION,
} from "../src/client/components/ClaudeMemorySync";
import {
  ClaudeMemoryRow,
  ClaudeMemorySectionView,
  isDuplicateJejakItem,
  type ClaudeMemoryProjectState,
} from "../src/client/components/ClaudeMemorySection";
import {
  claudeSyncSummaryLine,
  parseClaudeMemoryResponse,
  parseClaudeMemorySyncRun,
  parseClaudeMemorySyncState,
  type ClaudeMemoryItem,
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

function switches(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => propsOf(vnode)["role"] === "switch");
}

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = propsOf(vnode)["class"];
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

const NOOP = (): void => {};

function render(
  props: Partial<Parameters<typeof ClaudeMemorySyncView>[0]> = {},
): ComponentChild {
  return ClaudeMemorySyncView({
    state: { enabled: false, locked: false },
    loading: false,
    busy: false,
    error: undefined,
    run: undefined,
    confirmOpen: false,
    onToggle: NOOP,
    onConfirm: NOOP,
    onCancel: NOOP,
    onRun: NOOP,
    ...props,
  }) as unknown as ComponentChild;
}

/* ---------- Logika murni ---------- */

describe("parseClaudeMemorySyncState", () => {
  test("bentuk lengkap diterima", () => {
    expect(parseClaudeMemorySyncState({ enabled: true, locked: false })).toEqual({
      enabled: true,
      locked: false,
    });
  });

  test("bentuk asing ditolak", () => {
    expect(parseClaudeMemorySyncState(null)).toBeNull();
    expect(parseClaudeMemorySyncState({ enabled: true })).toBeNull();
    expect(parseClaudeMemorySyncState({ enabled: "ya", locked: false })).toBeNull();
  });
});

describe("parseClaudeMemorySyncRun", () => {
  test("ringkasan dibaca utuh", () => {
    const parsed = parseClaudeMemorySyncRun({
      ditulis: 1,
      diperbarui: 2,
      dilewati: 0,
      dihapus: 1,
      konflik: ["jejak_a.md"],
      ditolakRahasia: 0,
    });
    expect(parsed).toEqual({
      ditulis: 1,
      diperbarui: 2,
      dilewati: 0,
      dihapus: 1,
      konflik: ["jejak_a.md"],
      ditolakRahasia: 0,
    });
  });

  test("bentuk asing ditolak", () => {
    expect(parseClaudeMemorySyncRun({ ditulis: "satu" })).toBeNull();
    expect(parseClaudeMemorySyncRun(null)).toBeNull();
  });

  test("ringkasan singkat menyebut jumlahnya", () => {
    const line = claudeSyncSummaryLine({
      ditulis: 1,
      diperbarui: 2,
      dilewati: 0,
      dihapus: 1,
      konflik: [],
      ditolakRahasia: 3,
    });
    expect(line).toContain("1 ditulis");
    expect(line).toContain("2 diperbarui");
    expect(line).toContain("3 ditolak");
  });
});

describe("parser memory Claude Code", () => {
  test("jejak_id dibaca dari frontmatter", () => {
    const parsed = parseClaudeMemoryResponse({
      project: "proyek",
      dirs: [
        {
          label: "proyek",
          dirExists: true,
          items: [
            {
              file: "jejak_1.md",
              title: "Gaya kode",
              description: "ringkasan",
              type: "project",
              body: "isi",
              updatedAt: "2026-01-01T00:00:00.000Z",
              jejakId: "11111111-1111-4111-8111-111111111111",
            },
          ],
        },
      ],
    });
    expect(parsed?.dirs[0]?.items[0]?.jejakId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });
});

/* ---------- Tampilan ---------- */

describe("ClaudeMemorySyncView", () => {
  test("saklar mati menampilkan keterangan tak menghapus berkas", () => {
    const node = render();
    expect(textOf(node)).toContain("Sinkronkan ke Claude Code");
    expect(textOf(node)).toContain("tak menghapus berkas");
    const daftar = switches(node);
    expect(daftar).toHaveLength(1);
    expect(propsOf(daftar[0])["aria-checked"]).toBe("false");
    expect(propsOf(daftar[0])["aria-label"]).toBe("Sinkronkan ke Claude Code");
  });

  test("modal muncul hanya saat menyalakan", () => {
    const tanpa = render();
    expect(byClass(tanpa, "jk-confirm-card").length).toBe(0);
    const dengan = render({ confirmOpen: true });
    expect(byClass(dengan, "jk-confirm-card").length).toBe(1);
    const teks = textOf(dengan);
    expect(teks).toContain("Nyalakan sinkron ke Claude Code?");
    for (const baris of CLAUDE_SYNC_EXPLANATION) {
      expect(teks).toContain(baris);
    }
  });

  test("saklar terkunci dinonaktifkan dan env disebut", () => {
    const node = render({ state: { enabled: false, locked: true } });
    const daftar = switches(node);
    expect(propsOf(daftar[0])["disabled"]).toBe(true);
    expect(textOf(node)).toContain("JEJAK_CLAUDE_SYNC");
  });

  test("saat menyala tombol sinkron manual tampil", () => {
    const node = render({ state: { enabled: true, locked: false } });
    expect(textOf(node)).toContain("Sinkronkan sekarang");
    expect(propsOf(switches(node)[0])["aria-checked"]).toBe("true");
  });

  test("hasil sinkron menampilkan ringkasan dan nama berkas bentrok", () => {
    const node = render({
      state: { enabled: true, locked: false },
      run: {
        ditulis: 1,
        diperbarui: 0,
        dilewati: 0,
        dihapus: 0,
        konflik: ["jejak_abc.md"],
        ditolakRahasia: 0,
      },
    });
    const teks = textOf(node);
    expect(teks).toContain("1 ditulis");
    expect(teks).toContain("jejak_abc.md");
  });

  test("galat tampil sebaris dengan peran alert", () => {
    const node = render({ error: "Sinkron ke Claude Code dimatikan." });
    const alert = findNodes(node, (vnode) => propsOf(vnode)["role"] === "alert");
    expect(alert).toHaveLength(1);
    expect(textOf(node)).toContain("dimatikan");
  });
});

describe("bagian Dari Claude Code", () => {
  const item: ClaudeMemoryItem = {
    file: "jejak_1.md",
    title: "Gaya kode",
    description: "ringkasan",
    type: "project",
    body: "isi",
    updatedAt: "2026-01-01T00:00:00.000Z",
    truncated: false,
    jejakId: "11111111-1111-4111-8111-111111111111",
  };

  test("berkas Jejak memakai lencana Jejak", () => {
    const node = ClaudeMemoryRow({ item }) as unknown as ComponentChild;
    expect(byClass(node, "jk-claude-badge").length).toBe(1);
    expect(textOf(node)).toContain("Jejak");
  });

  test("berkas tanpa penanda Jejak tak memakai lencana", () => {
    const node = ClaudeMemoryRow({
      item: { ...item, jejakId: undefined },
    }) as unknown as ComponentChild;
    expect(byClass(node, "jk-claude-badge").length).toBe(0);
  });

  test("berkas Jejak disembunyikan bila memory aslinya tampil", () => {
    expect(isDuplicateJejakItem(item, [item.jejakId!])).toBe(true);
    expect(isDuplicateJejakItem(item, [])).toBe(false);
  });

  test("duplikat tak muncul di daftar bagian Claude", () => {
    const state: ClaudeMemoryProjectState = {
      project: "/proyek",
      response: {
        project: "proyek",
        dirs: [
          {
            label: "proyek",
            dirExists: true,
            items: [
              item,
              { ...item, file: "lain.md", title: "Catatan lain", jejakId: undefined },
            ],
          },
        ],
      },
      loading: false,
      error: undefined,
    };
    const node = ClaudeMemorySectionView({
      states: [state],
      jejakIds: [item.jejakId!],
    }) as unknown as ComponentChild;
    const baris = byClass(node, "jk-claude-row");
    expect(baris).toHaveLength(1);
    expect(textOf(node)).not.toContain("Gaya kode");
  });
});
