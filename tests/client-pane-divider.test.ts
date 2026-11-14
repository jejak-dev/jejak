import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { PaneDividerView } from "../src/client/components/PaneDivider";
import {
  MIN_SIZE,
  draggedSizeAbove,
  evenBoundary,
  resizeBoundary,
  resizeBoundaryByKey,
  type PaneLayout,
} from "../src/client/lib/pane-layout";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
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

function byRole(node: ComponentChild, role: string): VNode[] {
  return findNodes(node, (vnode) => propsOf(vnode)["role"] === role);
}

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = propsOf(vnode)["class"];
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

function render(options: { index?: number; sizeAbove?: number; dragging?: boolean } = {}): VNode {
  return PaneDividerView({
    index: options.index ?? 0,
    sizeAbove: options.sizeAbove ?? 0.5,
    dragging: options.dragging ?? false,
  }) as unknown as VNode;
}

/* ---------- Logika murni pembatas ---------- */

const DUA: PaneLayout = {
  panes: [
    { id: "p1", tabs: ["changes"], active: "changes" },
    { id: "p2", tabs: ["git"], active: "git" },
  ],
  sizes: [0.6, 0.4],
};

describe("pembatas jendela: seret pointer", () => {
  test("perpindahan piksel dibagi tinggi tumpukan menjadi pecahan", () => {
    expect(draggedSizeAbove(0.5, 60, 600)).toBeCloseTo(0.6, 10);
    expect(draggedSizeAbove(0.5, -60, 600)).toBeCloseTo(0.4, 10);
  });

  test("tinggi tumpukan tidak sah mengabaikan geseran", () => {
    expect(draggedSizeAbove(0.5, 60, 0)).toBe(0.5);
    expect(draggedSizeAbove(0.5, 60, Number.NaN)).toBe(0.5);
  });

  test("pecahan hasil seret diterapkan ke tata letak", () => {
    const awal: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
      ],
      sizes: [0.5, 0.5],
    };
    const geser = draggedSizeAbove(0.5, 60, 600);
    const hasil = resizeBoundary(awal, 0, geser - 0.5);
    expect(hasil.sizes[0]).toBeCloseTo(0.6, 10);
    expect(hasil.sizes[1]).toBeCloseTo(0.4, 10);
  });

  test("seret tidak melanggar ukuran minimum", () => {
    const hasil = resizeBoundary(DUA, 0, -5);
    expect(hasil.sizes[0]).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(hasil.sizes[1]).toBeGreaterThanOrEqual(MIN_SIZE);
  });
});

describe("pembatas jendela: tombol keyboard", () => {
  test("panah menggeser pembatas", () => {
    const bawah = resizeBoundaryByKey(DUA, 0, "ArrowDown");
    expect(bawah?.sizes[0]).toBeCloseTo(0.65, 10);
    const atas = resizeBoundaryByKey(DUA, 0, "ArrowUp");
    expect(atas?.sizes[0]).toBeCloseTo(0.55, 10);
  });

  test("Home dan End menjepit pembatas ke batas", () => {
    const home = resizeBoundaryByKey(DUA, 0, "Home");
    expect(home?.sizes[0]).toBeCloseTo(MIN_SIZE, 10);
    const end = resizeBoundaryByKey(DUA, 0, "End");
    expect(end?.sizes[1]).toBeCloseTo(MIN_SIZE, 10);
  });

  test("kunci lain tidak dikenal mengembalikan undefined", () => {
    expect(resizeBoundaryByKey(DUA, 0, "Enter")).toBeUndefined();
    expect(resizeBoundaryByKey(DUA, 0, "a")).toBeUndefined();
  });
});

describe("pembatas jendela: klik dua kali", () => {
  test("dua tetangga dibagi rata", () => {
    const hasil = evenBoundary(DUA, 0);
    expect(hasil.sizes[0]).toBeCloseTo(0.5, 10);
    expect(hasil.sizes[1]).toBeCloseTo(0.5, 10);
  });

  test("indeks di luar rentang tidak mengubah apa pun", () => {
    expect(evenBoundary(DUA, 3).sizes).toEqual(DUA.sizes);
    expect(evenBoundary(DUA, -1).sizes).toEqual(DUA.sizes);
  });
});

/* ---------- ARIA pembatas ---------- */

describe("pembatas jendela: ARIA", () => {
  test("pembatas memakai peran pemisah horizontal", () => {
    const node = render();
    const pemisah = byRole(node, "separator");
    expect(pemisah).toHaveLength(1);
    expect(propsOf(pemisah[0])["aria-orientation"]).toBe("horizontal");
    expect(propsOf(pemisah[0])["aria-label"]).toBe("Ukuran jendela");
    expect(propsOf(pemisah[0])["tabIndex"]).toBe(0);
  });

  test("nilai aria adalah persen tinggi jendela di atasnya", () => {
    expect(propsOf(byRole(render({ sizeAbove: 0.5 }), "separator")[0])["aria-valuenow"]).toBe(50);
    expect(propsOf(byRole(render({ sizeAbove: 0.35 }), "separator")[0])["aria-valuenow"]).toBe(35);
    expect(propsOf(byRole(render({ sizeAbove: 1 }), "separator")[0])["aria-valuenow"]).toBe(100);
  });

  test("tanda aktif muncul saat menyeret", () => {
    expect(byClass(render({ dragging: false }), "jk-pane-divider-active")).toHaveLength(0);
    expect(byClass(render({ dragging: true }), "jk-pane-divider-active")).toHaveLength(1);
  });
});
