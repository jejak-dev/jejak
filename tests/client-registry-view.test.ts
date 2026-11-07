import { describe, expect, test } from "bun:test";
import { parseRegistryView } from "../src/client/lib/registry-view";

describe("parseRegistryView", () => {
  test("bentuk lengkap", () => {
    const input = {
      activeProfileId: "lokal",
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://api.example.com",
          apiKeyEnv: "LOKAL_KEY",
          apiKey: "***",
          models: [{ id: "m1", label: "Model satu" }, { id: "m2" }],
          defaultModel: "m1",
          lightModel: "m2",
        },
      ],
    };

    expect(parseRegistryView(input)).toEqual({
      activeProfileId: "lokal",
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://api.example.com",
          apiKeyEnv: "LOKAL_KEY",
          hasKey: true,
          models: [{ id: "m1", label: "Model satu" }, { id: "m2" }],
          defaultModel: "m1",
          lightModel: "m2",
        },
      ],
    });
  });

  test("terbungkus registry", () => {
    const registry = {
      activeProfileId: "a",
      profiles: [{ id: "a", name: "A", models: [{ id: "m" }] }],
    };

    expect(parseRegistryView({ registry })).toEqual({
      activeProfileId: "a",
      profiles: [{ id: "a", name: "A", hasKey: false, models: [{ id: "m" }] }],
    });
  });

  test("sampah menjadi daftar kosong", () => {
    expect(parseRegistryView(undefined)).toEqual({ profiles: [] });
    expect(parseRegistryView(null)).toEqual({ profiles: [] });
    expect(parseRegistryView("teks")).toEqual({ profiles: [] });
    expect(parseRegistryView([])).toEqual({ profiles: [] });
    expect(parseRegistryView({ registry: "x", profiles: 3 })).toEqual({ profiles: [] });
  });

  test("model campuran string dan objek", () => {
    const view = parseRegistryView({
      profiles: [{ id: "p", name: "P", models: ["m1", { id: "m2", label: "Dua" }] }],
    });

    expect(view.profiles[0]?.models).toEqual([{ id: "m1" }, { id: "m2", label: "Dua" }]);
  });

  test("profil tanpa id dibuang, model rusak diabaikan", () => {
    const view = parseRegistryView({
      profiles: [
        { name: "Tanpa id", models: [] },
        { id: "", name: "Kosong" },
        { id: "ok", name: "Ok", models: ["", 42, { label: "tanpa id" }, "m"] },
      ],
    });

    expect(view.profiles).toHaveLength(1);
    expect(view.profiles[0]?.id).toBe("ok");
    expect(view.profiles[0]?.models).toEqual([{ id: "m" }]);
  });

  test("nama hilang memakai id", () => {
    const view = parseRegistryView({ profiles: [{ id: "p" }] });
    expect(view.profiles[0]?.name).toBe("p");
    expect(view.profiles[0]?.models).toEqual([]);
    expect(view.profiles[0]?.hasKey).toBe(false);
    expect(view.profiles[0]?.baseUrl).toBeUndefined();
    expect(view.profiles[0]?.apiKeyEnv).toBeUndefined();
  });

  test("hasKey hanya untuk key tak kosong, baseUrl dan apiKeyEnv dipangkas", () => {
    const view = parseRegistryView({
      profiles: [
        { id: "a", apiKey: "***", baseUrl: "  https://x.test  ", apiKeyEnv: " KEYS " },
        { id: "b", apiKey: "" },
        { id: "c", apiKey: 42 },
        { id: "d", baseUrl: "   " },
      ],
    });

    expect(view.profiles[0]).toMatchObject({
      hasKey: true,
      baseUrl: "https://x.test",
      apiKeyEnv: "KEYS",
    });
    expect(view.profiles[1]?.hasKey).toBe(false);
    expect(view.profiles[2]?.hasKey).toBe(false);
    expect(view.profiles[3]?.baseUrl).toBeUndefined();
  });

  test("tidak pernah melempar untuk input aneh", () => {
    const getter = {
      get profiles(): unknown {
        throw new Error("boom");
      },
    };
    expect(() => parseRegistryView(getter)).not.toThrow();
    expect(parseRegistryView(getter)).toEqual({ profiles: [] });
  });

  test("price terparse dengan benar", () => {
    const input = {
      profiles: [
        {
          id: "p",
          name: "P",
          models: [
            { id: "m1", price: { input: 0.5, output: 1.2 } },
            { id: "m2", price: { input: 0.3, output: 0.8, cacheRead: 0.1, cacheWrite: 0.15 } },
            { id: "m3", price: { input: -1, output: 1.2 } },
            { id: "m4", price: { input: 0.5, output: "invalid" } },
            { id: "m5", price: { input: 0.5 } },
          ],
        },
      ],
    };

    const result = parseRegistryView(input);
    expect(result.profiles[0]?.models).toHaveLength(5);
    expect(result.profiles[0]?.models[0]).toEqual({
      id: "m1",
      price: { input: 0.5, output: 1.2 },
    });
    expect(result.profiles[0]?.models[1]).toEqual({
      id: "m2",
      price: { input: 0.3, output: 0.8, cacheRead: 0.1, cacheWrite: 0.15 },
    });
    // Price tidak valid diabaikan
    expect(result.profiles[0]?.models[2]).toEqual({ id: "m3" });
    expect(result.profiles[0]?.models[3]).toEqual({ id: "m4" });
    expect(result.profiles[0]?.models[4]).toEqual({ id: "m5" });
  });
});
