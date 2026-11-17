import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { Sidebar } from "../src/client/components/Sidebar";
import type { SessionInfo } from "../src/server/sessions/session-manager";
import { findAll, findByAttr, fire, installDom, mount } from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
  (globalThis as Record<string, unknown>)["ResizeObserver"] = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterAll(() => {
  bersihkan?.();
});

const SESI: SessionInfo = {
  id: "s1",
  title: "Perbaiki login",
  prompt: "Halo",
  cwd: "/tmp/proyek-a",
  profileId: "lokal",
  permissionMode: "default",
  status: "berjalan",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  eventCount: 0,
  pendingPermissions: 0,
  queued: 0,
};

const SESI_BYPASS: SessionInfo = {
  ...SESI,
  id: "s2",
  title: "Sesi bypass",
  permissionMode: "bypassPermissions",
};

function sidebar(props: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(
    h(Sidebar, {
      sessions: [SESI, SESI_BYPASS],
      onSelect: () => {},
      onNew: () => {},
      onClose: () => {},
      onRename: async () => {},
      onArchive: async () => {},
      onDelete: async () => {},
      notifyPrefs: { enabled: false, sound: false },
      onNotifyPrefsChange: () => {},
      ...props,
    }),
  );
}

function berkelas(node: { getAttribute(name: string): string | null }, kelas: string): boolean {
  return (node.getAttribute("class") ?? "").split(/\s+/).includes(kelas);
}

describe("Sidebar bersih: tombol Keluar", () => {
  test("memuat ikon logout dan teks Keluar", () => {
    const root = sidebar({ authRequired: true, onLogout: () => {} });
    const tombol = findByAttr(root, "aria-label", "Keluar dari Jejak");
    expect(tombol).toBeDefined();
    expect(tombol!.textContent).toContain("Keluar");
    expect(findAll(tombol!, (node) => node.localName === "svg")).toHaveLength(1);
  });
});

describe("Sidebar bersih: baris sesi", () => {
  test("tidak ada teks Bypass maupun elemen time", () => {
    const root = sidebar({});
    expect(findAll(root, (node) => node.localName === "time")).toHaveLength(0);
    const baris = findAll(root, (node) => berkelas(node, "jk-session-row"));
    expect(baris).toHaveLength(2);
    for (const row of baris) {
      expect(row.textContent).not.toContain("Bypass");
    }
  });

  test("judul tombol baris memuat judul sesi", () => {
    const root = sidebar({});
    const baris = findAll(root, (node) => berkelas(node, "jk-session-row"));
    expect(baris[0]?.getAttribute("title")).toContain("Perbaiki login");
    expect(baris[1]?.getAttribute("title")).toContain("Sesi bypass");
  });

  test("mode bypass merender titik dengan aria-label penjelas", () => {
    const root = sidebar({});
    const bypass = findAll(root, (node) => berkelas(node, "jk-session-bypass"));
    expect(bypass).toHaveLength(1);
    expect(bypass[0]?.getAttribute("aria-label")).toBe(
      "Izin dilewati: agen menjalankan tool tanpa bertanya",
    );
  });
});

describe("Sidebar bersih: label grup dan sesi baru", () => {
  test("judul grup tidak memuat ikon folder", () => {
    const root = sidebar({});
    const label = findAll(root, (node) => berkelas(node, "jk-group-label"));
    expect(label.length).toBeGreaterThan(0);
    for (const node of label) {
      expect(findAll(node, (child) => child.localName === "svg")).toHaveLength(0);
    }
  });

  test("tombol sesi baru memanggil onNew tanpa class jk-button-primary", () => {
    let dipanggil = 0;
    const root = sidebar({ onNew: () => (dipanggil += 1) });
    const tombol = findAll(root, (node) => berkelas(node, "jk-new"));
    expect(tombol).toHaveLength(1);
    expect(berkelas(tombol[0]!, "jk-button-primary")).toBe(false);
    fire(tombol[0]!, "click");
    expect(dipanggil).toBe(1);
  });
});

describe("Sidebar bersih: tombol sembunyikan", () => {
  test("hanya ada bila onHideSidebar diberikan dan memanggilnya", () => {
    expect(
      findAll(sidebar({}), (node) => berkelas(node, "jk-side-hide")),
    ).toHaveLength(0);

    let dipanggil = 0;
    const root = sidebar({ onHideSidebar: () => (dipanggil += 1) });
    const tombol = findAll(root, (node) => berkelas(node, "jk-side-hide"));
    expect(tombol).toHaveLength(1);
    fire(tombol[0]!, "click");
    expect(dipanggil).toBe(1);
  });
});
