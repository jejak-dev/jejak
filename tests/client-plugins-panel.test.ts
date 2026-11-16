import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { PluginsPanel } from "../src/client/components/PluginsPanel";
import { ApiError, type ApiClient, type ClaudePluginItem, type MarketplacePluginItem } from "../src/client/lib/api";
import { find, fire, flushEffects, installDom, mount, type FakeNode } from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
});

afterAll(() => {
  bersihkan?.();
});

/* ---------- Data bantu ---------- */

function plugin(overrides: Partial<ClaudePluginItem> = {}): ClaudePluginItem {
  return {
    id: "alpha@pasar",
    name: "alpha",
    marketplace: "pasar",
    description: "Plugin contoh untuk menguji panel",
    version: "1.0.0",
    author: "Penulis",
    path: "/home/u/.claude/plugins/alpha",
    skills: 3,
    commands: 2,
    agents: 1,
    hasHooks: true,
    enabled: false,
    ...overrides,
  };
}

interface Panggilan {
  id: string;
  enabled: boolean;
}

interface Opsi {
  /** Galat saat memuat daftar plugin. */
  galatMuat?: unknown;
  /** Galat saat menyalakan plugin. */
  galatUbah?: unknown;
  /** Tahan permintaan ubah (untuk menguji pembaruan optimistis). */
  tahan?: boolean;
}

function apiPalsu(
  daftar: ClaudePluginItem[],
  opsi: Opsi = {},
): { api: ApiClient; panggilan: Panggilan[] } {
  const panggilan: Panggilan[] = [];
  const base = {
    listPlugins: async (): Promise<ClaudePluginItem[]> => {
      if (opsi.galatMuat !== undefined) throw opsi.galatMuat;
      return daftar;
    },
    setPluginEnabled: async (id: string, enabled: boolean): Promise<void> => {
      panggilan.push({ id, enabled });
      if (opsi.tahan === true) await new Promise<void>(() => {});
      if (opsi.galatUbah !== undefined) throw opsi.galatUbah;
    },
  };
  return { api: base as unknown as ApiClient, panggilan };
}

function saklar(root: FakeNode): FakeNode | undefined {
  return find(
    root,
    (node) => node.localName === "input" && node.getAttribute("type") === "checkbox",
  );
}

/** Status saklar: properti bila ada, atribut bila tidak. */
function aktif(elemen: FakeNode | undefined): boolean {
  if (elemen === undefined) return false;
  const properti = (elemen as unknown as { checked?: boolean }).checked;
  if (typeof properti === "boolean") return properti;
  return elemen.getAttribute("checked") === "true";
}

/* ---------- Tampilan ---------- */

describe("panel plugin", () => {
  test("menampilkan nama, versi, marketplace, ringkasan, dan penulis", async () => {
    const { api } = apiPalsu([plugin()]);
    const node = mount(h(PluginsPanel, { api }));
    await flushEffects();

    const teks = node.textContent;
    expect(teks).toContain("alpha 1.0.0");
    expect(teks).toContain("pasar");
    expect(teks).toContain("3 skill · 2 perintah · 1 agent · hooks");
    expect(teks).toContain("Penulis");
    expect(teks).toContain("Plugin dibaca dari instalasi Claude Code");
  });

  test("saklar memakai aria-label sesuai nama plugin", async () => {
    const { api } = apiPalsu([plugin()]);
    const node = mount(h(PluginsPanel, { api }));
    await flushEffects();

    expect(saklar(node)?.getAttribute("aria-label")).toBe("Aktifkan plugin alpha");
  });

  test("daftar kosong menampilkan petunjuk pasang plugin", async () => {
    const { api } = apiPalsu([]);
    const node = mount(h(PluginsPanel, { api }));
    await flushEffects();

    expect(node.textContent).toContain("Belum ada plugin terpasang.");
    expect(node.textContent).toContain("claude plugin install <nama>@<marketplace>");
  });

  test("galat memuat menampilkan pesan dan tombol coba lagi", async () => {
    const { api } = apiPalsu([], { galatMuat: new ApiError("jaringan mati", 0) });
    const node = mount(h(PluginsPanel, { api }));
    await flushEffects();

    expect(node.textContent).toContain("jaringan mati");
    expect(node.textContent).toContain("Coba lagi");
  });

  test("503 menampilkan catatan pengaturan Claude dimatikan", async () => {
    const { api } = apiPalsu([], {
      galatMuat: new ApiError("Pengaturan Claude dimatikan.", 503),
    });
    const node = mount(h(PluginsPanel, { api }));
    await flushEffects();

    expect(node.textContent).toContain("Pengaturan Claude dimatikan (JEJAK_CLAUDE_CONFIG=0).");
    expect(node.textContent).not.toContain("Coba lagi");
  });
});

/* ---------- Perilaku ---------- */

describe("perilaku panel plugin", () => {
  test("menyalakan plugin mengirim id dan status baru", async () => {
    const { api, panggilan } = apiPalsu([plugin()]);
    const node = mount(h(PluginsPanel, { api }));
    await flushEffects();

    const tombol = saklar(node);
    (tombol as unknown as { checked: boolean }).checked = true;
    fire(tombol as FakeNode, "change");
    await flushEffects();

    expect(panggilan).toEqual([{ id: "alpha@pasar", enabled: true }]);
    expect(aktif(saklar(node))).toBe(true);
  });

  test("pembaruan optimistis langsung terlihat sebelum server menjawab", async () => {
    const { api } = apiPalsu([plugin()], { tahan: true });
    const node = mount(h(PluginsPanel, { api }));
    await flushEffects();

    const tombol = saklar(node);
    (tombol as unknown as { checked: boolean }).checked = true;
    fire(tombol as FakeNode, "change");
    await flushEffects();

    expect(aktif(saklar(node))).toBe(true);
  });

  test("galat server mengembalikan saklar dan menampilkan pesan", async () => {
    const { api } = apiPalsu([plugin()], {
      galatUbah: new ApiError('Plugin "alpha@pasar" tidak terpasang.', 404),
    });
    const node = mount(h(PluginsPanel, { api }));
    await flushEffects();

    const tombol = saklar(node);
    (tombol as unknown as { checked: boolean }).checked = true;
    fire(tombol as FakeNode, "change");
    await flushEffects();

    expect(aktif(saklar(node))).toBe(false);
    expect(node.textContent).toContain('Plugin "alpha@pasar" tidak terpasang.');
  });
});

/* ---------- Tab Jelajahi ---------- */

const PLUGIN_MARKET: MarketplacePluginItem = {
  id: "alpha@pasar",
  name: "alpha",
  displayName: "Alpa",
  marketplace: "pasar",
  description: "Plugin contoh",
  author: "Penulis",
  category: "Alat",
  homepage: "",
  version: "1.0.0",
  tags: [],
  sourceKind: "marketplace",
  installed: false,
};

interface PanggilanPanel {
  /** Berapa kali daftar plugin terpasang dimuat. */
  muat: number;
  /** Id plugin yang dipasang. */
  pasang: string[];
}

function apiPanelLengkap(): { api: ApiClient; panggilan: PanggilanPanel } {
  const panggilan: PanggilanPanel = { muat: 0, pasang: [] };
  let terpasang = false;
  const base = {
    listPlugins: async (): Promise<ClaudePluginItem[]> => {
      panggilan.muat += 1;
      return terpasang ? [plugin({ enabled: false })] : [];
    },
    setPluginEnabled: async (): Promise<void> => {},
    listMarketplaces: async () => [
      { name: "pasar", description: "Contoh", pluginCount: 1, lastUpdated: "" },
    ],
    searchMarketplace: async () => ({
      items: [PLUGIN_MARKET],
      total: 1,
      categories: [],
    }),
    installPlugin: async (id: string) => {
      panggilan.pasang.push(id);
      terpasang = true;
      return { ok: true, message: "Plugin terpasang." };
    },
    uninstallPlugin: async () => ({ ok: true, message: "Plugin dicopot." }),
  };
  return { api: base as unknown as ApiClient, panggilan };
}

/** Tombol pertama yang teksnya sama persis. */
function tombolTeks(root: FakeNode, teks: string): FakeNode | undefined {
  return find(
    root,
    (node) => node.localName === "button" && node.textContent?.trim() === teks,
  );
}

describe("tab jelajahi di panel plugin", () => {
  test("panel menampilkan sub-tab Terpasang dan Jelajahi", async () => {
    const { api } = apiPanelLengkap();
    const node = mount(h(PluginsPanel, { api }));
    await flushEffects();

    expect(node.textContent).toContain("Terpasang");
    expect(node.textContent).toContain("Jelajahi");
    expect(node.textContent).toContain("Belum ada plugin terpasang.");
  });

  test("memasang plugin dari Jelajahi menyegarkan daftar Terpasang", async () => {
    const { api, panggilan } = apiPanelLengkap();
    const node = mount(h(PluginsPanel, { api }));
    await flushEffects();

    fire(tombolTeks(node, "Jelajahi")!, "click");
    await flushEffects();

    fire(tombolTeks(node, "Pasang")!, "click");
    await flushEffects();
    fire(tombolTeks(node, "Ya, pasang")!, "click");
    await flushEffects();

    expect(panggilan.pasang).toEqual(["alpha@pasar"]);
    // Daftar terpasang dimuat ulang setelah pemasangan.
    expect(panggilan.muat).toBeGreaterThan(1);

    fire(tombolTeks(node, "Terpasang")!, "click");
    await flushEffects();
    expect(node.textContent).toContain("alpha 1.0.0");
  });
});
