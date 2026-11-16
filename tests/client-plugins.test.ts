import { describe, expect, test } from "bun:test";
import type { ClaudePluginItem, MarketplacePluginItem } from "../src/client/lib/api";
import {
  installConfirmText,
  marketplaceSourceNote,
  pluginLabel,
  pluginSummary,
  searchPageLabel,
  sortPlugins,
} from "../src/client/lib/plugins";

function plugin(overrides: Partial<ClaudePluginItem> = {}): ClaudePluginItem {
  return {
    id: "alpha@pasar",
    name: "alpha",
    marketplace: "pasar",
    description: "Plugin contoh",
    version: "1.0.0",
    author: "Penulis",
    path: "/home/u/.claude/plugins/alpha",
    skills: 0,
    commands: 0,
    agents: 0,
    hasHooks: false,
    enabled: false,
    ...overrides,
  };
}

describe("ringkasan plugin", () => {
  test("hanya menyebut bagian yang lebih dari nol", () => {
    expect(
      pluginSummary(plugin({ skills: 3, commands: 2, agents: 1, hasHooks: true })),
    ).toBe("3 skill · 2 perintah · 1 agent · hooks");
    expect(pluginSummary(plugin({ skills: 1 }))).toBe("1 skill");
    expect(pluginSummary(plugin({ commands: 4 }))).toBe("4 perintah");
    expect(pluginSummary(plugin({ agents: 2 }))).toBe("2 agent");
    expect(pluginSummary(plugin({ hasHooks: true }))).toBe("hooks");
  });

  test("plugin tanpa komponen", () => {
    expect(pluginSummary(plugin())).toBe("Tanpa komponen");
  });
});

describe("label plugin", () => {
  test("nama dan versi", () => {
    expect(pluginLabel(plugin({ name: "alpha", version: "1.2.0" }))).toBe("alpha 1.2.0");
  });

  test("versi kosong disembunyikan", () => {
    expect(pluginLabel(plugin({ name: "alpha", version: "" }))).toBe("alpha");
  });
});

describe("urutan plugin", () => {
  test("plugin aktif didahulukan, lalu menurut nama", () => {
    const daftar = [
      plugin({ id: "b@pasar", name: "b", enabled: false }),
      plugin({ id: "c@pasar", name: "c", enabled: true }),
      plugin({ id: "a@pasar", name: "a", enabled: false }),
      plugin({ id: "d@pasar", name: "d", enabled: true }),
    ];
    expect(sortPlugins(daftar).map((item) => item.name)).toEqual(["c", "d", "a", "b"]);
  });

  test("daftar asal tak berubah", () => {
    const daftar = [
      plugin({ id: "b@pasar", name: "b", enabled: false }),
      plugin({ id: "a@pasar", name: "a", enabled: true }),
    ];
    sortPlugins(daftar);
    expect(daftar.map((item) => item.name)).toEqual(["b", "a"]);
  });
});

/* ---------- Marketplace ---------- */

function marketplace(
  overrides: Partial<MarketplacePluginItem> = {},
): MarketplacePluginItem {
  return {
    id: "alpha@pasar",
    name: "alpha",
    displayName: "Alpa",
    marketplace: "pasar",
    description: "Plugin contoh",
    author: "Penulis",
    category: "Alat",
    homepage: "https://contoh.example",
    version: "1.0.0",
    tags: ["demo"],
    sourceKind: "marketplace",
    installed: false,
    ...overrides,
  };
}

describe("catatan asal plugin", () => {
  test("perintah marketplace diberi peringatan khusus", () => {
    expect(marketplaceSourceNote("command")).toBe(
      "Plugin ini memasang lewat perintah yang dideklarasikan marketplace; periksa sumbernya sebelum memasang.",
    );
  });

  test("url dan git menyebut repositori pihak ketiga", () => {
    expect(marketplaceSourceNote("url")).toBe("Kode diunduh dari repositori pihak ketiga.");
    expect(marketplaceSourceNote("git")).toBe("Kode diunduh dari repositori pihak ketiga.");
  });

  test("marketplace disebut berasal dari repositori marketplace", () => {
    expect(marketplaceSourceNote("marketplace")).toBe("Berasal dari repositori marketplace.");
  });

  test("asal tak dikenal tetap memberi peringatan", () => {
    expect(marketplaceSourceNote("lainnya")).toContain("tidak dikenal");
  });
});

describe("konfirmasi pemasangan", () => {
  test("menyebut nama, marketplace, sumber, dan akibat pemasangan", () => {
    const teks = installConfirmText(
      marketplace({ sourceKind: "command" }),
    );
    expect(teks).toContain("Alpa");
    expect(teks).toContain("pasar");
    expect(teks).toContain("perintah marketplace");
    expect(teks).toContain("Kode pihak ketiga akan diunduh.");
    expect(teks).toContain("Plugin tidak dinyalakan otomatis setelah dipasang.");
  });

  test("nama cadangan dipakai bila displayName kosong", () => {
    const teks = installConfirmText(marketplace({ displayName: "" }));
    expect(teks).toContain("Pasang alpha (pasar)");
  });
});

describe("label halaman pencarian", () => {
  test("rentang awal dan total", () => {
    expect(searchPageLabel(0, 50, 317)).toBe("1–50 dari 317");
  });

  test("halaman kedua", () => {
    expect(searchPageLabel(50, 50, 317)).toBe("51–100 dari 317");
  });

  test("halaman terakhir dipotong sesuai total", () => {
    expect(searchPageLabel(300, 50, 317)).toBe("301–317 dari 317");
  });

  test("katalog kosong", () => {
    expect(searchPageLabel(0, 50, 0)).toBe("0 dari 0");
  });
});
