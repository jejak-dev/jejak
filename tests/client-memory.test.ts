import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { createApiClient, type MemoryImportResult, type MemoryItem } from "../src/client/lib/api";
import {
  MEMORY_BODY_MAX,
  MEMORY_TITLE_MAX,
  acceptAriaLabel,
  acceptLabel,
  canAccept,
  canArchive,
  canEdit,
  canReject,
  confidenceLabel,
  filterByLayer,
  groupSkipped,
  importSummary,
  isRevision,
  layerLabel,
  memoryDateLabel,
  originLabel,
  projectLabel,
  revisionBodyChanged,
  revisionTitleChanged,
  skippedReasonLabel,
  staleLabel,
  statusLabel,
  validateDraft,
} from "../src/client/lib/memory";
import { MemoryRowView } from "../src/client/components/MemoryRow";
import type { ConfirmDialogBindings } from "../src/client/components/ConfirmDialog";
import type { MemoryRowProps } from "../src/client/components/MemoryRow";

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

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = (vnode.props as Record<string, unknown>).class;
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function buttonByLabel(node: ComponentChild, label: string): VNode | undefined {
  return findNodes(node, (vnode) => {
    if (vnode.type !== "button") return false;
    const props = propsOf(vnode);
    return props["aria-label"] === label || textOf(props.children as ComponentChild) === label;
  })[0];
}

const NOOP = (): void => {};

/** Fetch palsu yang selalu membalas JSON. */
function fakeJsonFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** Binding modal konfirmasi tanpa DOM; dipakai uji render. */
const DIALOG: ConfirmDialogBindings = {
  cardRef: { current: null },
  confirmRef: { current: null },
  cancelRef: { current: null },
  onKeyDown: NOOP,
  onOverlayPointerDown: NOOP,
  onOverlayWheel: NOOP,
};

/** Baris memory dengan props default; dipakai uji render. */
function renderRow(item: MemoryItem, overrides: Partial<MemoryRowProps> = {}): ComponentChild {
  return MemoryRowView({
    item,
    projects: [],
    open: true,
    editing: false,
    confirmingReject: false,
    confirmingDelete: false,
    busy: false,
    dialog: DIALOG,
    onToggleOpen: NOOP,
    onSubmitEdit: NOOP,
    onCancelEdit: NOOP,
    onAskReject: NOOP,
    onAskDelete: NOOP,
    onCancelConfirm: NOOP,
    onConfirmReject: NOOP,
    onConfirmDelete: NOOP,
    onArchive: NOOP,
    onAccept: NOOP,
    onStartEdit: NOOP,
    ...overrides,
  }) as unknown as ComponentChild;
}

function make(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "0f0e0d0c-0b0a-4f0e-8d0c-0b0a09080706",
    layer: "profile",
    projectKey: null,
    title: "Judul",
    body: "Isi",
    status: "active",
    confidence: "confirmed",
    origin: { kind: "manual", at: "2026-11-08T10:00:00.000Z" },
    staleReason: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    updatedAt: "2026-11-08T10:00:00.000Z",
    decidedAt: null,
    replaces: null,
    revises: null,
    ...overrides,
  };
}

describe("layerLabel", () => {
  test("label Bahasa Indonesia", () => {
    expect(layerLabel("profile")).toBe("Profil");
    expect(layerLabel("project")).toBe("Proyek");
  });
});

describe("statusLabel", () => {
  test("label tiap status", () => {
    expect(statusLabel("proposed")).toBe("Usulan");
    expect(statusLabel("active")).toBe("Aktif");
    expect(statusLabel("rejected")).toBe("Ditolak");
    expect(statusLabel("archived")).toBe("Diarsipkan");
  });
});

describe("confidenceLabel", () => {
  test("label tiap tingkat kepercayaan", () => {
    expect(confidenceLabel("confirmed")).toBe("Dikonfirmasi");
    expect(confidenceLabel("from_code")).toBe("Dari kode");
    expect(confidenceLabel("inferred")).toBe("Kesimpulan agent");
  });
});

describe("originLabel", () => {
  test("manual menyertakan tanggal id-ID", () => {
    expect(originLabel({ kind: "manual", at: "2026-11-08T10:00:00.000Z" })).toBe(
      "Ditulis manual · 8 Nov 2026",
    );
  });

  test("manual dengan tanggal rusak tanpa bagian tanggal", () => {
    expect(originLabel({ kind: "manual", at: "bukan tanggal" })).toBe("Ditulis manual");
  });

  test("sesi dan berkas", () => {
    expect(originLabel({ kind: "session", at: "2026-11-08T10:00:00.000Z" })).toBe("Dari sesi");
    expect(
      originLabel({
        kind: "file",
        at: "2026-11-08T10:00:00.000Z",
        file: "src/x.ts",
        fileSha256: "a".repeat(64),
      }),
    ).toBe("Dari berkas src/x.ts");
  });

  test("file tanpa nama berkas jatuh ke label sesi", () => {
    expect(originLabel({ kind: "file", at: "2026-11-08T10:00:00.000Z" })).toBe("Dari sesi");
  });
});

describe("projectLabel", () => {
  test("nama folder terakhir dan null", () => {
    expect(projectLabel("/Users/boy/Developer/jejak")).toBe("jejak");
    expect(projectLabel(null)).toBe("Semua proyek");
    expect(projectLabel("")).toBe("Semua proyek");
  });
});

describe("memoryDateLabel", () => {
  test("tanggal id-ID dan tanggal rusak", () => {
    expect(memoryDateLabel("2026-11-08T10:00:00.000Z")).toBe("8 Nov 2026");
    expect(memoryDateLabel("bukan tanggal")).toBe("");
  });
});

describe("staleLabel", () => {
  test("null/kosong tidak menandai, alasan lain diberi awalan", () => {
    expect(staleLabel(null)).toBeUndefined();
    expect(staleLabel("")).toBeUndefined();
    expect(staleLabel("berkas asal berubah")).toBe("Mungkin basi: berkas asal berubah");
  });
});

describe("canX per status", () => {
  test("usulan: terima, ubah, tolak; bukan arsip", () => {
    expect(canAccept("proposed")).toBe(true);
    expect(canReject("proposed")).toBe(true);
    expect(canEdit("proposed")).toBe(true);
    expect(canArchive("proposed")).toBe(false);
  });

  test("aktif: ubah dan arsip; bukan terima/tolak", () => {
    expect(canAccept("active")).toBe(false);
    expect(canReject("active")).toBe(false);
    expect(canEdit("active")).toBe(true);
    expect(canArchive("active")).toBe(true);
  });

  test("ditolak dan diarsipkan: tidak ada aksi", () => {
    for (const status of ["rejected", "archived"] as const) {
      expect(canAccept(status)).toBe(false);
      expect(canReject(status)).toBe(false);
      expect(canEdit(status)).toBe(false);
      expect(canArchive(status)).toBe(false);
    }
  });
});

describe("validateDraft", () => {
  const base = { layer: "profile" as const, projectKey: "", title: "Judul", body: "Isi" };

  test("draf valid tidak menghasilkan galat", () => {
    expect(validateDraft(base)).toBeUndefined();
    expect(validateDraft({ ...base, layer: "project", projectKey: "/tmp/x" })).toBeUndefined();
  });

  test("judul kosong dan melewati batas", () => {
    expect(validateDraft({ ...base, title: "   " })).toBe(
      `Judul harus 1-${MEMORY_TITLE_MAX} karakter.`,
    );
    expect(validateDraft({ ...base, title: "a".repeat(MEMORY_TITLE_MAX) })).toBeUndefined();
    expect(validateDraft({ ...base, title: "a".repeat(MEMORY_TITLE_MAX + 1) })).toBe(
      `Judul harus 1-${MEMORY_TITLE_MAX} karakter.`,
    );
  });

  test("isi kosong dan melewati batas", () => {
    expect(validateDraft({ ...base, body: "  " })).toBe(
      `Isi harus 1-${MEMORY_BODY_MAX} karakter.`,
    );
    expect(validateDraft({ ...base, body: "a".repeat(MEMORY_BODY_MAX) })).toBeUndefined();
    expect(validateDraft({ ...base, body: "a".repeat(MEMORY_BODY_MAX + 1) })).toBe(
      `Isi harus 1-${MEMORY_BODY_MAX} karakter.`,
    );
  });

  test("lapis proyek wajib punya folder", () => {
    expect(validateDraft({ ...base, layer: "project", projectKey: "  " })).toBe(
      "Pilih folder proyek untuk memory lapis proyek.",
    );
  });
});

describe("filterByLayer", () => {
  const items = [
    make({ id: "a", layer: "profile" }),
    make({ id: "b", layer: "project", projectKey: "/tmp/x" }),
    make({ id: "c", layer: "profile" }),
  ];

  test("semua mengembalikan salinan penuh", () => {
    const result = filterByLayer(items, "semua");
    expect(result.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(result).not.toBe(items);
  });

  test("menyaring per lapis", () => {
    expect(filterByLayer(items, "profile").map((item) => item.id)).toEqual(["a", "c"]);
    expect(filterByLayer(items, "project").map((item) => item.id)).toEqual(["b"]);
  });

  test("daftar kosong", () => {
    expect(filterByLayer([], "profile")).toEqual([]);
  });
});

describe("skippedReasonLabel", () => {
  test("label tiap alasan", () => {
    expect(skippedReasonLabel("sudah-ada")).toBe("Sudah ada");
    expect(skippedReasonLabel("rahasia")).toBe("Memuat rahasia");
    expect(skippedReasonLabel("terlalu-panjang")).toBe("Terlalu panjang");
    expect(skippedReasonLabel("kosong")).toBe("Kosong");
    expect(skippedReasonLabel("batas")).toBe("Batas usulan tercapai");
  });
});

describe("groupSkipped", () => {
  test("menghitung per alasan tanpa alasan kosong, urut tetap", () => {
    const groups = groupSkipped([
      { file: "AGENTS.md", title: "A", reason: "sudah-ada" },
      { file: "AGENTS.md", title: "B", reason: "rahasia" },
      { file: "CLAUDE.md", title: "C", reason: "sudah-ada" },
      { file: "CLAUDE.md", title: "D", reason: "sudah-ada" },
    ]);

    expect(groups).toEqual([
      { reason: "sudah-ada", label: "Sudah ada", count: 3 },
      { reason: "rahasia", label: "Memuat rahasia", count: 1 },
    ]);
  });

  test("tanpa bagian yang dilewati menghasilkan daftar kosong", () => {
    expect(groupSkipped([])).toEqual([]);
  });
});

describe("importSummary", () => {
  const created = make({ title: "Baru" }) as MemoryImportResult["created"][number];

  function result(overrides: Partial<MemoryImportResult> = {}): MemoryImportResult {
    return {
      created: [],
      skipped: [],
      files: [
        { file: "AGENTS.md", found: true },
        { file: "CLAUDE.md", found: false },
      ],
      ...overrides,
    };
  }

  test("usulan baru menyebut berkas yang ditemukan", () => {
    expect(importSummary(result({ created: [created] }))).toBe(
      "1 usulan baru dari AGENTS.md.",
    );
  });

  test("beberapa berkas ditemukan disebut dengan dan", () => {
    expect(
      importSummary(
        result({
          created: [created],
          files: [
            { file: "AGENTS.md", found: true },
            { file: "CLAUDE.md", found: true },
          ],
        }),
      ),
    ).toBe("1 usulan baru dari AGENTS.md dan CLAUDE.md.");
  });

  test("semua sudah ada (0 baru)", () => {
    expect(
      importSummary(
        result({
          skipped: [
            { file: "AGENTS.md", title: "A", reason: "sudah-ada" },
            { file: "AGENTS.md", title: "B", reason: "sudah-ada" },
          ],
        }),
      ),
    ).toBe("Tidak ada usulan baru (2 sudah ada).");
  });

  test("hanya skipped karena alasan lain", () => {
    expect(
      importSummary(
        result({ skipped: [{ file: "AGENTS.md", title: "A", reason: "rahasia" }] }),
      ),
    ).toBe("Tidak ada usulan baru (1 dilewati).");
  });

  test("berkas tidak ditemukan", () => {
    expect(
      importSummary(
        result({
          files: [
            { file: "AGENTS.md", found: false },
            { file: "CLAUDE.md", found: false },
          ],
        }),
      ),
    ).toBe("AGENTS.md dan CLAUDE.md tidak ditemukan di folder ini.");
  });

  test("berkas ada tanpa bagian sama sekali", () => {
    expect(importSummary(result())).toBe("Tidak ada bagian baru di AGENTS.md.");
  });

  test("jumlah tidak diubah bentuknya (tanpa pluralisasi)", () => {
    const many = Array.from({ length: 4 }, () => created);
    expect(importSummary(result({ created: many }))).toBe(
      "4 usulan baru dari AGENTS.md.",
    );
  });
});

/* ---------- Revisi memory ---------- */

describe("isRevision", () => {
  test("memory biasa bukan revisi", () => {
    expect(isRevision(make())).toBe(false);
    expect(isRevision(make({ replaces: null }))).toBe(false);
  });

  test("replaces terisi berarti usulan revisi", () => {
    expect(isRevision(make({ replaces: "abc" }))).toBe(true);
    expect(isRevision(make({ replaces: "" }))).toBe(false);
  });

  test("revises terisi tanpa replaces tetap dianggap revisi", () => {
    expect(
      isRevision(make({ revises: { id: "abc", title: "Lama", body: "Isi lama" } })),
    ).toBe(true);
  });
});

describe("acceptLabel", () => {
  test("usulan biasa memakai Terima, revisi memakai Terapkan revisi", () => {
    expect(acceptLabel(make())).toBe("Terima");
    expect(acceptLabel(make({ replaces: "abc" }))).toBe("Terapkan revisi");
  });

  test("label aksesibel mengikuti jenisnya", () => {
    expect(acceptAriaLabel(make({ title: "Judul" }))).toBe("Terima usulan Judul");
    expect(acceptAriaLabel(make({ title: "Judul", replaces: "abc" }))).toBe(
      "Terapkan revisi Judul",
    );
  });
});

describe("penanda perubahan revisi", () => {
  const target = { id: "abc", title: "Judul lama", body: "Isi lama" };

  test("judul dan isi dibandingkan dengan target", () => {
    expect(revisionTitleChanged({ title: "Judul lama" }, target)).toBe(false);
    expect(revisionTitleChanged({ title: "Judul baru" }, target)).toBe(true);
    expect(revisionBodyChanged({ body: "Isi lama" }, target)).toBe(false);
    expect(revisionBodyChanged({ body: "Isi baru" }, target)).toBe(true);
  });

  test("tanpa target tidak ada perubahan yang ditandai", () => {
    expect(revisionTitleChanged({ title: "Judul baru" }, null)).toBe(false);
    expect(revisionBodyChanged({ body: "Isi baru" }, null)).toBe(false);
  });
});

describe("tampilan revisi di baris memory", () => {
  const target = { id: "abc", title: "Judul lama", body: "Isi lama" };

  test("usulan revisi memakai lencana Revisi", () => {
    const node = renderRow(make({ status: "proposed", replaces: "abc", revises: target }));
    const badge = byClass(node, "jk-memory-flag-revisi")[0];
    expect(badge).toBeDefined();
    expect(textOf(propsOf(badge).children as ComponentChild)).toBe("Revisi");
  });

  test("memory biasa tanpa lencana revisi", () => {
    const node = renderRow(make({ status: "proposed" }));
    expect(byClass(node, "jk-memory-flag-revisi").length).toBe(0);
  });

  test("tombol terima untuk revisi memakai Terapkan revisi", () => {
    const node = renderRow(make({ status: "proposed", replaces: "abc", revises: target }));
    const button = buttonByLabel(node, "Terapkan revisi");
    expect(button).toBeDefined();
    expect(textOf(propsOf(button).children as ComponentChild)).toBe("Terapkan revisi");
    expect(propsOf(button)["aria-label"]).toBe("Terapkan revisi Judul");
  });

  test("blok sebelum dan sesudah menampilkan isi target dan usulan", () => {
    const node = renderRow(
      make({
        status: "proposed",
        title: "Judul baru",
        body: "Isi baru",
        replaces: "abc",
        revises: target,
      }),
    );

    const labels = byClass(node, "jk-memory-revision-label").map((vnode) =>
      textOf(propsOf(vnode).children as ComponentChild),
    );
    expect(labels).toEqual(["Sebelum", "Sesudah"]);

    const bodies = byClass(node, "jk-memory-revision-body").map((vnode) =>
      textOf(propsOf(vnode).children as ComponentChild),
    );
    expect(bodies).toEqual(["Isi lama", "Isi baru"]);

    const titles = byClass(node, "jk-memory-revision-title").map((vnode) =>
      textOf(propsOf(vnode).children as ComponentChild),
    );
    expect(titles[0]).toContain("Judul lama");
    expect(titles[1]).toContain("Judul baru");

    // Judul yang berubah diberi tanda.
    const marks = byClass(node, "jk-memory-revision-mark").map((vnode) =>
      textOf(propsOf(vnode).children as ComponentChild),
    );
    expect(marks).toContain("berubah");
  });

  test("target hilang: pesan target tidak ada dan tombol dinonaktifkan", () => {
    const node = renderRow(make({ status: "proposed", replaces: "abc", revises: null }));
    expect(textOf(node)).toContain("Memory yang direvisi sudah tidak ada. Tolak usulan ini.");
    expect(byClass(node, "jk-memory-revision").length).toBe(0);

    const button = buttonByLabel(node, "Terapkan revisi");
    expect(button).toBeDefined();
    expect(propsOf(button).disabled).toBe(true);
  });
});

describe("konfirmasi memory memakai modal", () => {
  function modalOf(node: ComponentChild): VNode | undefined {
    return findNodes(node, (vnode) => propsOf(vnode)["role"] === "alertdialog")[0];
  }

  function buttonIn(modal: VNode | undefined, label: string): VNode | undefined {
    if (modal === undefined) return undefined;
    return findNodes(modal, (vnode) => vnode.type === "button").find(
      (vnode) => textOf(propsOf(vnode).children as ComponentChild) === label,
    );
  }

  test("tolak usulan membuka modal dengan tombol Tolak", () => {
    const node = renderRow(make({ status: "proposed" }), { confirmingReject: true });
    expect(byClass(node, "jk-panel-confirm").length).toBe(0);

    const modal = modalOf(node);
    expect(modal).toBeDefined();
    expect(textOf(modal as ComponentChild)).toContain("Tolak usulan?");
    expect(textOf(modal as ComponentChild)).toContain("Usulan hilang dari daftar usulan.");
    expect(buttonIn(modal, "Tolak")).toBeDefined();
    expect(buttonIn(modal, "Batal")).toBeDefined();
  });

  test("hapus memory membuka modal dengan tombol Hapus", () => {
    const node = renderRow(make({ status: "active" }), { confirmingDelete: true });
    expect(byClass(node, "jk-panel-confirm").length).toBe(0);

    const modal = modalOf(node);
    expect(modal).toBeDefined();
    expect(textOf(modal as ComponentChild)).toContain("Hapus memory?");
    expect(textOf(modal as ComponentChild)).toContain("Hapus permanen? Tidak bisa diurungkan.");
    expect(buttonIn(modal, "Hapus")).toBeDefined();
  });

  test("tanpa permintaan konfirmasi tidak ada modal", () => {
    const node = renderRow(make({ status: "active" }));
    expect(modalOf(node)).toBeUndefined();
  });
});

describe("normalisasi respons memory", () => {
  test("field revisi yang tidak ada menjadi null", async () => {
    const item = {
      id: "m1",
      layer: "profile",
      projectKey: null,
      title: "Judul",
      body: "Isi",
      status: "proposed",
      confidence: "inferred",
      origin: { kind: "session", at: "2026-11-08T10:00:00.000Z" },
      staleReason: null,
      createdAt: "2026-11-08T10:00:00.000Z",
      updatedAt: "2026-11-08T10:00:00.000Z",
      decidedAt: null,
    };
    const api = createApiClient({
      fetch: fakeJsonFetch({
        items: [item],
        counts: { proposed: 1, active: 0 },
        problems: [],
      }),
    });

    const result = await api.listMemory({ status: "proposed" });
    expect(result.items[0]?.replaces).toBeNull();
    expect(result.items[0]?.revises).toBeNull();
  });

  test("target revisi diteruskan apa adanya", async () => {
    const api = createApiClient({
      fetch: fakeJsonFetch({
        items: [
          {
            ...make({ status: "proposed", replaces: "abc" }),
            revises: { id: "abc", title: "Judul lama", body: "Isi lama" },
          },
        ],
        counts: { proposed: 1, active: 0 },
        problems: [],
      }),
    });

    const result = await api.listMemory({ status: "proposed" });
    expect(result.items[0]?.revises).toEqual({
      id: "abc",
      title: "Judul lama",
      body: "Isi lama",
    });
  });
});
