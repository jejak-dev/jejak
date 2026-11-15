import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import {
  AppUpdateSettings,
  AppUpdateView,
  type AppUpdateViewProps,
} from "../src/client/components/AppUpdateSettings";
import type { UpdaterStatus } from "../src/client/lib/desktop";
import { isSelectVNode, selectOptions } from "./helpers/select-vnode";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function textOf(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    // `Select` memakai hook, jadi tak bisa dipanggil langsung tanpa DOM.
    if (isSelectVNode(vnode)) return "";
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
    // `Select` memakai hook, jadi tak bisa dipanggil langsung tanpa DOM.
    if (isSelectVNode(vnode)) return predicate(vnode) ? [vnode] : [];
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return findNodes(rendered, predicate);
  }
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(findNodes(vnode.props.children as ComponentChild, predicate));
}

function byTag(node: ComponentChild, tag: string): VNode[] {
  return findNodes(node, (vnode) => vnode.type === tag);
}

function bySelect(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => isSelectVNode(vnode));
}

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function props(overrides: Partial<AppUpdateViewProps> = {}): AppUpdateViewProps {
  return {
    info: { version: "0.0.1", platform: "macos" },
    settings: { autoCheck: true, channel: "stable" },
    status: { state: "idle" },
    error: undefined,
    message: undefined,
    busy: false,
    confirmRestart: false,
    warning: undefined,
    now: 1_800_000_000,
    onCheck: () => {},
    onInstall: () => {},
    onRestart: () => {},
    onConfirmRestart: () => {},
    onCancelRestart: () => {},
    onToggleAutoCheck: () => {},
    onChannel: () => {},
    ...overrides,
  };
}

describe("AppUpdateSettings", () => {
  test("di peramban biasa tidak merender apa pun", () => {
    const scope = globalThis as { __TAURI_INTERNALS__?: unknown };
    delete scope.__TAURI_INTERNALS__;
    expect(AppUpdateSettings({ sessions: [] })).toBeNull();
  });

  test("di cangkang desktop merender kartu", () => {
    const scope = globalThis as { __TAURI_INTERNALS__?: unknown };
    scope.__TAURI_INTERNALS__ = { invoke: async () => ({ state: "idle" }) };
    try {
      const hasil = AppUpdateSettings({ sessions: [] });
      expect(hasil).not.toBeNull();
      // Kartu dirender lewat komponen anak; tipenya komponen fungsi Preact.
      expect(typeof (hasil as VNode).type).toBe("function");
    } finally {
      delete scope.__TAURI_INTERNALS__;
    }
  });
});

describe("AppUpdateView", () => {
  test("menampilkan versi dan tombol periksa", () => {
    const teks = textOf(AppUpdateView(props()) as ComponentChild);
    expect(teks).toContain("Pembaruan aplikasi");
    expect(teks).toContain("Versi Jejak 0.0.1");
    expect(teks).toContain("Periksa sekarang");
  });

  test("tombol periksa mati saat pembaruan berjalan", () => {
    const status: UpdaterStatus = { state: "downloading", downloaded: 1, total: 10 };
    const tombol = byTag(AppUpdateView(props({ status })) as ComponentChild, "button")[0];
    expect(propsOf(tombol).disabled).toBe(true);
  });

  test("status tersedia menampilkan versi, catatan, dan tombol perbarui", () => {
    const status: UpdaterStatus = {
      state: "available",
      version: "0.0.2",
      notes: "Catatan rilis",
    };
    const vnode = AppUpdateView(props({ status })) as ComponentChild;
    const teks = textOf(vnode);
    expect(teks).toContain("Pembaruan 0.0.2");
    expect(teks).toContain("Catatan rilis");
    expect(teks).toContain("Perbarui");
  });

  test("catatan rilis ditampilkan sebagai teks biasa", () => {
    const status: UpdaterStatus = { state: "available", notes: "<b>bukan tebal</b>" };
    const vnode = AppUpdateView(props({ status })) as ComponentChild;
    const pre = byTag(vnode, "pre")[0];
    expect(pre).toBeDefined();
    expect(textOf(pre!.props.children as ComponentChild)).toBe("<b>bukan tebal</b>");
    expect(propsOf(pre).dangerouslySetInnerHTML).toBeUndefined();
  });

  test("unduhan menampilkan bilah progres dan persen", () => {
    const status: UpdaterStatus = { state: "downloading", downloaded: 42, total: 100 };
    const vnode = AppUpdateView(props({ status })) as ComponentChild;
    const teks = textOf(vnode);
    expect(teks).toContain("Mengunduh 42%");
    const bar = byTag(vnode, "div").filter((node) =>
      String(propsOf(node).class ?? "").includes("jk-update-progress-bar"),
    )[0];
    expect(propsOf(bar).style).toEqual({ width: "42%" });
  });

  test("siap dimulai ulang menampilkan tombol mulai ulang", () => {
    const status: UpdaterStatus = { state: "ready" };
    const teks = textOf(AppUpdateView(props({ status })) as ComponentChild);
    expect(teks).toContain("Siap dimulai ulang");
    expect(teks).toContain("Mulai ulang sekarang");
  });

  test("peringatan restart tampil sebelum konfirmasi", () => {
    const status: UpdaterStatus = { state: "ready" };
    const peringatan = "1 sesi sedang berjalan. Mulai ulang akan menghentikannya.";
    const sebelum = AppUpdateView(props({ status, warning: peringatan })) as ComponentChild;
    expect(textOf(sebelum)).toContain("1 sesi sedang berjalan");
    expect(textOf(sebelum)).not.toContain("Tetap mulai ulang");
    const konfirmasi = AppUpdateView(
      props({ status, warning: peringatan, confirmRestart: true }),
    ) as ComponentChild;
    const teks = textOf(konfirmasi);
    expect(teks).toContain("1 sesi sedang berjalan");
    expect(teks).toContain("Tetap mulai ulang");
    expect(teks).toContain("Batal");
  });

  test("konfirmasi restart memakai modal, bukan tombol sebaris", () => {
    const status: UpdaterStatus = { state: "ready" };
    const node = AppUpdateView(
      props({ status, warning: "1 sesi sedang berjalan.", confirmRestart: true }),
    ) as ComponentChild;
    const kartu = findNodes(node, (vnode) => propsOf(vnode)["role"] === "alertdialog");
    expect(kartu).toHaveLength(1);
    expect(propsOf(kartu[0])["aria-modal"]).toBe("true");
    const sebelum = AppUpdateView(props({ status })) as ComponentChild;
    expect(
      findNodes(sebelum, (vnode) => propsOf(vnode)["role"] === "alertdialog"),
    ).toHaveLength(0);
  });

  test("galat menampilkan pesan dan tombol coba lagi", () => {
    const status: UpdaterStatus = { state: "error", error: "jaringan putus" };
    const teks = textOf(AppUpdateView(props({ status })) as ComponentChild);
    expect(teks).toContain("Gagal: jaringan putus");
    expect(teks).toContain("jaringan putus");
    expect(teks).toContain("Coba lagi");
  });

  test("pesan belum ada rilis stabil tampil apa adanya", () => {
    const pesan = "Belum ada rilis stabil. Pilih kanal Beta di Pengaturan.";
    const status: UpdaterStatus = { state: "error", error: pesan };
    const teks = textOf(AppUpdateView(props({ status })) as ComponentChild);
    expect(teks).toContain(pesan);
    expect(teks).toContain("Coba lagi");
  });

  test("pengaturan punya kotak periksa otomatis dan pilihan kanal", () => {
    const vnode = AppUpdateView(props()) as ComponentChild;
    const checkbox = byTag(vnode, "input").filter(
      (node) => propsOf(node).type === "checkbox",
    )[0];
    expect(propsOf(checkbox).checked).toBe(true);
    const select = bySelect(vnode)[0];
    expect(propsOf(select).value).toBe("stable");
    const opsi = selectOptions(select).map((option) => option.label);
    expect(opsi).toEqual(["Stabil", "Beta"]);
  });

  test("teks bantu menjelaskan kanal beta", () => {
    const teks = textOf(AppUpdateView(props()) as ComponentChild);
    expect(teks).toContain("pra-rilis");
  });

  test("waktu pemeriksaan terakhir ditampilkan relatif", () => {
    const status: UpdaterStatus = { state: "idle", lastCheck: 1_800_000_000 - 300 };
    const teks = textOf(AppUpdateView(props({ status })) as ComponentChild);
    expect(teks).toContain("5 menit lalu");
  });
});
