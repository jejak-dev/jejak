import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { createApiClient, type MemoryItem } from "../src/client/lib/api";
import {
  SESSION_SUMMARY_PREFIX,
  canConsolidate,
  consolidateHint,
  sessionSummaryCounts,
} from "../src/client/lib/memory";
import {
  MemoryConsolidateView,
  type MemoryConsolidateViewProps,
} from "../src/client/components/MemoryConsolidate";
import type { ConfirmDialogBindings } from "../src/client/components/ConfirmDialog";

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

function buttons(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => vnode.type === "button");
}

function buttonByText(node: ComponentChild, label: string): VNode | undefined {
  return buttons(node).find(
    (vnode) => textOf(propsOf(vnode).children as ComponentChild) === label,
  );
}

const NOOP = (): void => {};

const DIALOG: ConfirmDialogBindings = {
  cardRef: { current: null },
  confirmRef: { current: null },
  cancelRef: { current: null },
  onKeyDown: NOOP,
  onOverlayPointerDown: NOOP,
  onOverlayWheel: NOOP,
};

function make(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "0f0e0d0c-0b0a-4f0e-8d0c-0b0a09080706",
    layer: "project",
    projectKey: "/proj",
    title: `${SESSION_SUMMARY_PREFIX}Sesi`,
    body: "Isi",
    status: "proposed",
    confidence: "inferred",
    origin: { kind: "session", at: "2026-11-08T10:00:00.000Z" },
    staleReason: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    updatedAt: "2026-11-08T10:00:00.000Z",
    decidedAt: null,
    replaces: null,
    revises: null,
    ...overrides,
  };
}

function render(overrides: Partial<MemoryConsolidateViewProps> = {}): ComponentChild {
  const props: MemoryConsolidateViewProps = {
    projects: [],
    busy: false,
    confirmingProjectKey: undefined,
    onAsk: NOOP,
    onCancel: NOOP,
    onConfirm: NOOP,
    dialog: DIALOG,
    ...overrides,
  };
  return MemoryConsolidateView(props) as unknown as ComponentChild;
}

/* ---------- Hitungan ringkasan sesi ---------- */

describe("sessionSummaryCounts", () => {
  test("menghitung per proyek hanya untuk usulan dan aktif", () => {
    const items = [
      make({ id: "a", projectKey: "/p/a" }),
      make({ id: "b", projectKey: "/p/a" }),
      make({ id: "c", projectKey: "/p/a", status: "active" }),
      make({ id: "d", projectKey: "/p/a", status: "rejected" }),
      make({ id: "e", projectKey: "/p/b", title: "Catatan biasa" }),
    ];
    expect(sessionSummaryCounts(items)).toEqual({ "/p/a": 3 });
  });

  test("daftar kosong menghasilkan hitungan kosong", () => {
    expect(sessionSummaryCounts([])).toEqual({});
  });
});

describe("canConsolidate dan consolidateHint", () => {
  test("butuh minimal dua ringkasan", () => {
    expect(canConsolidate(1)).toBe(false);
    expect(canConsolidate(2)).toBe(true);
  });

  test("saran muncul mulai sepuluh ringkasan", () => {
    expect(consolidateHint(9)).toBeUndefined();
    expect(consolidateHint(10)).toBe(
      "Ada 10 ringkasan sesi; gabungkan agar daftar tetap ringkas.",
    );
  });
});

/* ---------- Panel penggabungan ---------- */

describe("klien api penggabungan", () => {
  test("consolidateMemory POST /api/memory/consolidate dan mengembalikan item serta jumlah sumber", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return new Response(
        JSON.stringify({
          item: {
            id: "m1",
            layer: "project",
            projectKey: "/proj",
            title: "Ringkasan proyek: 2026-11-01 s/d 2026-11-02",
            body: "Isi gabungan",
            status: "proposed",
            confidence: "inferred",
            origin: { kind: "session", at: "2026-11-08T10:00:00.000Z", sessionIds: ["s_1", "s_2"] },
            staleReason: null,
            createdAt: "2026-11-08T10:00:00.000Z",
            updatedAt: "2026-11-08T10:00:00.000Z",
            decidedAt: null,
          },
          sources: 2,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const api = createApiClient({ fetch: impl as typeof fetch });

    const result = await api.consolidateMemory("/proj");
    expect(calls[0]?.url).toBe("/api/memory/consolidate");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ projectKey: "/proj" });
    expect(result.sources).toBe(2);
    expect(result.item.title).toBe("Ringkasan proyek: 2026-11-01 s/d 2026-11-02");
  });
});

describe("panel penggabungan ringkasan sesi", () => {
  test("tombol tak muncul bila proyek punya satu ringkasan", () => {
    const node = render({ projects: [{ projectKey: "/p/a", count: 1 }] });
    expect(buttonByText(node, "Gabungkan ringkasan sesi")).toBeUndefined();
  });

  test("tombol muncul bila proyek punya dua ringkasan", () => {
    const node = render({ projects: [{ projectKey: "/p/a", count: 2 }] });
    const button = buttonByText(node, "Gabungkan ringkasan sesi");
    expect(button).toBeDefined();
  });

  test("klik tombol meminta konfirmasi untuk proyeknya", () => {
    let asked: string | undefined;
    const node = render({
      projects: [{ projectKey: "/p/a", count: 2 }],
      onAsk: (projectKey) => {
        asked = projectKey;
      },
    });
    const button = buttonByText(node, "Gabungkan ringkasan sesi");
    (propsOf(button).onClick as () => void)();
    expect(asked).toBe("/p/a");
  });

  test("saran halus muncul saat ringkasan menumpuk", () => {
    const node = render({ projects: [{ projectKey: "/p/a", count: 12 }] });
    expect(textOf(node)).toContain("Ada 12 ringkasan sesi; gabungkan agar daftar tetap ringkas.");
  });

  test("saran halus tak muncul saat ringkasan masih sedikit", () => {
    const node = render({ projects: [{ projectKey: "/p/a", count: 3 }] });
    expect(textOf(node)).not.toContain("gabungkan agar daftar tetap ringkas");
  });

  test("konfirmasi memakai modal yang sudah dipakai halaman", () => {
    const node = render({
      projects: [{ projectKey: "/p/a", count: 2 }],
      confirmingProjectKey: "/p/a",
    });
    const modal = findNodes(node, (vnode) => propsOf(vnode)["role"] === "alertdialog")[0];
    expect(modal).toBeDefined();
    expect(textOf(modal as ComponentChild)).toContain("Gabungkan ringkasan sesi?");
    expect(buttonByText(modal as ComponentChild, "Gabungkan")).toBeDefined();
    expect(buttonByText(modal as ComponentChild, "Batal")).toBeDefined();
  });

  test("konfirmasi meneruskan proyek yang diminta", () => {
    let confirmed: string | undefined;
    const node = render({
      projects: [{ projectKey: "/p/a", count: 2 }],
      confirmingProjectKey: "/p/a",
      onConfirm: (projectKey) => {
        confirmed = projectKey;
      },
    });
    const modal = findNodes(node, (vnode) => propsOf(vnode)["role"] === "alertdialog")[0];
    const button = buttonByText(modal as ComponentChild, "Gabungkan");
    (propsOf(button).onClick as () => void)();
    expect(confirmed).toBe("/p/a");
  });

  test("tanpa permintaan konfirmasi tak ada modal", () => {
    const node = render({ projects: [{ projectKey: "/p/a", count: 2 }] });
    expect(findNodes(node, (vnode) => propsOf(vnode)["role"] === "alertdialog")).toHaveLength(0);
  });
});
