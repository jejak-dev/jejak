import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import {
  DetailDialogView,
  type DetailDialogViewProps,
} from "../src/client/components/DetailDialog";
import type { ConfirmDialogBindings } from "../src/client/components/ConfirmDialog";

const NOOP = (): void => {};

const BINDINGS: ConfirmDialogBindings = {
  cardRef: { current: null },
  confirmRef: { current: null },
  cancelRef: { current: null },
  onKeyDown: NOOP,
  onOverlayPointerDown: NOOP,
  onOverlayWheel: NOOP,
};

function render(overrides: Partial<DetailDialogViewProps> = {}): VNode | null {
  return DetailDialogView({
    open: true,
    title: "Judul memory",
    onClose: NOOP,
    bindings: BINDINGS,
    children: "Isi detail",
    ...overrides,
  }) as VNode | null;
}

function find(node: ComponentChild, predicate: (vnode: VNode) => boolean): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => find(child, predicate));
  const vnode = node as VNode;
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(find(vnode.props.children as ComponentChild, predicate));
}

const props = (vnode: VNode | undefined): Record<string, unknown> =>
  (vnode?.props ?? {}) as Record<string, unknown>;

describe("DetailDialogView", () => {
  test("tak merender apa pun saat tertutup", () => {
    expect(render({ open: false })).toBeNull();
  });

  test("kartu dialog modal berlabel judul dan memuat isi", () => {
    const root = render();
    const kartu = find(root, (v) => props(v)["role"] === "dialog")[0];
    expect(props(kartu)["aria-modal"]).toBe("true");
    const judul = find(root, (v) => v.type === "h2")[0];
    expect(props(kartu)["aria-labelledby"]).toBe(props(judul)["id"]);
    expect(props(judul)["children"]).toBe("Judul memory");
    const isi = find(root, (v) => props(v)["class"] === "jk-detail-body")[0];
    expect(props(isi)["children"]).toBe("Isi detail");
  });

  test("tombol Tutup memanggil onClose", () => {
    let dipanggil = 0;
    const root = render({ onClose: () => dipanggil++ });
    const tutup = find(root, (v) => props(v)["aria-label"] === "Tutup")[0];
    (props(tutup)["onClick"] as () => void)();
    expect(dipanggil).toBe(1);
  });

  test("ditangguhkan: Escape dan klik latar tak dipasang", () => {
    const root = render({ suspended: true });
    const kartu = find(root, (v) => props(v)["role"] === "dialog")[0];
    expect(props(kartu)["onKeyDown"]).toBeUndefined();
    expect(props(root ?? undefined)["onPointerDown"]).toBeUndefined();
  });
});
