import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { Composer } from "../src/client/components/Composer";
import { Sidebar } from "../src/client/components/Sidebar";
import type { ApiClient } from "../src/client/lib/api";
import type { SessionInfo } from "../src/server/sessions/session-manager";
import {
  activeElement,
  findAll,
  findByAttr,
  fire,
  flushEffects,
  installDom,
  mount,
} from "./helpers/dom";

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

const SESI_A: SessionInfo = {
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

const SESI_B: SessionInfo = {
  ...SESI_A,
  id: "s2",
  title: "Sesi lain",
  cwd: "/tmp/proyek-b",
};

function sidebar(props: Record<string, unknown>): ReturnType<typeof mount> {
  return mount(
    h(Sidebar, {
      sessions: [SESI_A, SESI_B],
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

function apiPalsu(): ApiClient {
  const base = {
    nativePickerAvailable: async (): Promise<boolean> => false,
    getSandbox: async (): Promise<never> => {
      throw new Error("sandbox tak tersedia");
    },
  };
  return base as unknown as ApiClient;
}

function nilai(elemen: ReturnType<typeof findByAttr>): string {
  if (elemen === undefined) return "";
  const sebagaiProperti = (elemen as unknown as { value?: string }).value;
  if (typeof sebagaiProperti === "string") return sebagaiProperti;
  return elemen.getAttribute("value") ?? "";
}

describe("Sidebar: sesi baru per folder", () => {
  test("tiap grup punya tombol dengan aria-label folder dan memanggil onNewInFolder", () => {
    const dipanggil: string[] = [];
    const root = sidebar({ onNewInFolder: (cwd: string) => dipanggil.push(cwd) });

    const tombol = findAll(root, (node) => node.getAttribute("class") === "jk-group-add");
    expect(tombol).toHaveLength(2);
    expect(tombol[0]?.getAttribute("aria-label")).toBe("Sesi baru di proyek-a");
    expect(tombol[1]?.getAttribute("aria-label")).toBe("Sesi baru di proyek-b");

    fire(tombol[0]!, "click");
    expect(dipanggil).toEqual(["/tmp/proyek-a"]);
    fire(tombol[1]!, "click");
    expect(dipanggil).toEqual(["/tmp/proyek-a", "/tmp/proyek-b"]);
  });

  test("tombol tidak dirender bila prop tidak ada", () => {
    const root = sidebar({});
    expect(findByAttr(root, "class", "jk-group-add")).toBeUndefined();
  });
});

describe("Composer: preset folder dari sidebar", () => {
  test("preset mengisi folder kerja dan fokus ke prompt", async () => {
    const root = mount(
      h(Composer, {
        api: apiPalsu(),
        defaultCwd: "/tmp/awal",
        onCreated: () => {},
        presetCwd: { id: 1, cwd: "/tmp/proyek-b" },
      }),
    );
    await flushEffects();

    const folder = findByAttr(root, "id", "jk-cwd");
    expect(nilai(folder)).toBe("/tmp/proyek-b");
    expect(activeElement()?.localName).toBe("textarea");
  });

  test("id baru memasang ulang folder tanpa menimpa teks prompt", async () => {
    const props = { api: apiPalsu(), defaultCwd: "/tmp/awal", onCreated: () => {} };
    const root = mount(h(Composer, { ...props, presetCwd: { id: 1, cwd: "/tmp/proyek-a" } }));
    await flushEffects();
    const area = findByAttr(root, "id", "jk-prompt");
    expect(area).toBeDefined();
    (area as unknown as { value: string }).value = "Teks yang diketik";
    fire(area!, "input");
    await flushEffects();

    render(
      h(Composer, { ...props, presetCwd: { id: 2, cwd: "/tmp/proyek-b" } }),
      root as unknown as HTMLElement,
    );
    await flushEffects();

    expect(nilai(findByAttr(root, "id", "jk-cwd"))).toBe("/tmp/proyek-b");
    expect(nilai(findByAttr(root, "id", "jk-prompt"))).toBe("Teks yang diketik");
  });
});
