import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { PanelRailView } from "../src/client/components/PanelRail";
import {
  PANEL_RAIL_GROUPS,
  PANEL_RAIL_TABS,
  TABS_WITH_REFRESH,
  TABS_WITH_REPO,
  nextPanelTabIndex,
  nextPaneTabIndex,
  panelTabIcon,
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
      ["changes", "git", "files", "checkpoints", "design"],
      ["plan", "todos", "context", "commands", "terminal", "browser"],
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
      "design",
      "plan",
      "todos",
      "context",
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
    expect(panelTabLabel("design")).toBe("Desain");
    expect(panelTabLabel("rahasia")).toBe("Rahasia");
    expect(panelTabLabel("wiki")).toBe("Wiki");
    expect(panelTabLabel("commands")).toBe("Perintah");
    expect(panelTabLabel("terminal")).toBe("Terminal");
    expect(panelTabLabel("browser")).toBe("Browser");
    expect(panelTabLabel("plan")).toBe("Rencana");
    expect(panelTabLabel("context")).toBe("Konteks");
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

describe("ikon dan cakupan tab", () => {
  test("setiap tab punya ikon sendiri", () => {
    for (const tab of PANEL_RAIL_TABS) {
      expect(panelTabIcon(tab.id)).toBe(tab.icon);
    }
  });

  test("tab muat ulang dan repo memakai tab kode", () => {
    expect([...TABS_WITH_REFRESH].sort()).toEqual(["changes", "checkpoints", "files", "git"]);
    expect([...TABS_WITH_REPO].sort()).toEqual(["changes", "checkpoints", "files", "git"]);
  });
});

describe("nextPaneTabIndex", () => {
  test("panah kanan pindah satu dan berputar di akhir", () => {
    expect(nextPaneTabIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextPaneTabIndex("ArrowRight", 2, 3)).toBe(0);
  });

  test("panah kiri mundur satu dan berputar di awal", () => {
    expect(nextPaneTabIndex("ArrowLeft", 1, 3)).toBe(0);
    expect(nextPaneTabIndex("ArrowLeft", 0, 3)).toBe(2);
  });

  test("Home dan End menuju tab pertama dan terakhir", () => {
    expect(nextPaneTabIndex("Home", 1, 3)).toBe(0);
    expect(nextPaneTabIndex("End", 0, 3)).toBe(2);
  });

  test("kunci lain tidak mengubah indeks", () => {
    expect(nextPaneTabIndex("ArrowUp", 1, 3)).toBe(1);
    expect(nextPaneTabIndex("Enter", 1, 3)).toBe(1);
  });

  test("daftar kosong aman", () => {
    expect(nextPaneTabIndex("ArrowRight", 0, 0)).toBe(0);
  });
});

/* ---------- Render rel ikon ---------- */

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

function railButtons(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => vnode.type === "button");
}

function renderRail(options: {
  openTabs?: readonly PanelTab[];
  activeTab?: PanelTab;
  focusIndex?: number;
  countFor?: (id: PanelTab) => number | undefined;
  onOpen?: (id: PanelTab) => void;
} = {}): ComponentChild {
  return PanelRailView({
    openTabs: options.openTabs ?? [],
    activeTab: options.activeTab,
    focusIndex: options.focusIndex ?? 0,
    countFor: options.countFor,
    onOpen: options.onOpen ?? ((): void => {}),
  }) as unknown as ComponentChild;
}

describe("rel ikon sebagai peluncur alat", () => {
  test("berperan toolbar vertikal, bukan tablist", () => {
    const node = renderRail();
    const toolbar = byRole(node, "toolbar");
    expect(toolbar).toHaveLength(1);
    expect(propsOf(toolbar[0])["aria-orientation"]).toBe("vertical");
    expect(byRole(node, "tablist")).toHaveLength(0);
    expect(byRole(node, "tab")).toHaveLength(0);
  });

  test("tombol biasa tanpa aria-selected atau aria-controls", () => {
    const node = renderRail({ openTabs: ["git"] });
    for (const button of railButtons(node)) {
      expect(propsOf(button)["aria-selected"]).toBeUndefined();
      expect(propsOf(button)["aria-controls"]).toBeUndefined();
      expect(propsOf(button)["role"]).toBeUndefined();
    }
  });

  test("aria-pressed menandai alat yang sudah terbuka", () => {
    const node = renderRail({ openTabs: ["git", "todos"] });
    const tombol = railButtons(node);
    const tekan = new Map(
      tombol.map((vnode) => [String(propsOf(vnode)["aria-label"]), propsOf(vnode)["aria-pressed"]]),
    );
    expect(tekan.get("Git")).toBe(true);
    expect(tekan.get("Langkah")).toBe(true);
    expect(tekan.get("Perubahan")).toBe(false);
  });

  test("kelas open menandai alat yang sudah terbuka", () => {
    const node = renderRail({ openTabs: ["git"] });
    const buka = byClass(node, "jk-rail-btn-open");
    expect(buka).toHaveLength(1);
    expect(propsOf(buka[0])["aria-label"]).toBe("Git");
  });

  test("kelas active menandai tab aktif jendela yang difokuskan", () => {
    const node = renderRail({ activeTab: "todos" });
    const aktif = byClass(node, "jk-rail-btn-active");
    expect(aktif).toHaveLength(1);
    expect(propsOf(aktif[0])["aria-label"]).toBe("Langkah");
  });

  test("roving tabindex mengikuti indeks fokus", () => {
    const node = renderRail({ focusIndex: 2 });
    const tombol = railButtons(node);
    const fokus = tombol.filter((vnode) => propsOf(vnode)["tabIndex"] === 0);
    expect(fokus).toHaveLength(1);
    expect(propsOf(fokus[0])["aria-label"]).toBe("Berkas");
  });

  test("klik ikon membuka alatnya", () => {
    const dibuka: PanelTab[] = [];
    const node = renderRail({ onOpen: (id) => dibuka.push(id) });
    const tombol = railButtons(node);
    (propsOf(tombol[1])["onClick"] as () => void)();
    expect(dibuka).toEqual(["git"]);
  });

  test("lencana jumlah tetap tampil pada ikon", () => {
    const node = renderRail({ countFor: (id) => (id === "git" ? 3 : undefined) });
    const tombol = railButtons(node);
    const git = tombol.find((vnode) => propsOf(vnode)["aria-label"] === "Git");
    expect(JSON.stringify(propsOf(git)["children"])).toContain("3");
  });
});
