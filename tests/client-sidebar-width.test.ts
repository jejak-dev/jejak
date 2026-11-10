import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebarWidth,
  loadSidebarWidth,
  parseSidebarWidth,
  saveSidebarWidth,
  widthForKey,
} from "../src/client/lib/sidebar-width";

describe("lebar sidebar", () => {
  test("clamp ke batas dan menolak nilai bukan angka", () => {
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(300.4)).toBe(300);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT);
  });

  test("parse nilai tersimpan", () => {
    expect(parseSidebarWidth("320")).toBe(320);
    expect(parseSidebarWidth("1000")).toBe(SIDEBAR_MAX);
    expect(parseSidebarWidth("abc")).toBe(SIDEBAR_DEFAULT);
    expect(parseSidebarWidth(null)).toBe(SIDEBAR_DEFAULT);
    expect(parseSidebarWidth("")).toBe(SIDEBAR_DEFAULT);
  });

  test("simpan dan muat; storage rusak tidak melempar", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    saveSidebarWidth(storage, 350);
    expect(loadSidebarWidth(storage)).toBe(350);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => saveSidebarWidth(broken, 300)).not.toThrow();
    expect(loadSidebarWidth(broken)).toBe(SIDEBAR_DEFAULT);
    expect(loadSidebarWidth(undefined)).toBe(SIDEBAR_DEFAULT);
  });

  test("tombol keyboard", () => {
    expect(widthForKey(264, "ArrowRight")).toBe(280);
    expect(widthForKey(264, "ArrowLeft")).toBe(248);
    expect(widthForKey(SIDEBAR_MIN, "ArrowLeft")).toBe(SIDEBAR_MIN);
    expect(widthForKey(400, "Home")).toBe(SIDEBAR_DEFAULT);
    expect(widthForKey(264, "a")).toBeUndefined();
  });
});

describe("lebar panel kanan", () => {
  test("batas, default, dan arah panah (melebar ke kiri)", async () => {
    const { panelWidth, PANEL_DEFAULT } = await import("../src/client/lib/panel-width");
    expect(panelWidth.clamp(100)).toBe(320);
    expect(panelWidth.clamp(2000)).toBe(760);
    expect(panelWidth.parse("x")).toBe(PANEL_DEFAULT);
    expect(panelWidth.forKey(460, "ArrowLeft", "ArrowLeft")).toBe(480);
    expect(panelWidth.forKey(460, "ArrowRight", "ArrowLeft")).toBe(440);
    expect(panelWidth.forKey(600, "Home", "ArrowLeft")).toBe(PANEL_DEFAULT);
  });
});
