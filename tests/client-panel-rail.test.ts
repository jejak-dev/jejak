import { describe, expect, test } from "bun:test";
import {
  PANEL_RAIL_GROUPS,
  PANEL_RAIL_TABS,
  nextPanelTabIndex,
  panelTabIndex,
  panelTabLabel,
} from "../src/client/lib/panel-rail";
import { PANEL_TAB_IDS, parsePanelPrefs, type PanelTab } from "../src/client/lib/panel-prefs";

describe("rel ikon panel", () => {
  test("tiga kelompok dengan urutan isi yang ditentukan", () => {
    expect(PANEL_RAIL_GROUPS.map((group) => group.id)).toEqual([
      "kode",
      "agent",
      "pengetahuan",
    ]);
    expect(PANEL_RAIL_GROUPS.map((group) => group.tabs.map((tab) => tab.id))).toEqual([
      ["changes", "git", "files", "checkpoints"],
      ["todos", "commands", "terminal", "browser"],
      ["wiki", "rahasia"],
    ]);
  });

  test("rel memuat semua id tab yang sah tepat satu kali", () => {
    const ids = PANEL_RAIL_TABS.map((tab) => tab.id);
    expect([...ids].sort()).toEqual([...PANEL_TAB_IDS].sort());
    expect(new Set(ids).size).toBe(PANEL_TAB_IDS.length);
  });

  test("urutan rel mengikuti urutan kelompok", () => {
    expect(PANEL_RAIL_TABS.map((tab) => tab.id)).toEqual([
      "changes",
      "git",
      "files",
      "checkpoints",
      "todos",
      "commands",
      "terminal",
      "browser",
      "wiki",
      "rahasia",
    ]);
  });

  test("label tampilan memakai Bahasa Indonesia", () => {
    expect(panelTabLabel("changes")).toBe("Perubahan");
    expect(panelTabLabel("todos")).toBe("Langkah");
    expect(panelTabLabel("files")).toBe("Berkas");
    expect(panelTabLabel("git")).toBe("Git");
    expect(panelTabLabel("checkpoints")).toBe("Checkpoint");
    expect(panelTabLabel("rahasia")).toBe("Rahasia");
    expect(panelTabLabel("wiki")).toBe("Wiki");
    expect(panelTabLabel("commands")).toBe("Perintah");
    expect(panelTabLabel("terminal")).toBe("Terminal");
    expect(panelTabLabel("browser")).toBe("Browser");
  });

  test("setiap tab punya ikon dan label tidak kosong", () => {
    for (const tab of PANEL_RAIL_TABS) {
      expect(tab.label.length).toBeGreaterThan(0);
      expect(tab.icon.length).toBeGreaterThan(0);
    }
  });

  test("id tab pada rel tetap Preferences lama", () => {
    for (const tab of PANEL_RAIL_TABS) {
      const prefs = parsePanelPrefs(JSON.stringify({ open: true, tab: tab.id }));
      expect(prefs.tab).toBe(tab.id);
    }
  });

  test("indeks tab mengikuti urutan rel", () => {
    expect(panelTabIndex("changes")).toBe(0);
    expect(panelTabIndex("rahasia")).toBe(PANEL_RAIL_TABS.length - 1);
  });
});

describe("nextPanelTabIndex", () => {
  const total = PANEL_RAIL_TABS.length;

  test("ArrowDown naik satu dan berputar di akhir", () => {
    expect(nextPanelTabIndex("ArrowDown", 0)).toBe(1);
    expect(nextPanelTabIndex("ArrowDown", total - 1)).toBe(0);
  });

  test("ArrowUp turun satu dan berputar di awal", () => {
    expect(nextPanelTabIndex("ArrowUp", 1)).toBe(0);
    expect(nextPanelTabIndex("ArrowUp", 0)).toBe(total - 1);
  });

  test("Home dan End menuju tab pertama dan terakhir", () => {
    expect(nextPanelTabIndex("Home", 4)).toBe(0);
    expect(nextPanelTabIndex("End", 4)).toBe(total - 1);
  });

  test("kunci lain tidak mengubah indeks", () => {
    expect(nextPanelTabIndex("Enter", 3)).toBe(3);
    expect(nextPanelTabIndex("ArrowLeft", 3)).toBe(3);
  });

  test("daftar kosong aman", () => {
    expect(nextPanelTabIndex("ArrowDown", 0, 0)).toBe(0);
    expect(nextPanelTabIndex("ArrowUp", 2, 1)).toBe(0);
  });

  test("indeks di luar rentang dinormalkan", () => {
    expect(nextPanelTabIndex("ArrowDown", total + 1)).toBe(2);
    expect(nextPanelTabIndex("ArrowUp", -1)).toBe(total - 2);
  });
});

describe("label panel", () => {
  test("label Indonesia memakai id yang dikenal", () => {
    const ids: PanelTab[] = [...PANEL_TAB_IDS];
    for (const id of ids) {
      expect(panelTabLabel(id)).not.toBe(id);
    }
  });
});
