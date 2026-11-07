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
          models: [{ id: "m1", label: "Model satu" }, { id: "m2" }],
          defaultModel: "m1",
          lightModel: "m2",
        },
      ],
    };

    expect(parseRegistryView(input)).toEqual(input);
  });

  test("terbungkus registry", () => {
    const registry = {
      activeProfileId: "a",
      profiles: [{ id: "a", name: "A", models: [{ id: "m" }] }],
    };

    expect(parseRegistryView({ registry })).toEqual(registry);
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
});
