import { describe, expect, test } from "bun:test";
import type { ClaudePluginItem } from "../src/client/lib/api";
import { pluginLabel, pluginSummary, sortPlugins } from "../src/client/lib/plugins";

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
