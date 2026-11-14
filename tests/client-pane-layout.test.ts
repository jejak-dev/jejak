import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_PANES,
  MIN_SIZE,
  canMoveTab,
  closePane,
  closeTab,
  defaultLayout,
  evenBoundary,
  flattenForNarrow,
  focusTarget,
  moveTab,
  normalizeLayout,
  openTool,
  openTools,
  paneOfTool,
  resizeBoundary,
  resizeBoundaryByKey,
  setActive,
  toggleMaximize,
  visibleLayout,
  type PaneLayout,
} from "../src/client/lib/pane-layout";
import { readPaneLayout, writePaneLayout } from "../src/client/lib/pane-prefs";
import { PANEL_TAB_IDS, type PanelTab } from "../src/client/lib/panel-prefs";

/** Penyimpanan palsu untuk menguji baca dan tulis tata letak. */
function buatStorage(isi: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(isi));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

/** Periksa seluruh invarian tata letak. */
function cekInvarian(layout: PaneLayout): void {
  expect(layout.panes.length).toBeGreaterThanOrEqual(1);
  expect(layout.panes.length).toBeLessThanOrEqual(MAX_PANES);
  const semuaTab = layout.panes.flatMap((pane) => pane.tabs);
  expect(new Set(semuaTab).size).toBe(semuaTab.length);
  for (const pane of layout.panes) {
    expect(pane.tabs.length).toBeGreaterThanOrEqual(1);
    expect(pane.tabs).toContain(pane.active);
    expect(pane.id.length).toBeGreaterThan(0);
  }
  expect(new Set(layout.panes.map((pane) => pane.id)).size).toBe(layout.panes.length);
  expect(layout.sizes.length).toBe(layout.panes.length);
  for (const size of layout.sizes) {
    expect(size).toBeGreaterThanOrEqual(MIN_SIZE);
  }
  const jumlah = layout.sizes.reduce((a, b) => a + b, 0);
  expect(Math.abs(jumlah - 1)).toBeLessThanOrEqual(1e-9);
  if (layout.maximized !== undefined) {
    expect(layout.panes.map((pane) => pane.id)).toContain(layout.maximized);
  }
}

/** PRNG berbenih tetap supaya uji berulang selalu sama. */
function buatPRNG(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("tata letak jendela: bawaan", () => {
  test("satu jendela dengan satu tab dan ukuran penuh", () => {
    const layout = defaultLayout();
    expect(layout.panes).toEqual([{ id: "p1", tabs: ["changes"], active: "changes" }]);
    expect(layout.sizes).toEqual([1]);
    expect(layout.maximized).toBeUndefined();
    cekInvarian(layout);
  });

  test("tab bawaan dapat diganti", () => {
    const layout = defaultLayout("git");
    expect(layout.panes[0]?.tabs).toEqual(["git"]);
    expect(layout.panes[0]?.active).toBe("git");
    cekInvarian(layout);
  });
});

describe("tata letak jendela: normalisasi", () => {
  test("sampah total jatuh ke tata letak bawaan", () => {
    for (const value of [null, undefined, 42, "teks", [], true]) {
      const layout = normalizeLayout(value);
      expect(layout.panes).toHaveLength(1);
      expect(layout.panes[0]?.tabs).toEqual(["changes"]);
      expect(layout.sizes).toEqual([1]);
      cekInvarian(layout);
    }
  });

  test("tab tak dikenal dan duplikat dibuang", () => {
    const layout = normalizeLayout({
      panes: [
        { id: "p1", tabs: ["changes", "bogus", "git", "changes"], active: "git" },
        { id: "p2", tabs: ["git", "todos"], active: "todos" },
      ],
      sizes: [0.5, 0.5],
    });
    expect(layout.panes[0]?.tabs).toEqual(["changes", "git"]);
    expect(layout.panes[1]?.tabs).toEqual(["todos"]);
    cekInvarian(layout);
  });

  test("jendela kosong dibuang", () => {
    const layout = normalizeLayout({
      panes: [{ id: "p1", tabs: [], active: "changes" }, { id: "p2", tabs: ["git"] }],
      sizes: [0.5, 0.5],
    });
    expect(layout.panes).toHaveLength(1);
    expect(layout.panes[0]?.tabs).toEqual(["git"]);
    cekInvarian(layout);
  });

  test("tab aktif diperbaiki bila tidak ada di daftar tab", () => {
    const layout = normalizeLayout({
      panes: [{ id: "p1", tabs: ["git", "todos"], active: "bogus" }],
      sizes: [1],
    });
    expect(layout.panes[0]?.active).toBe("git");
    cekInvarian(layout);
  });

  test("jumlah jendela dibatasi tiga", () => {
    const layout = normalizeLayout({
      panes: [
        { id: "p1", tabs: ["changes"] },
        { id: "p2", tabs: ["git"] },
        { id: "p3", tabs: ["todos"] },
        { id: "p4", tabs: ["files"] },
      ],
      sizes: [0.25, 0.25, 0.25, 0.25],
    });
    expect(layout.panes).toHaveLength(MAX_PANES);
    cekInvarian(layout);
  });

  test("ukuran rusak dihitung ulang dengan bagi rata", () => {
    const rusak: unknown[] = [
      undefined,
      [],
      [0.5],
      [0.5, 0.4],
      [0.2, 0.3, 0.5],
      ["a", "b"],
      [Number.NaN, 0.5],
      [0.9, 0.9],
    ];
    for (const sizes of rusak) {
      const layout = normalizeLayout({
        panes: [
          { id: "p1", tabs: ["changes"] },
          { id: "p2", tabs: ["git"] },
        ],
        sizes,
      });
      expect(layout.sizes).toEqual([0.5, 0.5]);
      cekInvarian(layout);
    }
  });

  test("ukuran valid dipertahankan", () => {
    const layout = normalizeLayout({
      panes: [
        { id: "p1", tabs: ["changes"] },
        { id: "p2", tabs: ["git"] },
      ],
      sizes: [0.7, 0.3],
    });
    expect(layout.sizes).toEqual([0.7, 0.3]);
    cekInvarian(layout);
  });

  test("maximized tak valid dibuang dan yang sah dipertahankan", () => {
    const buruk = normalizeLayout({
      panes: [{ id: "p1", tabs: ["changes"] }],
      sizes: [1],
      maximized: "p9",
    });
    expect(buruk.maximized).toBeUndefined();

    const baik = normalizeLayout({
      panes: [{ id: "p1", tabs: ["changes"] }],
      sizes: [1],
      maximized: "p1",
    });
    expect(baik.maximized).toBe("p1");
    cekInvarian(baik);
  });

  test("id jendela ganda diberi id baru", () => {
    const layout = normalizeLayout({
      panes: [
        { id: "p1", tabs: ["changes"] },
        { id: "p1", tabs: ["git"] },
      ],
      sizes: [0.5, 0.5],
    });
    expect(layout.panes[0]?.id).toBe("p1");
    expect(layout.panes[1]?.id).not.toBe("p1");
    cekInvarian(layout);
  });

  test("normalisasi idempoten", () => {
    const layout = normalizeLayout({
      panes: [
        { id: "p1", tabs: ["changes", "git"], active: "git" },
        { id: "p2", tabs: ["todos"], active: "todos" },
      ],
      sizes: [0.6, 0.4],
      maximized: "p2",
    });
    expect(normalizeLayout(layout)).toEqual(layout);
  });
});

describe("tata letak jendela: openTool", () => {
  test("tab baru ditambahkan ke jendela terakhir dan menjadi aktif", () => {
    const layout = openTool(defaultLayout("changes"), "git");
    expect(layout.panes).toHaveLength(1);
    expect(layout.panes[0]?.tabs).toEqual(["changes", "git"]);
    expect(layout.panes[0]?.active).toBe("git");
    cekInvarian(layout);
  });

  test("tab yang sudah terbuka difokuskan tanpa menggandakan", () => {
    let layout = defaultLayout("changes");
    layout = openTool(layout, "git");
    const hasil = openTool(layout, "changes");
    expect(hasil.panes[0]?.tabs).toEqual(["changes", "git"]);
    expect(hasil.panes[0]?.active).toBe("changes");
    cekInvarian(hasil);
  });

  test("tab terbuka di jendela lain difokuskan di sana", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
      ],
      sizes: [0.5, 0.5],
    };
    const hasil = openTool(layout, "git");
    expect(hasil.panes[1]?.active).toBe("git");
    expect(openTools(hasil)).toEqual(["changes", "git"]);
    cekInvarian(hasil);
  });

  test("membuka tab di jendela lain menghapus keadaan perbesar jendela lain", () => {
    let layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
      ],
      sizes: [0.5, 0.5],
      maximized: "p1",
    };
    layout = openTool(layout, "git");
    expect(layout.maximized).toBeUndefined();
    cekInvarian(layout);
  });

  test("focusId mengarahkan tab baru ke jendela tertentu", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
      ],
      sizes: [0.5, 0.5],
    };
    const hasil = openTool(layout, "todos", "p1");
    expect(hasil.panes[0]?.tabs).toEqual(["changes", "todos"]);
    expect(hasil.panes[1]?.tabs).toEqual(["git"]);
    cekInvarian(hasil);
  });

  test("focusId tak dikenal memakai jendela terakhir", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
      ],
      sizes: [0.5, 0.5],
    };
    const hasil = openTool(layout, "todos", "p9");
    expect(hasil.panes[1]?.tabs).toEqual(["git", "todos"]);
    cekInvarian(hasil);
  });

  test("tab tidak pernah terbuka di dua jendela", () => {
    let layout = defaultLayout("changes");
    for (const tab of PANEL_TAB_IDS) {
      layout = openTool(layout, tab);
    }
    const semua = openTools(layout);
    expect(new Set(semua).size).toBe(semua.length);
    expect(semua).toHaveLength(PANEL_TAB_IDS.length);
    cekInvarian(layout);
  });

  test("masukan tidak berubah", () => {
    const layout = defaultLayout("changes");
    const salinan = JSON.stringify(layout);
    openTool(layout, "git");
    expect(JSON.stringify(layout)).toBe(salinan);
  });
});

describe("tata letak jendela: closeTab", () => {
  test("jendela kosong dihapus dan ukuran dibagi ke tetangga", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
      ],
      sizes: [0.5, 0.5],
    };
    const hasil = closeTab(layout, "changes");
    expect(hasil.panes).toHaveLength(1);
    expect(hasil.panes[0]?.id).toBe("p2");
    expect(hasil.sizes).toEqual([1]);
    cekInvarian(hasil);
  });

  test("tab aktif berpindah ke tab pertama jendela bila tab aktif ditutup", () => {
    const layout: PaneLayout = {
      panes: [{ id: "p1", tabs: ["changes", "git"], active: "git" }],
      sizes: [1],
    };
    const hasil = closeTab(layout, "git");
    expect(hasil.panes[0]?.active).toBe("changes");
    cekInvarian(hasil);
  });

  test("tab terakhir pada satu-satunya jendela tidak bisa ditutup", () => {
    const layout = defaultLayout("changes");
    const hasil = closeTab(layout, "changes");
    expect(hasil.panes).toHaveLength(1);
    expect(hasil.panes[0]?.tabs).toEqual(["changes"]);
    cekInvarian(hasil);
  });

  test("tab tak terbuka tidak mengubah tata letak", () => {
    const layout = defaultLayout("changes");
    const hasil = closeTab(layout, "git");
    expect(hasil.panes[0]?.tabs).toEqual(["changes"]);
    cekInvarian(hasil);
  });
});

describe("tata letak jendela: closePane", () => {
  test("jendela dihapus beserta tabnya", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git", "todos"], active: "git" },
      ],
      sizes: [0.4, 0.6],
    };
    const hasil = closePane(layout, "p1");
    expect(hasil.panes).toHaveLength(1);
    expect(hasil.panes[0]?.id).toBe("p2");
    expect(hasil.sizes).toEqual([1]);
    cekInvarian(hasil);
  });

  test("jendela terakhir tidak bisa dihapus", () => {
    const layout = defaultLayout("changes");
    const hasil = closePane(layout, "p1");
    expect(hasil.panes).toHaveLength(1);
    expect(hasil.panes[0]?.tabs).toEqual(["changes"]);
    cekInvarian(hasil);
  });

  test("id tidak dikenal tidak mengubah tata letak", () => {
    const layout = defaultLayout("changes");
    const hasil = closePane(layout, "p9");
    expect(hasil.panes).toHaveLength(1);
    cekInvarian(hasil);
  });
});

describe("tata letak jendela: setActive", () => {
  test("tab aktif berpindah di jendela yang diminta", () => {
    const layout: PaneLayout = {
      panes: [{ id: "p1", tabs: ["changes", "git"], active: "changes" }],
      sizes: [1],
    };
    const hasil = setActive(layout, "p1", "git");
    expect(hasil.panes[0]?.active).toBe("git");
    cekInvarian(hasil);
  });

  test("jendela atau tab yang tidak dikenal diabaikan", () => {
    const layout = defaultLayout("changes");
    expect(setActive(layout, "p9", "changes").panes[0]?.active).toBe("changes");
    expect(setActive(layout, "p1", "git").panes[0]?.active).toBe("changes");
  });
});

describe("tata letak jendela: moveTab", () => {
  test("tab pindah ke jendela sebelah dan menjadi aktif di sana", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes", "git"], active: "changes" },
        { id: "p2", tabs: ["todos"], active: "todos" },
      ],
      sizes: [0.5, 0.5],
    };
    const hasil = moveTab(layout, "changes", "bawah");
    expect(hasil.panes[0]?.tabs).toEqual(["git"]);
    expect(hasil.panes[1]?.tabs).toEqual(["todos", "changes"]);
    expect(hasil.panes[1]?.active).toBe("changes");
    cekInvarian(hasil);
  });

  test("jendela asal yang jadi kosong dihapus", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
      ],
      sizes: [0.5, 0.5],
    };
    const hasil = moveTab(layout, "changes", "bawah");
    expect(hasil.panes).toHaveLength(1);
    expect(hasil.panes[0]?.tabs).toEqual(["git", "changes"]);
    expect(hasil.sizes).toEqual([1]);
    cekInvarian(hasil);
  });

  test("jendela baru dibuat di atas bila tidak ada tetangga", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes", "git"], active: "changes" },
        { id: "p2", tabs: ["todos"], active: "todos" },
      ],
      sizes: [0.5, 0.5],
    };
    const hasil = moveTab(layout, "changes", "atas");
    expect(hasil.panes).toHaveLength(3);
    expect(hasil.panes[0]?.tabs).toEqual(["changes"]);
    expect(hasil.panes[0]?.id).not.toBe("p1");
    expect(hasil.panes[1]?.tabs).toEqual(["git"]);
    expect(hasil.sizes[0]).toBeCloseTo(0.4, 10);
    cekInvarian(hasil);
  });

  test("jendela baru dibuat di bawah bila tidak ada tetangga", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["todos"], active: "todos" },
      ],
      sizes: [0.5, 0.5],
    };
    const hasil = moveTab(layout, "todos", "bawah");
    // Jendela asal kosong lalu dihapus, digantikan jendela baru di bawah.
    expect(hasil.panes).toHaveLength(2);
    expect(hasil.panes[0]?.tabs).toEqual(["changes"]);
    expect(hasil.panes[1]?.tabs).toEqual(["todos"]);
    expect(hasil.sizes[1]).toBeCloseTo(0.4, 10);
    cekInvarian(hasil);
  });

  test("jendela tunggal menghasilkan satu jendela utuh", () => {
    const layout = defaultLayout("changes");
    const hasil = moveTab(layout, "changes", "bawah");
    expect(hasil.panes).toHaveLength(1);
    expect(hasil.panes[0]?.tabs).toEqual(["changes"]);
    expect(hasil.sizes).toEqual([1]);
    cekInvarian(hasil);
  });

  test("sudah tiga jendela dan di tepi tidak mengubah tata letak", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
        { id: "p3", tabs: ["todos"], active: "todos" },
      ],
      sizes: [0.4, 0.3, 0.3],
    };
    const hasil = moveTab(layout, "changes", "atas");
    expect(hasil.panes).toHaveLength(3);
    expect(hasil.panes[0]?.tabs).toEqual(["changes"]);
    cekInvarian(hasil);
  });

  test("tab tak terbuka tidak mengubah tata letak", () => {
    const layout = defaultLayout("changes");
    const hasil = moveTab(layout, "git", "atas");
    expect(hasil.panes[0]?.tabs).toEqual(["changes"]);
    cekInvarian(hasil);
  });
});

describe("tata letak jendela: resizeBoundary", () => {
  const tiga: PaneLayout = {
    panes: [
      { id: "p1", tabs: ["changes"], active: "changes" },
      { id: "p2", tabs: ["git"], active: "git" },
      { id: "p3", tabs: ["todos"], active: "todos" },
    ],
    sizes: [0.5, 0.3, 0.2],
  };

  test("hanya dua tetangga yang berubah dan jumlah tetap satu", () => {
    const hasil = resizeBoundary(tiga, 0, 0.1);
    expect(hasil.sizes[0]).toBeCloseTo(0.6, 10);
    expect(hasil.sizes[1]).toBeCloseTo(0.2, 10);
    expect(hasil.sizes[2]).toBeCloseTo(0.2, 10);
    cekInvarian(hasil);
  });

  test("nilai dibatasi minimum", () => {
    const hasil = resizeBoundary(tiga, 0, -1);
    expect(hasil.sizes[0]).toBeCloseTo(MIN_SIZE, 10);
    expect(hasil.sizes[0]).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(hasil.sizes[1]).toBeGreaterThanOrEqual(MIN_SIZE);
    cekInvarian(hasil);
  });

  test("indeks di luar rentang tidak mengubah apa pun", () => {
    const hasil = resizeBoundary(tiga, 5, 0.1);
    expect(hasil.sizes).toEqual(tiga.sizes);
    const hasil2 = resizeBoundary(tiga, -1, 0.1);
    expect(hasil2.sizes).toEqual(tiga.sizes);
  });

  test("satu jendela tidak bisa digeser", () => {
    const hasil = resizeBoundary(defaultLayout("changes"), 0, 0.1);
    expect(hasil.sizes).toEqual([1]);
  });

  test("panah menggeser 0,05", () => {
    const bawah = resizeBoundaryByKey(tiga, 0, "ArrowDown");
    expect(bawah?.sizes[0]).toBeCloseTo(0.55, 10);
    const atas = resizeBoundaryByKey(tiga, 0, "ArrowUp");
    expect(atas?.sizes[0]).toBeCloseTo(0.45, 10);
  });

  test("Home dan End menjepit ke batas", () => {
    const home = resizeBoundaryByKey(tiga, 0, "Home");
    expect(home?.sizes[0]).toBeCloseTo(MIN_SIZE, 10);
    const end = resizeBoundaryByKey(tiga, 0, "End");
    expect(end?.sizes[1]).toBeCloseTo(MIN_SIZE, 10);
    expect(end?.sizes[0]).toBeGreaterThanOrEqual(MIN_SIZE);
  });

  test("kunci lain tidak dikenal mengembalikan undefined", () => {
    expect(resizeBoundaryByKey(tiga, 0, "Enter")).toBeUndefined();
    expect(resizeBoundaryByKey(tiga, 0, "a")).toBeUndefined();
  });
});

describe("tata letak jendela: evenBoundary", () => {
  const tiga: PaneLayout = {
    panes: [
      { id: "p1", tabs: ["changes"], active: "changes" },
      { id: "p2", tabs: ["git"], active: "git" },
      { id: "p3", tabs: ["todos"], active: "todos" },
    ],
    sizes: [0.5, 0.3, 0.2],
  };

  test("dua tetangga dibagi rata dan jendela lain tidak berubah", () => {
    const hasil = evenBoundary(tiga, 0);
    expect(hasil.sizes[0]).toBeCloseTo(0.4, 10);
    expect(hasil.sizes[1]).toBeCloseTo(0.4, 10);
    expect(hasil.sizes[2]).toBeCloseTo(0.2, 10);
    cekInvarian(hasil);
  });

  test("pembatas kedua membagi dua jendela terakhir", () => {
    const hasil = evenBoundary(tiga, 1);
    expect(hasil.sizes[0]).toBeCloseTo(0.5, 10);
    expect(hasil.sizes[1]).toBeCloseTo(0.25, 10);
    expect(hasil.sizes[2]).toBeCloseTo(0.25, 10);
    cekInvarian(hasil);
  });

  test("indeks di luar rentang tidak mengubah apa pun", () => {
    expect(evenBoundary(tiga, 5).sizes).toEqual(tiga.sizes);
    expect(evenBoundary(tiga, -1).sizes).toEqual(tiga.sizes);
    expect(evenBoundary(defaultLayout("changes"), 0).sizes).toEqual([1]);
  });

  test("masukan tidak berubah", () => {
    const salinan = JSON.stringify(tiga);
    evenBoundary(tiga, 0);
    expect(JSON.stringify(tiga)).toBe(salinan);
  });
});

describe("tata letak jendela: flattenForNarrow", () => {
  const dua: PaneLayout = {
    panes: [
      { id: "p1", tabs: ["changes", "git"], active: "git" },
      { id: "p2", tabs: ["todos"], active: "todos" },
    ],
    sizes: [0.6, 0.4],
  };

  test("seluruh tab digabung dalam urutan jendela", () => {
    const hasil = flattenForNarrow(dua);
    expect(hasil.panes).toHaveLength(1);
    expect(hasil.panes[0]?.tabs).toEqual(["changes", "git", "todos"]);
    expect(hasil.sizes).toEqual([1]);
    expect(hasil.maximized).toBeUndefined();
    cekInvarian(hasil);
  });

  test("tab aktif memakai jendela yang terakhir difokuskan", () => {
    const hasil = flattenForNarrow(dua, "p1");
    expect(hasil.panes[0]?.active).toBe("git");
    const lain = flattenForNarrow(dua, "p2");
    expect(lain.panes[0]?.active).toBe("todos");
  });

  test("tanpa fokus memakai jendela terakhir", () => {
    const hasil = flattenForNarrow(dua);
    expect(hasil.panes[0]?.active).toBe("todos");
  });

  test("keadaan diperbesar dibuang", () => {
    const diperbesar: PaneLayout = { ...dua, maximized: "p2" };
    const hasil = flattenForNarrow(diperbesar);
    expect(hasil.maximized).toBeUndefined();
    expect(hasil.panes).toHaveLength(1);
    cekInvarian(hasil);
  });

  test("masukan tidak berubah", () => {
    const salinan = JSON.stringify(dua);
    flattenForNarrow(dua, "p1");
    expect(JSON.stringify(dua)).toBe(salinan);
  });
});

describe("tata letak jendela: perpindahan dan jendela terlihat", () => {
  const tiga: PaneLayout = {
    panes: [
      { id: "p1", tabs: ["changes"], active: "changes" },
      { id: "p2", tabs: ["git"], active: "git" },
      { id: "p3", tabs: ["todos"], active: "todos" },
    ],
    sizes: [0.4, 0.3, 0.3],
  };

  test("canMoveTab_false bila hasil tata letak sama", () => {
    // Sudah tiga jendela dan di tepi atas: tidak ada tempat untuk pindah.
    expect(canMoveTab(tiga, "changes", "atas")).toBe(false);
    expect(canMoveTab(tiga, "todos", "bawah")).toBe(false);
    // Tab di tengah bisa pindah ke kedua arah.
    expect(canMoveTab(tiga, "git", "atas")).toBe(true);
    expect(canMoveTab(tiga, "git", "bawah")).toBe(true);
  });

  test("tab tunggal di satu-satunya jendela tidak bisa dipindah", () => {
    expect(canMoveTab(defaultLayout("changes"), "changes", "atas")).toBe(false);
    expect(canMoveTab(defaultLayout("changes"), "changes", "bawah")).toBe(false);
  });

  test("jendela diperbesar menyembunyikan jendela lain tanpa melepasnya", () => {
    const hasil = visibleLayout({ ...tiga, maximized: "p2" });
    expect(hasil.panes).toHaveLength(1);
    expect(hasil.panes[0]?.id).toBe("p2");
    expect(hasil.sizes).toEqual([1]);
    // Tata letak asal tetap menyimpan seluruh jendela.
    expect(tiga.panes).toHaveLength(3);
  });

  test("tanpa keadaan diperbesar seluruh jendela tetap terlihat", () => {
    const hasil = visibleLayout(tiga);
    expect(hasil.panes).toHaveLength(3);
    expect(hasil.sizes).toEqual([0.4, 0.3, 0.3]);
  });
});

describe("tata letak jendela: maximize dan pembacaan", () => {  test("maximized dinyalakan lalu dimatikan", () => {
    const menyala = toggleMaximize(defaultLayout("changes"), "p1");
    expect(menyala.maximized).toBe("p1");
    const mati = toggleMaximize(menyala, "p1");
    expect(mati.maximized).toBeUndefined();
    cekInvarian(menyala);
    cekInvarian(mati);
  });

  test("jendela tak dikenal tidak mengubah tata letak", () => {
    const layout = defaultLayout("changes");
    expect(toggleMaximize(layout, "p9").maximized).toBeUndefined();
  });

  test("paneOfTool menemukan jendela pemilik tab", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
      ],
      sizes: [0.5, 0.5],
    };
    expect(paneOfTool(layout, "git")?.id).toBe("p2");
    expect(paneOfTool(layout, "todos")).toBeUndefined();
  });

  test("openTools mengikuti urutan jendela lalu tab", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes", "git"], active: "changes" },
        { id: "p2", tabs: ["todos"], active: "todos" },
      ],
      sizes: [0.5, 0.5],
    };
    expect(openTools(layout)).toEqual(["changes", "git", "todos"]);
  });

  test("focusTarget menunjuk jendela terakhir", () => {
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes"], active: "changes" },
        { id: "p2", tabs: ["git"], active: "git" },
      ],
      sizes: [0.5, 0.5],
    };
    expect(focusTarget(layout)).toBe("p2");
    expect(focusTarget(defaultLayout("changes"))).toBe("p1");
  });
});

describe("penyimpanan tata letak jendela", () => {
  let asli: Storage | undefined;

  beforeEach(() => {
    asli = globalThis.localStorage;
  });

  afterEach(() => {
    globalThis.localStorage = asli as Storage;
  });

  test("penyimpanan kosong memakai tab terakhir preferensi panel lama", () => {
    globalThis.localStorage = buatStorage({ "jejak.panel": JSON.stringify({ open: true, tab: "git" }) }) as unknown as Storage;
    const hasil = readPaneLayout(buatStorage());
    expect(hasil.panes).toHaveLength(1);
    expect(hasil.panes[0]?.tabs).toEqual(["git"]);
    cekInvarian(hasil);
  });

  test("JSON rusak memakai tab terakhir preferensi panel lama", () => {
    globalThis.localStorage = buatStorage({ "jejak.panel": JSON.stringify({ open: true, tab: "wiki" }) }) as unknown as Storage;
    const hasil = readPaneLayout(buatStorage({ "jejak.panes": "{bukan json" }));
    expect(hasil.panes[0]?.tabs).toEqual(["wiki"]);
    cekInvarian(hasil);
  });

  test("penyimpanan yang melempar tidak menggagalkan pembacaan", () => {
    globalThis.localStorage = buatStorage({ "jejak.panel": JSON.stringify({ open: true, tab: "todos" }) }) as unknown as Storage;
    const storage = {
      getItem: () => {
        throw new Error("ditolak");
      },
    };
    const hasil = readPaneLayout(storage);
    expect(hasil.panes[0]?.tabs).toEqual(["todos"]);
    cekInvarian(hasil);
  });

  test("data tak dikenal memakai tab terakhir preferensi panel lama", () => {
    globalThis.localStorage = buatStorage({ "jejak.panel": JSON.stringify({ open: true, tab: "files" }) }) as unknown as Storage;
    const hasil = readPaneLayout(buatStorage({ "jejak.panes": JSON.stringify({ panes: [] }) }));
    expect(hasil.panes[0]?.tabs).toEqual(["files"]);
    cekInvarian(hasil);
  });

  test("tulis dan baca bolak-balik menjaga tata letak", () => {
    globalThis.localStorage = buatStorage() as unknown as Storage;
    const storage = buatStorage();
    const layout: PaneLayout = {
      panes: [
        { id: "p1", tabs: ["changes", "git"], active: "git" },
        { id: "p2", tabs: ["todos"], active: "todos" },
      ],
      sizes: [0.6, 0.4],
      maximized: "p2",
    };
    writePaneLayout(layout, storage);
    const hasil = readPaneLayout(storage);
    expect(hasil).toEqual(layout);
    cekInvarian(hasil);
  });

  test("penyimpanan yang melempar saat menulis tidak menggagalkan", () => {
    globalThis.localStorage = buatStorage() as unknown as Storage;
    const storage = {
      setItem: () => {
        throw new Error("ditolak");
      },
    };
    expect(() => writePaneLayout(defaultLayout("changes"), storage)).not.toThrow();
  });

  test("data yang ditulis dapat dibaca kembali oleh fungsi baca bawaan", () => {
    const storage = buatStorage();
    globalThis.localStorage = storage as unknown as Storage;
    writePaneLayout(defaultLayout("git"), storage);
    const hasil = readPaneLayout();
    expect(hasil.panes[0]?.tabs).toEqual(["git"]);
    cekInvarian(hasil);
  });
});

describe("uji berbasis properti tata letak jendela", () => {
  test("dua ratus operasi acak menjaga seluruh invarian", () => {
    const acak = buatPRNG(20261115);
    const semuaTab: PanelTab[] = [...PANEL_TAB_IDS];
    let layout = defaultLayout("changes");
    cekInvarian(layout);

    for (let langkah = 0; langkah < 200; langkah += 1) {
      const lama = layout;
      const sebelum = JSON.stringify(lama);
      const tab = semuaTab[Math.floor(acak() * semuaTab.length)] as PanelTab;
      const arah = acak() < 0.5 ? "atas" : "bawah";
      const indeks = Math.floor(acak() * (MAX_PANES + 1)) - 1;
      const delta = (acak() - 0.5) * 0.8;
      const kunci = ["ArrowUp", "ArrowDown", "Home", "End", "Enter"][Math.floor(acak() * 5)] as string;
      const paneId = layout.panes[Math.floor(acak() * layout.panes.length)]?.id ?? "p1";

      switch (Math.floor(acak() * 10)) {
        case 0:
          layout = openTool(layout, tab);
          break;
        case 1:
          layout = closeTab(layout, tab);
          break;
        case 2:
          layout = closePane(layout, paneId);
          break;
        case 3:
          layout = setActive(layout, paneId, tab);
          break;
        case 4:
          layout = moveTab(layout, tab, arah);
          break;
        case 5:
          layout = resizeBoundary(layout, indeks, delta);
          break;
        case 6:
          layout = toggleMaximize(layout, paneId);
          break;
        case 7:
          layout = resizeBoundaryByKey(layout, indeks, kunci) ?? layout;
          break;
        case 8:
          layout = evenBoundary(layout, indeks);
          break;
        default:
          layout = flattenForNarrow(layout, paneId);
          break;
      }

      // Masukan tidak boleh berubah dan seluruh invarian tetap berlaku.
      expect(JSON.stringify(lama)).toBe(sebelum);
      cekInvarian(layout);
    }
  });
});
