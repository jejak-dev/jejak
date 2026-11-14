import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { ConfirmDialogView } from "../src/client/components/ConfirmDialog";
import {
  canDismiss,
  confirmButtonClass,
  initialFocusTarget,
  nextFocusIndex,
  type ConfirmTone,
} from "../src/client/lib/confirm-dialog";

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

function byRole(node: ComponentChild, role: string): VNode | undefined {
  return findNodes(node, (vnode) => propsOf(vnode)["role"] === role)[0];
}

function byId(node: ComponentChild, id: string): VNode | undefined {
  return findNodes(node, (vnode) => propsOf(vnode)["id"] === id)[0];
}

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = propsOf(vnode)["class"];
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

function buttons(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => vnode.type === "button");
}

function buttonByText(node: ComponentChild, label: string): VNode | undefined {
  return buttons(node).find((vnode) => textOf(propsOf(vnode).children as ComponentChild) === label);
}

const NOOP = (): void => {};

function render(props: Partial<Parameters<typeof ConfirmDialogView>[0]> = {}): ComponentChild {
  return ConfirmDialogView({
    open: true,
    title: "Hapus provider?",
    message: "Provider X akan dihapus dari daftar.",
    confirmLabel: "Hapus",
    onConfirm: NOOP,
    onCancel: NOOP,
    ...props,
  }) as unknown as ComponentChild;
}

/* ---------- Logika murni ---------- */

describe("initialFocusTarget", () => {
  test("tone danger fokus ke tombol Batal", () => {
    expect(initialFocusTarget("danger")).toBe("cancel");
  });

  test("tone default fokus ke tombol konfirmasi", () => {
    expect(initialFocusTarget("default")).toBe("confirm");
  });
});

describe("nextFocusIndex", () => {
  test("maju satu langkah", () => {
    expect(nextFocusIndex(0, 3, 1)).toBe(1);
  });

  test("mundur satu langkah", () => {
    expect(nextFocusIndex(2, 3, -1)).toBe(1);
  });

  test("berputar di ujung", () => {
    expect(nextFocusIndex(2, 3, 1)).toBe(0);
    expect(nextFocusIndex(0, 3, -1)).toBe(2);
  });

  test("indeks di luar rentang dilipat ke rentang", () => {
    expect(nextFocusIndex(-1, 3, 1)).toBe(0);
    expect(nextFocusIndex(5, 3, 1)).toBe(0);
  });

  test("daftar kosong menghasilkan indeks 0", () => {
    expect(nextFocusIndex(0, 0, 1)).toBe(0);
  });
});

describe("canDismiss", () => {
  test("boleh ditutup saat tidak sibuk", () => {
    expect(canDismiss(false)).toBe(true);
  });

  test("tidak boleh ditutup saat sibuk", () => {
    expect(canDismiss(true)).toBe(false);
  });
});

describe("confirmButtonClass", () => {
  test("tone danger memakai gaya caution", () => {
    expect(confirmButtonClass("danger")).toContain("jk-button-caution");
  });

  test("tone default memakai gaya primary", () => {
    expect(confirmButtonClass("default")).toContain("jk-button-primary");
  });
});

/* ---------- Render modal ---------- */

describe("ConfirmDialogView", () => {
  test("tertutup tidak menggambar apa pun", () => {
    const node = render({ open: false });
    expect(node).toBeNull();
  });

  test("terbuka menggambar kartu alertdialog dengan aria", () => {
    const node = render();
    const card = byRole(node, "alertdialog");
    expect(card).toBeDefined();
    expect(propsOf(card)["aria-modal"]).toBe("true");

    const titleId = String(propsOf(card)["aria-labelledby"]);
    expect(titleId).not.toBe("");
    expect(textOf(byId(node, titleId) as ComponentChild)).toContain("Hapus provider?");

    const messageId = String(propsOf(card)["aria-describedby"]);
    expect(textOf(byId(node, messageId) as ComponentChild)).toContain(
      "Provider X akan dihapus dari daftar.",
    );
  });

  test("label tombol memakai bahasa Indonesia", () => {
    const node = render();
    expect(buttonByText(node, "Hapus")).toBeDefined();
    expect(buttonByText(node, "Batal")).toBeDefined();
  });

  test("label tombol batal dapat diganti", () => {
    const node = render({ cancelLabel: "Batal hapus" });
    expect(buttonByText(node, "Batal hapus")).toBeDefined();
    expect(buttonByText(node, "Batal")).toBeUndefined();
  });

  test("tone menentukan gaya tombol konfirmasi", () => {
    const danger = render({ tone: "danger" as ConfirmTone });
    expect(byClass(danger, "jk-button-caution")).toHaveLength(1);
    expect(byClass(danger, "jk-confirm-card-danger")).toHaveLength(1);

    const plain = render({ tone: "default" });
    expect(byClass(plain, "jk-button-primary")).toHaveLength(1);
  });

  test("saat busy tombol nonaktif dan memakai busyLabel", () => {
    const node = render({ busy: true, busyLabel: "Menghapus…" });
    const confirm = buttonByText(node, "Menghapus…");
    expect(confirm).toBeDefined();
    expect(propsOf(confirm)["disabled"]).toBe(true);
    expect(propsOf(confirm)["aria-busy"]).toBe("true");
    expect(buttonByText(node, "Hapus")).toBeUndefined();

    for (const button of buttons(node)) {
      expect(propsOf(button)["disabled"]).toBe(true);
    }
  });

  test("galat ditampilkan sebagai alert di dalam kartu", () => {
    const node = render({ error: "Gagal menghapus." });
    const alert = byRole(node, "alert");
    expect(alert).toBeDefined();
    expect(textOf(alert as ComponentChild)).toContain("Gagal menghapus.");
    expect(byRole(node, "alertdialog")).toBeDefined();
  });

  test("tanpa pesan, kartu tidak menunjuk deskripsi", () => {
    const node = render({ message: undefined });
    const card = byRole(node, "alertdialog");
    expect(propsOf(card)["aria-describedby"]).toBeUndefined();
  });

  test("label aksesibilitas tombol mengikuti prop khusus", () => {
    const node = render({
      confirmAriaLabel: "Konfirmasi tolak hunk 1 di a.ts",
      cancelAriaLabel: "Batal menolak hunk 1 di a.ts",
    });
    expect(propsOf(buttonByText(node, "Hapus"))["aria-label"]).toBe(
      "Konfirmasi tolak hunk 1 di a.ts",
    );
    expect(propsOf(buttonByText(node, "Batal"))["aria-label"]).toBe(
      "Batal menolak hunk 1 di a.ts",
    );
  });

  test("tanpa label khusus tombol tidak memakai aria-label", () => {
    const node = render();
    expect(propsOf(buttonByText(node, "Hapus"))["aria-label"]).toBeUndefined();
    expect(propsOf(buttonByText(node, "Batal"))["aria-label"]).toBeUndefined();
  });
});
