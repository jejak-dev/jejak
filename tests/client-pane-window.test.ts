import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { PaneWindowView } from "../src/client/components/PaneWindow";
import { toggleMaximize, visibleLayout, type Pane, type PaneLayout } from "../src/client/lib/pane-layout";
import type { PanelTab } from "../src/client/lib/panel-prefs";
import { PANEL_RAIL_TABS } from "../src/client/lib/panel-rail";

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

function byRole(node: ComponentChild, role: string): VNode[] {
  return findNodes(node, (vnode) => propsOf(vnode)["role"] === role);
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

function byAriaLabel(node: ComponentChild, label: string): VNode[] {
  return buttons(node).filter((vnode) => propsOf(vnode)["aria-label"] === label);
}

/** Semua elemen (bukan hanya tombol) yang memakai aria-label tertentu. */
function byAnyAriaLabel(node: ComponentChild, label: string): VNode[] {
  return findNodes(node, (vnode) => propsOf(vnode)["aria-label"] === label);
}

const NOOP = (): void => {};

interface RenderOptions {
  pane?: Pane;
  size?: number;
  isFirst?: boolean;
  paneCount?: number;
  availableTools?: readonly (typeof PANEL_RAIL_TABS)[number][];
  countFor?: (id: PanelTab) => number | undefined;
  showRepo?: boolean;
  repoLabel?: string;
  repoOptions?: { value: string; label: string; missing: boolean }[];
  showRefresh?: boolean;
  menuOpen?: boolean;
  optionsOpen?: boolean;
  narrow?: boolean;
  maximized?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onSelectTab?: (tab: PanelTab) => void;
  onCloseTab?: (tab: PanelTab) => void;
  onOpenTool?: (tab: PanelTab) => void;
  onClosePane?: () => void;
  onClosePanel?: () => void;
  onRefresh?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onToggleMaximize?: () => void;
  children?: ComponentChild;
}

function render(options: RenderOptions = {}): ComponentChild {
  const pane: Pane = options.pane ?? { id: "p1", tabs: ["changes"], active: "changes" };
  return PaneWindowView({
    pane,
    size: options.size ?? 1,
    isFirst: options.isFirst ?? true,
    paneCount: options.paneCount ?? 1,
    availableTools: options.availableTools ?? [],
    countFor: options.countFor,
    showRepo: options.showRepo ?? false,
    repoLabel: options.repoLabel ?? "jejak",
    repoOptions: options.repoOptions ?? [],
    showRefresh: options.showRefresh ?? false,
    menuOpen: options.menuOpen ?? false,
    optionsOpen: options.optionsOpen ?? false,
    narrow: options.narrow ?? false,
    maximized: options.maximized ?? false,
    canMoveUp: options.canMoveUp ?? true,
    canMoveDown: options.canMoveDown ?? true,
    onSelectTab: options.onSelectTab ?? NOOP,
    onCloseTab: options.onCloseTab ?? NOOP,
    onOpenTool: options.onOpenTool ?? NOOP,
    onClosePane: options.onClosePane ?? NOOP,
    onClosePanel: options.onClosePanel ?? NOOP,
    onRefresh: options.onRefresh ?? NOOP,
    onMoveUp: options.onMoveUp ?? NOOP,
    onMoveDown: options.onMoveDown ?? NOOP,
    onToggleMaximize: options.onToggleMaximize ?? NOOP,
    children: options.children ?? null,
  }) as unknown as ComponentChild;
}

/* ---------- Strip tab ---------- */

describe("jendela bertumpuk: strip tab", () => {
  test("memuat satu tab per tab jendela", () => {
    const node = render({
      pane: { id: "p1", tabs: ["changes", "git"], active: "git" },
    });
    const tabs = byRole(node, "tab");
    expect(tabs).toHaveLength(2);
    expect(byRole(node, "tablist")).toHaveLength(1);
    expect(textOf(tabs[0] as ComponentChild)).toContain("Perubahan");
    expect(textOf(tabs[1] as ComponentChild)).toContain("Git");
  });

  test("tab aktif ditandai dan memakai roving tabindex", () => {
    const node = render({
      pane: { id: "p1", tabs: ["changes", "git"], active: "git" },
    });
    const tabs = byRole(node, "tab");
    const aktif = tabs[1] as VNode;
    const nonaktif = tabs[0] as VNode;
    expect(propsOf(aktif)["aria-selected"]).toBe(true);
    expect(propsOf(aktif)["tabIndex"]).toBe(0);
    expect(propsOf(aktif)["id"]).toBe("jk-panel-tab-git");
    expect(propsOf(nonaktif)["aria-selected"]).toBe(false);
    expect(propsOf(nonaktif)["tabIndex"]).toBe(-1);
    expect(byClass(node, "jk-pane-tab-active")).toHaveLength(1);
  });

  test("tab aktif dipanggil saat diklik", () => {
    const dipilih: PanelTab[] = [];
    const node = render({
      pane: { id: "p1", tabs: ["changes", "git"], active: "changes" },
      onSelectTab: (tab) => dipilih.push(tab),
    });
    const tabs = byRole(node, "tab");
    (propsOf(tabs[1])["onClick"] as () => void)();
    expect(dipilih).toEqual(["git"]);
  });

  test("lencana jumlah tampil bila ada angka", () => {
    const node = render({
      pane: { id: "p1", tabs: ["changes"], active: "changes" },
      countFor: (id) => (id === "changes" ? 12 : undefined),
    });
    expect(textOf(node)).toContain("12");
    const tanpa = render({
      pane: { id: "p1", tabs: ["changes"], active: "changes" },
      countFor: () => 0,
    });
    expect(textOf(tanpa)).not.toContain("0");
  });
});

/* ---------- Tombol tutup tab ---------- */

describe("jendela bertumpuk: tombol tutup tab", () => {
  test("tidak ada pada satu-satunya tab di satu-satunya jendela", () => {
    const node = render({ pane: { id: "p1", tabs: ["changes"], active: "changes" } });
    expect(byAriaLabel(node, "Tutup tab Perubahan")).toHaveLength(0);
  });

  test("ada pada tab lain walau jendela tunggal", () => {
    const node = render({
      pane: { id: "p1", tabs: ["changes", "git"], active: "changes" },
    });
    const tutup = byAriaLabel(node, "Tutup tab Git");
    expect(tutup).toHaveLength(1);
  });

  test("ada pada satu-satunya tab bila ada beberapa jendela", () => {
    const node = render({
      pane: { id: "p1", tabs: ["changes"], active: "changes" },
      paneCount: 2,
      isFirst: false,
    });
    expect(byAriaLabel(node, "Tutup tab Perubahan")).toHaveLength(1);
  });

  test("menutup tab yang diklik", () => {
    const ditutup: PanelTab[] = [];
    const node = render({
      pane: { id: "p1", tabs: ["changes", "git"], active: "changes" },
      onCloseTab: (tab) => ditutup.push(tab),
    });
    (propsOf(byAriaLabel(node, "Tutup tab Git")[0])["onClick"] as () => void)();
    expect(ditutup).toEqual(["git"]);
  });
});

/* ---------- Menu tambah tab ---------- */

describe("jendela bertumpuk: menu tambah tab", () => {
  const git = PANEL_RAIL_TABS.find((entry) => entry.id === "git")!;
  const todos = PANEL_RAIL_TABS.find((entry) => entry.id === "todos")!;

  test("hanya memuat alat yang belum terbuka", () => {
    const node = render({ availableTools: [git, todos], menuOpen: true });
    const items = byRole(node, "menuitem");
    expect(items).toHaveLength(2);
    expect(textOf(items[0] as ComponentChild)).toContain("Git");
    expect(textOf(items[1] as ComponentChild)).toContain("Langkah");
  });

  test("menu tersembunyi saat belum dibuka", () => {
    const node = render({ availableTools: [git], menuOpen: false });
    expect(byRole(node, "menu")).toHaveLength(0);
    expect(byAriaLabel(node, "Tambah tab")).toHaveLength(1);
  });

  test("tombol tambah disembunyikan bila semua alat terbuka", () => {
    const node = render({ availableTools: [], menuOpen: false });
    expect(byAriaLabel(node, "Tambah tab")).toHaveLength(0);
  });

  test("memilih alat membuka tab itu", () => {
    const dibuka: PanelTab[] = [];
    const node = render({
      availableTools: [git],
      menuOpen: true,
      onOpenTool: (tab) => dibuka.push(tab),
    });
    (propsOf(byRole(node, "menuitem")[0])["onClick"] as () => void)();
    expect(dibuka).toEqual(["git"]);
  });
});

/* ---------- Chip repo, muat ulang, tutup jendela, tutup panel ---------- */

describe("jendela bertumpuk: tombol header", () => {
  test("chip repo hanya tampil bila diminta", () => {
    const tanpa = render({ showRepo: false });
    expect(byAnyAriaLabel(tanpa, "Repo")).toHaveLength(0);

    const dengan = render({
      showRepo: true,
      repoLabel: "jejak",
      repoOptions: [{ value: "jejak", label: "jejak (utama)", missing: false }],
    });
    const pilih = byAnyAriaLabel(dengan, "Repo");
    expect(pilih).toHaveLength(1);
    expect(propsOf(pilih[0])["value"]).toBe("jejak");
  });

  test("tombol muat ulang hanya tampil bila diminta", () => {
    expect(byAriaLabel(render({ showRefresh: false }), "Muat ulang")).toHaveLength(0);
    expect(byAriaLabel(render({ showRefresh: true }), "Muat ulang")).toHaveLength(1);
  });

  test("tombol tutup jendela hanya bila ada beberapa jendela", () => {
    expect(byAriaLabel(render({ paneCount: 1 }), "Tutup jendela")).toHaveLength(0);
    expect(byAriaLabel(render({ paneCount: 2 }), "Tutup jendela")).toHaveLength(1);
  });

  test("tombol tutup panel hanya di jendela pertama", () => {
    expect(byAriaLabel(render({ isFirst: false }), "Tutup panel")).toHaveLength(0);
    expect(byAriaLabel(render({ isFirst: true }), "Tutup panel")).toHaveLength(1);
  });

  test("menutup jendela dan panel memanggil penangan masing-masing", () => {
    let jendela = 0;
    let panel = 0;
    const node = render({
      paneCount: 2,
      onClosePane: () => {
        jendela += 1;
      },
      onClosePanel: () => {
        panel += 1;
      },
    });
    (propsOf(byAriaLabel(node, "Tutup jendela")[0])["onClick"] as () => void)();
    (propsOf(byAriaLabel(node, "Tutup panel")[0])["onClick"] as () => void)();
    expect(jendela).toBe(1);
    expect(panel).toBe(1);
  });
});

/* ---------- Menu opsi jendela ---------- */

describe("jendela bertumpuk: menu opsi jendela", () => {
  test("tombol opsi memakai aria menu dan state terbuka", () => {
    const node = render({ optionsOpen: false });
    const tombol = byAriaLabel(node, "Opsi jendela");
    expect(tombol).toHaveLength(1);
    expect(propsOf(tombol[0])["aria-haspopup"]).toBe("menu");
    expect(propsOf(tombol[0])["aria-expanded"]).toBe(false);
    expect(byRole(node, "menu")).toHaveLength(0);
  });

  test("menu terbuka memuat pindah dan perbesar", () => {
    const node = render({ optionsOpen: true });
    expect(propsOf(byAriaLabel(node, "Opsi jendela")[0])["aria-expanded"]).toBe(true);
    const items = byRole(node, "menuitem");
    expect(items).toHaveLength(3);
    expect(textOf(items[0] as ComponentChild)).toContain("Pindahkan ke jendela atas");
    expect(textOf(items[1] as ComponentChild)).toContain("Pindahkan ke jendela bawah");
    expect(textOf(items[2] as ComponentChild)).toContain("Perbesar jendela");
  });

  test("item pindah dinonaktifkan bila hasil tata letak sama", () => {
    const node = render({ optionsOpen: true, canMoveUp: false, canMoveDown: true });
    const items = byRole(node, "menuitem");
    expect(propsOf(items[0])["disabled"]).toBe(true);
    expect(propsOf(items[0])["aria-disabled"]).toBe(true);
    expect(propsOf(items[1])["disabled"]).toBe(false);
  });

  test("memilih arah memindahkan tab dan menutup menu", () => {
    let atas = 0;
    let bawah = 0;
    const node = render({
      optionsOpen: true,
      onMoveUp: () => {
        atas += 1;
      },
      onMoveDown: () => {
        bawah += 1;
      },
    });
    const items = byRole(node, "menuitem");
    (propsOf(items[0])["onClick"] as () => void)();
    (propsOf(items[1])["onClick"] as () => void)();
    expect(atas).toBe(1);
    expect(bawah).toBe(1);
  });

  test("menu memperbesar memakai kalimat berlawanan saat diperbesar", () => {
    const node = render({ optionsOpen: true, maximized: true });
    const items = byRole(node, "menuitem");
    expect(textOf(items[2] as ComponentChild)).toContain("Pulihkan ukuran");
  });

  test("menu disembunyikan di layar sempit", () => {
    const node = render({ optionsOpen: true, narrow: true });
    expect(byAriaLabel(node, "Opsi jendela")).toHaveLength(0);
    expect(byRole(node, "menu")).toHaveLength(0);
  });
});

/* ---------- Tombol perbesar ---------- */

describe("jendela bertumpuk: tombol perbesar", () => {
  test("tombol perbesar memakai aria-pressed", () => {
    const node = render({ maximized: false });
    const tombol = byAriaLabel(node, "Perbesar jendela");
    expect(tombol).toHaveLength(1);
    expect(propsOf(tombol[0])["aria-pressed"]).toBe(false);
  });

  test("jendela diperbesar memakai tombol pulihkan ukuran", () => {
    const node = render({ maximized: true });
    const tombol = byAriaLabel(node, "Pulihkan ukuran");
    expect(tombol).toHaveLength(1);
    expect(propsOf(tombol[0])["aria-pressed"]).toBe(true);
  });

  test("tombol memanggil penangan perbesar", () => {
    let dipanggil = 0;
    const node = render({
      onToggleMaximize: () => {
        dipanggil += 1;
      },
    });
    (propsOf(byAriaLabel(node, "Perbesar jendela")[0])["onClick"] as () => void)();
    expect(dipanggil).toBe(1);
  });

  test("tombol perbesar disembunyikan di layar sempit", () => {
    const node = render({ narrow: true });
    expect(byAriaLabel(node, "Perbesar jendela")).toHaveLength(0);
    expect(byAriaLabel(node, "Pulihkan ukuran")).toHaveLength(0);
  });

  test("jendela diperbesar menyembunyikan jendela lain", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
      ],
      sizes: [0.5, 0.5],
    };
    const diperbesar = toggleMaximize(layout, "p2");
    const tampil = visibleLayout(diperbesar);
    expect(tampil.panes).toHaveLength(1);
    expect(tampil.panes[0]?.id).toBe("p2");
    expect(tampil.sizes).toEqual([1]);
    // Jendela lain tetap ada di tata letak, hanya tidak digambar.
    expect(diperbesar.panes).toHaveLength(2);
  });
});

/* ---------- Isi jendela dan ARIA ---------- */

describe("jendela bertumpuk: isi dan ARIA", () => {
  test("tabpanel menunjuk tab aktifnya", () => {
    const node = render({
      pane: { id: "p1", tabs: ["changes", "git"], active: "git" },
    });
    const panel = byRole(node, "tabpanel");
    expect(panel).toHaveLength(1);
    expect(propsOf(panel[0])["id"]).toBe("jk-panel-panel-git");
    expect(propsOf(panel[0])["aria-labelledby"]).toBe("jk-panel-tab-git");
    expect(byId(node, "jk-panel-tab-git")).toBeDefined();
  });

  test("hanya tab aktif yang dipasang di dalam tabpanel", () => {
    const node = render({
      pane: { id: "p1", tabs: ["changes", "git"], active: "git" },
      children: "Isi tab Git",
    });
    const panel = byRole(node, "tabpanel")[0] as VNode;
    const isi = propsOf(panel)["children"];
    expect(textOf(isi as ComponentChild)).toBe("Isi tab Git");
    expect(textOf(isi as ComponentChild)).not.toContain("Isi tab Perubahan");
  });

  test("id tab unik antar jendela", () => {
    const pertama = render({ pane: { id: "p1", tabs: ["changes"], active: "changes" } });
    const kedua = render({
      pane: { id: "p2", tabs: ["git"], active: "git" },
      isFirst: false,
    });
    const ids = [...byRole(pertama, "tab"), ...byRole(kedua, "tab")].map(
      (vnode) => propsOf(vnode)["id"],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["jk-panel-tab-changes", "jk-panel-tab-git"]);
  });

  test("tinggi jendela memakai flex dari ukuran tata letak", () => {
    const node = render({ size: 0.4 });
    const pane = findNodes(node, (vnode) => propsOf(vnode)["class"] === "jk-pane")[0];
    expect(propsOf(pane)["style"]).toEqual({ flex: "0.4 1 0" });
  });
});
