import { describe, expect, test } from "bun:test";
import { h, type ComponentChild, type VNode } from "preact";
import {
  AccessSettingsView,
  accessNetworkSlot,
} from "../src/client/components/AccessSettings";
import { NetworkSettings } from "../src/client/components/NetworkSettings";
import type { ApiClient } from "../src/client/lib/api";

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
    const value = propsOf(vnode)["class"];
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

function buttons(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => vnode.type === "button");
}

function buttonTexts(node: ComponentChild): string[] {
  return buttons(node).map((vnode) => textOf(vnode.props.children as ComponentChild));
}

const NOOP = (): void => {};

function render(
  props: Partial<Parameters<typeof AccessSettingsView>[0]> = {},
): ComponentChild {
  return AccessSettingsView({
    status: { configured: false },
    loading: false,
    error: undefined,
    notice: undefined,
    current: "",
    password: "",
    repeat: "",
    deletePassword: "",
    busy: false,
    confirmOpen: false,
    dialogError: undefined,
    onCurrent: NOOP,
    onPassword: NOOP,
    onRepeat: NOOP,
    onDeletePassword: NOOP,
    onSubmit: NOOP,
    onRequestDelete: NOOP,
    onConfirmDelete: NOOP,
    onCancelDelete: NOOP,
    ...props,
  }) as unknown as ComponentChild;
}

describe("kartu Akses & sandi", () => {
  test("judul, catatan, dan pesan STATUS tampil", () => {
    const teks = textOf(render());
    expect(teks).toContain("Akses & sandi");
    expect(teks).toContain(
      "Sandi dipakai untuk masuk dari peramban atau perangkat lain. Aplikasi desktop ini tetap masuk otomatis.",
    );
    expect(teks).toContain("Belum ada sandi");
  });

  test("catatan jaringan digantikan bagian akses jaringan", () => {
    const tanpaSlot = textOf(render());
    expect(tanpaSlot).not.toContain("Akses dari jaringan belum diaktifkan.");
    const denganSlot = textOf(render({ network: h("p", null, "Bagian jaringan") }));
    expect(denganSlot).toContain("Bagian jaringan");
    expect(denganSlot).not.toContain("Akses dari jaringan belum diaktifkan.");
  });

  test("status menyandi tanggal saat sandi sudah ada", () => {
    const teks = textOf(
      render({ status: { configured: true, updatedAt: "2026-11-16T08:00:00.000Z" } }),
    );
    expect(teks).toContain("Sandi aktif sejak");
  });

  test("belum ada sandi: tombol buat dan kolom sandi lama disembunyikan", () => {
    const pohon = render();
    const label = textOf(pohon);
    expect(label).toContain("Buat sandi");
    expect(label).not.toContain("Hapus sandi");
    expect(label).not.toContain("Sandi lama");
    // Kolom sandi baru dan ulangan tetap ada.
    expect(label).toContain("Ulangi sandi");
  });

  test("sandi sudah ada: kolom sandi lama dan tombol hapus tampil", () => {
    const label = textOf(render({ status: { configured: true, updatedAt: "2026-11-16T08:00:00.000Z" } }));
    expect(label).toContain("Sandi lama");
    expect(label).toContain("Ganti sandi");
    expect(label).toContain("Hapus sandi");
  });

  test("galat dan kabar berhasil ditampilkan", () => {
    const galat = textOf(render({ error: "Sandi lama salah." }));
    expect(galat).toContain("Sandi lama salah.");
    const kabar = textOf(render({ notice: "Sandi dibuat." }));
    expect(kabar).toContain("Sandi dibuat.");
  });

  test("modal hapus sandi menampilkan kolom sandi lama", () => {
    const modal = byClass(render({ confirmOpen: true }), "jk-confirm-card");
    expect(modal.length).toBe(1);
    const teks = textOf(modal[0]?.props.children as ComponentChild);
    expect(teks).toContain("Hapus sandi?");
    expect(teks).toContain("Sandi lama");
  });

  test("modal hapus sandi tersembunyi saat belum dibuka", () => {
    expect(byClass(render(), "jk-confirm-card").length).toBe(0);
  });

  test("kolom sandi memakai type password", () => {
    const inputs = findNodes(render(), (vnode) => vnode.type === "input");
    expect(inputs.length).toBe(2);
    for (const input of inputs) {
      expect(propsOf(input)["type"]).toBe("password");
    }
  });

  test("tombol hapus sandi tidak ada saat sandi belum ada", () => {
    expect(buttonTexts(render())).toEqual(["Buat sandi"]);
    const aktif = buttonTexts(render({ status: { configured: true, updatedAt: "2026-11-16" } }));
    expect(aktif).toEqual(["Ganti sandi", "Hapus sandi"]);
  });

  test("bagian jaringan menerima kunci pemicu muat ulang status", () => {
    const api = {} as ApiClient;
    const slot = accessNetworkSlot(api, 4) as VNode;
    expect(slot.type === NetworkSettings).toBe(true);
    expect(propsOf(slot)["refreshKey"]).toBe(4);
    // Kunci berubah setiap kali status sandi berubah.
    const lain = accessNetworkSlot(api, 5) as VNode;
    expect(propsOf(lain)["refreshKey"]).toBe(5);
  });
});
