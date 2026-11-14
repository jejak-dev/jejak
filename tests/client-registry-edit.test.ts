import { describe, expect, test } from "bun:test";
import type { RegistryView } from "../src/client/lib/registry-view";
import {
  addProfile,
  fallbackName,
  fallbackOptions,
  fieldForMessage,
  isDirty,
  newProfileDraft,
  removeProfile,
  setFallbackProfile,
  toDraft,
  toPayload,
  updateProfile,
  validateDraft,
  type ProfileDraft,
  type RegistryDraft,
} from "../src/client/lib/registry-edit";

function fullView(): RegistryView {
  return {
    activeProfileId: "lokal",
    profiles: [
      {
        id: "lokal",
        name: "Lokal",
        baseUrl: "https://api.example.com",
        apiKeyEnv: "LOKAL_KEY",
        hasKey: true,
        models: [{ id: "m1", label: "Satu" }, { id: "m2" }],
        defaultModel: "m1",
        lightModel: "m2",
      },
      {
        id: "cadangan",
        name: "Cadangan",
        hasKey: false,
        models: [],
      },
    ],
  };
}

function validProfile(patch: Partial<ProfileDraft> = {}): ProfileDraft {
  return {
    id: "profil",
    name: "Profil",
    baseUrl: "",
    keyMode: "none",
    apiKeyEnv: "",
    apiKey: "",
    modelsText: "",
    modelLabels: {},
    modelPrices: {},
    modelWindows: {},
    defaultModel: "",
    lightModel: "",
    isNew: false,
    ...patch,
  };
}

function draftWith(profile: ProfileDraft): RegistryDraft {
  return { profiles: [profile] };
}

describe("toDraft", () => {
  test("memetakan keyMode env, keep, dan none", () => {
    const draft = toDraft(fullView());

    expect(draft.activeProfileId).toBe("lokal");
    expect(draft.profiles[0]).toEqual({
      id: "lokal",
      name: "Lokal",
      baseUrl: "https://api.example.com",
      keyMode: "env",
      apiKeyEnv: "LOKAL_KEY",
      apiKey: "",
      modelsText: "m1\nm2",
      modelLabels: { m1: "Satu" },
      modelPrices: {},
      modelWindows: {},
      defaultModel: "m1",
      lightModel: "m2",
      isNew: false,
    });
    expect(draft.profiles[1]?.keyMode).toBe("none");
  });

  test("hasKey tanpa env menjadi keep", () => {
    const draft = toDraft({
      profiles: [{ id: "p", name: "P", hasKey: true, models: [] }],
    });
    expect(draft.profiles[0]?.keyMode).toBe("keep");
  });

  test("view kosong menjadi draf kosong", () => {
    expect(toDraft({ profiles: [] })).toEqual({ profiles: [] });
  });
});

describe("newProfileDraft", () => {
  test("id baru unik berurutan", () => {
    expect(newProfileDraft([]).id).toBe("profil-1");
    expect(newProfileDraft(["profil-1"]).id).toBe("profil-2");
    expect(newProfileDraft(["profil-1", "profil-2"]).id).toBe("profil-3");
    expect(newProfileDraft(["profil-2"]).id).toBe("profil-1");
  });

  test("nilai awal", () => {
    const profile = newProfileDraft([]);
    expect(profile).toMatchObject({
      name: "Provider",
      baseUrl: "",
      keyMode: "none",
      apiKeyEnv: "",
      apiKey: "",
      modelsText: "",
      modelLabels: {},
      isNew: true,
    });
  });

  test("nama bawaan bernomor bila nama sama sudah ada", () => {
    expect(newProfileDraft([], ["Provider"]).name).toBe("Provider 2");
    expect(newProfileDraft([], ["Provider", "Provider 2"]).name).toBe("Provider 3");
    expect(newProfileDraft([], ["Provider 2"]).name).toBe("Provider");
    expect(newProfileDraft([], ["provider"]).name).toBe("Provider");
  });
});

describe("updateProfile", () => {
  test("mengubah profil yang cocok tanpa memutasi aslinya", () => {
    const draft = toDraft(fullView());
    const next = updateProfile(draft, "lokal", { name: "Baru", keyMode: "literal" });

    expect(next.profiles[0]?.name).toBe("Baru");
    expect(next.profiles[0]?.keyMode).toBe("literal");
    expect(draft.profiles[0]?.name).toBe("Lokal");
    expect(next.profiles[1]).toEqual(draft.profiles[1]);
  });
});

describe("addProfile", () => {
  test("menjadi aktif bila belum ada profil", () => {
    const profile = newProfileDraft([]);
    const next = addProfile({ profiles: [] }, profile);
    expect(next.profiles).toHaveLength(1);
    expect(next.activeProfileId).toBe(profile.id);
  });

  test("tidak mengubah profil aktif yang sudah ada", () => {
    const draft: RegistryDraft = {
      activeProfileId: "lokal",
      profiles: [validProfile({ id: "lokal" })],
    };
    const next = addProfile(draft, newProfileDraft(["lokal"]));
    expect(next.activeProfileId).toBe("lokal");
    expect(next.profiles).toHaveLength(2);
  });
});

describe("removeProfile", () => {
  test("menghapus profil aktif memindahkan aktif ke profil pertama sisa", () => {
    const draft = toDraft(fullView());
    const next = removeProfile(draft, "lokal");

    expect(next.profiles.map((profile) => profile.id)).toEqual(["cadangan"]);
    expect(next.activeProfileId).toBe("cadangan");
  });

  test("menghapus satu-satunya profil menghapus aktif", () => {
    const next = removeProfile(draftWith(validProfile({ id: "solo" })), "solo");
    expect(next.profiles).toEqual([]);
    expect(next.activeProfileId).toBeUndefined();
  });

  test("menghapus profil lain mempertahankan aktif", () => {
    const draft = toDraft(fullView());
    const next = removeProfile(draft, "cadangan");
    expect(next.activeProfileId).toBe("lokal");
  });
});

describe("validateDraft", () => {
  test("draf valid tidak menghasilkan pesan", () => {
    expect(validateDraft(toDraft(fullView()))).toEqual({});
  });

  test("minimal satu profil", () => {
    expect(validateDraft({ profiles: [] })).toEqual({ _: ["Minimal satu profil"] });
  });

  test("id tidak valid", () => {
    const errors = validateDraft(draftWith(validProfile({ id: "Huruf_Besar" })));
    expect(errors["Huruf_Besar"]).toContain(
      "ID hanya boleh berisi huruf kecil, angka, dan tanda hubung.",
    );
  });

  test("id duplikat", () => {
    const errors = validateDraft({
      profiles: [validProfile({ id: "sama" }), validProfile({ id: "sama" })],
    });
    expect(errors.sama).toContain("ID sudah dipakai profil lain.");
  });

  test("nama kosong", () => {
    const errors = validateDraft(draftWith(validProfile({ name: "   " })));
    expect(errors.profil).toContain("Nama tidak boleh kosong.");
  });

  test("baseUrl bukan URL http atau https", () => {
    for (const baseUrl of ["bukan url", "ftp://contoh.test", "mailto:a@b.test"]) {
      const errors = validateDraft(draftWith(validProfile({ baseUrl })));
      expect(errors.profil).toContain("Base URL harus URL http atau https yang valid.");
    }
  });

  test("baseUrl kosong atau valid diterima", () => {
    expect(validateDraft(draftWith(validProfile({ baseUrl: "" })))).toEqual({});
    expect(
      validateDraft(draftWith(validProfile({ baseUrl: "http://localhost:8080" }))),
    ).toEqual({});
  });

  test("keyMode env dengan nama variabel tidak valid", () => {
    for (const apiKeyEnv of ["", "1ANGKA", "ADA-SPASI", "spasi di tengah"]) {
      const errors = validateDraft(
        draftWith(validProfile({ keyMode: "env", apiKeyEnv })),
      );
      expect(errors.profil).toContain("Nama variabel env tidak valid.");
    }
  });

  test("keyMode env dengan nama valid diterima", () => {
    expect(
      validateDraft(draftWith(validProfile({ keyMode: "env", apiKeyEnv: "_KUNCI1" }))),
    ).toEqual({});
  });

  test("keyMode literal dengan key kosong", () => {
    const errors = validateDraft(
      draftWith(validProfile({ keyMode: "literal", apiKey: "  " })),
    );
    expect(errors.profil).toContain("API key tidak boleh kosong.");
  });

  test("keyMode literal dengan key terisi diterima", () => {
    expect(
      validateDraft(draftWith(validProfile({ keyMode: "literal", apiKey: "rahasia" }))),
    ).toEqual({});
  });

  test("baris model kosong di tengah daftar", () => {
    const errors = validateDraft(draftWith(validProfile({ modelsText: "m1\n\nm2" })));
    expect(errors.profil).toContain("Model tidak boleh kosong.");
  });

  test("baris kosong di akhir daftar diabaikan", () => {
    expect(validateDraft(draftWith(validProfile({ modelsText: "m1\n\n" })))).toEqual({});
  });

  test("model duplikat", () => {
    const errors = validateDraft(draftWith(validProfile({ modelsText: "m1\nm1" })));
    expect(errors.profil).toContain('Model "m1" ditulis lebih dari sekali.');
  });

  test("defaultModel dan lightModel harus ada di daftar", () => {
    const errors = validateDraft(
      draftWith(validProfile({ modelsText: "m1", defaultModel: "m2", lightModel: "m3" })),
    );
    expect(errors.profil).toContain('Model utama "m2" tidak ada di daftar model.');
    expect(errors.profil).toContain('Model ringan "m3" tidak ada di daftar model.');
  });

  test("defaultModel dan lightModel bebas bila daftar model kosong", () => {
    expect(
      validateDraft(draftWith(validProfile({ defaultModel: "bebas", lightModel: "bebas2" }))),
    ).toEqual({});
  });

  test("beberapa masalah pada satu profil dikumpulkan", () => {
    const errors = validateDraft(
      draftWith(validProfile({ id: "X", name: "", keyMode: "literal", apiKey: "" })),
    );
    expect(errors.X?.length).toBe(3);
  });
});

describe("toPayload", () => {
  test("round-trip dari view lengkap", () => {
    expect(toPayload(toDraft(fullView()))).toEqual({
      activeProfileId: "lokal",
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          models: [{ id: "m1", label: "Satu" }, "m2"],
          baseUrl: "https://api.example.com",
          apiKeyEnv: "LOKAL_KEY",
          defaultModel: "m1",
          lightModel: "m2",
        },
        {
          id: "cadangan",
          name: "Cadangan",
          models: [],
        },
      ],
    });
  });

  test("label model dipertahankan saat round-trip", () => {
    const payload = toPayload(toDraft(fullView())) as {
      profiles: { models: unknown[] }[];
    };
    expect(payload.profiles[0]?.models).toEqual([{ id: "m1", label: "Satu" }, "m2"]);
  });

  test("menghapus baris model menghapus labelnya dari payload", () => {
    const draft = toDraft(fullView());
    const withoutLabelModel = updateProfile(draft, "lokal", { modelsText: "m2" });
    const payload = toPayload(withoutLabelModel) as {
      profiles: { models: unknown[] }[];
    };
    expect(payload.profiles[0]?.models).toEqual(["m2"]);
  });

  test("model tanpa label tetap berupa string", () => {
    const payload = toPayload({
      profiles: [validProfile({ modelsText: "m1", modelLabels: { m2: "Dua" } })],
    }) as { profiles: { models: unknown[] }[] };
    expect(payload.profiles[0]?.models).toEqual(["m1"]);
  });

  test("profil dengan key tersimpan mengirim ***", () => {
    const payload = toPayload({
      profiles: [validProfile({ keyMode: "keep", apiKey: "jangan-dikirim" })],
    }) as { profiles: Record<string, unknown>[] };
    expect(payload.profiles[0]?.apiKey).toBe("***");
    expect(payload.profiles[0]?.apiKeyEnv).toBeUndefined();
  });

  test("mode literal mengirim key apa adanya", () => {
    const payload = toPayload({
      profiles: [validProfile({ keyMode: "literal", apiKey: "kunci-baru" })],
    }) as { profiles: Record<string, unknown>[] };
    expect(payload.profiles[0]?.apiKey).toBe("kunci-baru");
    expect(payload.profiles[0]?.apiKeyEnv).toBeUndefined();
  });

  test("mode none tidak mengirim key maupun env", () => {
    const payload = toPayload({
      profiles: [validProfile({ keyMode: "none", apiKey: "abaikan", apiKeyEnv: "ABAikan" })],
    }) as { profiles: Record<string, unknown>[] };
    expect(payload.profiles[0]?.apiKey).toBeUndefined();
    expect(payload.profiles[0]?.apiKeyEnv).toBeUndefined();
  });

  test("key literal tidak pernah dikirim bila keyMode bukan literal", () => {
    for (const keyMode of ["env", "keep", "none"] as const) {
      const payload = toPayload({
        profiles: [
          validProfile({
            keyMode,
            apiKey: "rahasia-sekali",
            apiKeyEnv: keyMode === "env" ? "KUNCI" : "",
          }),
        ],
      });
      expect(JSON.stringify(payload)).not.toContain("rahasia-sekali");
    }
  });

  test("modelsText dipecah, dipangkas, dan baris kosong dibuang", () => {
    const payload = toPayload({
      profiles: [validProfile({ modelsText: "  m1  \n\n m2\n" })],
    }) as { profiles: { models: string[] }[] };
    expect(payload.profiles[0]?.models).toEqual(["m1", "m2"]);
  });

  test("string kosong dihilangkan dari payload", () => {
    const payload = toPayload({
      profiles: [
        validProfile({ baseUrl: "  ", defaultModel: "", lightModel: "  " }),
      ],
    }) as { profiles: Record<string, unknown>[] };
    expect(payload.profiles[0]).toEqual({
      id: "profil",
      name: "Profil",
      models: [],
    });
  });

  test("activeProfileId disertakan bila ada", () => {
    const payload = toPayload({
      activeProfileId: "profil",
      profiles: [validProfile()],
    }) as Record<string, unknown>;
    expect(payload.activeProfileId).toBe("profil");
  });
});

describe("isDirty", () => {
  test("draf identik tidak kotor", () => {
    const original = toDraft(fullView());
    expect(isDirty(original, toDraft(fullView()))).toBe(false);
  });

  test("perubahan field, profil, dan aktif terdeteksi", () => {
    const original = toDraft(fullView());

    expect(isDirty(original, updateProfile(original, "lokal", { name: "Lain" }))).toBe(true);
    expect(
      isDirty(original, addProfile(original, newProfileDraft(original.profiles.map((p) => p.id)))),
    ).toBe(true);
    expect(isDirty(original, removeProfile(original, "cadangan"))).toBe(true);
    expect(isDirty(original, { ...original, activeProfileId: "cadangan" })).toBe(true);
  });

  test("perubahan key literal terdeteksi", () => {
    const original = toDraft(fullView());
    expect(isDirty(original, updateProfile(original, "lokal", { apiKey: "baru" }))).toBe(true);
  });
});

describe("tarif model", () => {
  const pricedView: RegistryView = {
    profiles: [
      {
        id: "p",
        name: "P",
        hasKey: false,
        models: [
          { id: "m1", price: { input: 0.5, output: 1.2, cacheRead: 0.1 } },
          { id: "m2" },
        ],
      },
    ],
  };

  test("toDraft memuat harga dari profil tersimpan", () => {
    const draft = toDraft(pricedView);
    expect(draft.profiles[0]?.modelPrices).toEqual({
      m1: { input: "0.5", output: "1.2", cacheRead: "0.1", cacheWrite: "" },
    });
  });

  test("payload memuat price hanya bila input dan output valid", () => {
    const draft = toDraft(pricedView);
    const payload = toPayload(draft) as { profiles: { models: unknown[] }[] };
    expect(payload.profiles[0]?.models).toEqual([
      { id: "m1", price: { input: 0.5, output: 1.2, cacheRead: 0.1 } },
      "m2",
    ]);
  });

  test("cache kosong tidak dikirim", () => {
    const draft = toDraft({
      profiles: [
        {
          id: "p",
          name: "P",
          hasKey: false,
          models: [{ id: "m1", price: { input: 1, output: 2 } }],
        },
      ],
    });
    const payload = toPayload(draft) as { profiles: { models: unknown[] }[] };
    expect(payload.profiles[0]?.models).toEqual([
      { id: "m1", price: { input: 1, output: 2 } },
    ]);
  });

  test("satu sisi terisi menghasilkan galat prices", () => {
    const errors = validateDraft(
      draftWith(
        validProfile({
          modelsText: "m1",
          modelPrices: { m1: { input: "0.5", output: "", cacheRead: "", cacheWrite: "" } },
        }),
      ),
    );
    expect(errors.profil?.some((message) => message.startsWith("Tarif "))).toBe(true);
  });

  test("angka negatif atau bukan angka menghasilkan galat", () => {
    for (const input of ["-1", "abc"]) {
      const errors = validateDraft(
        draftWith(
          validProfile({
            modelsText: "m1",
            modelPrices: { m1: { input, output: "1", cacheRead: "", cacheWrite: "" } },
          }),
        ),
      );
      expect(errors.profil?.some((message) => message.startsWith("Tarif "))).toBe(true);
    }
  });

  test("model dihapus membuang harganya", () => {
    const draft = toDraft(pricedView);
    const without = updateProfile(draft, "p", { modelsText: "m2" });
    const payload = toPayload(without) as { profiles: { models: unknown[] }[] };
    expect(payload.profiles[0]?.models).toEqual(["m2"]);
    expect(JSON.stringify(payload)).not.toContain("0.5");
  });

  test("round-trip edit tanpa mengubah harga mempertahankan harga", () => {
    const draft = toDraft(pricedView);
    const renamed = updateProfile(draft, "p", { name: "Baru" });
    const payload = toPayload(renamed) as { profiles: { models: unknown[] }[] };
    expect(payload.profiles[0]?.models).toEqual([
      { id: "m1", price: { input: 0.5, output: 1.2, cacheRead: 0.1 } },
      "m2",
    ]);
  });

  test("perubahan harga menandai draf kotor", () => {
    const original = toDraft(pricedView);
    const changed = updateProfile(original, "p", {
      modelPrices: {
        m1: { input: "0.5", output: "1.2", cacheRead: "0.1", cacheWrite: "9" },
      },
    });
    expect(isDirty(original, changed)).toBe(true);
  });
});

describe("profil cadangan", () => {
  const fallbackView: RegistryView = {
    profiles: [
      { id: "utama", name: "Utama", hasKey: false, models: [], fallbackProfileId: "cadangan" },
      { id: "cadangan", name: "Cadangan", hasKey: false, models: [] },
      { id: "lain", name: "Lain", hasKey: false, models: [], fallbackProfileId: "cadangan" },
    ],
  };

  test("toDraft membawa fallbackProfileId", () => {
    const draft = toDraft(fallbackView);
    expect(draft.profiles[0]?.fallbackProfileId).toBe("cadangan");
    expect(draft.profiles[1]?.fallbackProfileId).toBeUndefined();
  });

  test("toPayload mengirim fallbackProfileId yang diisi saja", () => {
    const payload = toPayload(toDraft(fallbackView)) as {
      profiles: Record<string, unknown>[];
    };
    expect(payload.profiles[0]?.fallbackProfileId).toBe("cadangan");
    expect(payload.profiles[1]?.fallbackProfileId).toBeUndefined();
  });

  test("opsi cadangan mengecualikan diri sendiri dan profil bercadangan", () => {
    const draft = toDraft(fallbackView);
    // utama dan lain sudah punya cadangan sendiri, jadi tidak bisa jadi cadangan cadangan.
    expect(fallbackOptions(draft, "cadangan")).toEqual([]);
    expect(fallbackOptions(draft, "utama").map((option) => option.id)).toEqual(["cadangan"]);
  });

  test("nama kosong memakai id pada opsi dan penanda", () => {
    const draft: RegistryDraft = {
      profiles: [validProfile({ id: "a", name: "" }), validProfile({ id: "b" })],
    };
    expect(fallbackOptions(draft, "b")).toEqual([{ id: "a", name: "a" }]);
    expect(fallbackName(draft, validProfile({ id: "b", fallbackProfileId: "a" }))).toBe("a");
  });

  test("setFallbackProfile menyetel dan menghapus cadangan", () => {
    const draft = toDraft(fallbackView);
    const removed = setFallbackProfile(draft, "utama", null);
    expect(removed.profiles[0]?.fallbackProfileId).toBe("");
    const set = setFallbackProfile(draft, "cadangan", "lain");
    expect(set.profiles[1]?.fallbackProfileId).toBe("lain");
  });

  test("fallbackName mengembalikan nama atau id tak dikenal", () => {
    const draft = toDraft(fallbackView);
    expect(fallbackName(draft, validProfile({ fallbackProfileId: "cadangan" }))).toBe("Cadangan");
    expect(fallbackName(draft, validProfile({ fallbackProfileId: "hilang" }))).toBe("hilang");
    expect(fallbackName(draft, validProfile())).toBeUndefined();
  });

  test("validateDraft menerima cadangan yang valid", () => {
    expect(validateDraft(toDraft(fallbackView))).toEqual({});
  });

  test("validateDraft menolak cadangan diri sendiri, tak dikenal, dan bercadangan", () => {
    const draft: RegistryDraft = {
      profiles: [
        validProfile({ id: "a", fallbackProfileId: "a" }),
        validProfile({ id: "b", fallbackProfileId: "hilang" }),
        validProfile({ id: "c" }),
        validProfile({ id: "d", fallbackProfileId: "c" }),
      ],
    };
    const errors = validateDraft(draft);
    expect(errors.a).toContain("Profil cadangan tidak boleh dirinya sendiri.");
    expect(errors.b).toContain('Profil cadangan "hilang" tidak ditemukan.');
    expect(errors.d).toBeUndefined();
    expect(validateDraft({
      profiles: [
        validProfile({ id: "a" }),
        validProfile({ id: "b", fallbackProfileId: "a" }),
        validProfile({ id: "c", fallbackProfileId: "b" }),
      ],
    }).c).toContain('Profil cadangan "b" tidak boleh memiliki cadangan sendiri.');
  });

  test("perubahan cadangan menandai draf kotor", () => {
    const original = toDraft(fallbackView);
    expect(isDirty(original, setFallbackProfile(original, "cadangan", "lain"))).toBe(true);
  });

  test("fieldForMessage memetakan galat cadangan ke field fallback", () => {
    expect(fieldForMessage('Profil cadangan "hilang" tidak ditemukan.')).toBe("fallback");
    expect(fieldForMessage('Profil cadangan "b" tidak boleh memiliki fallbackProfileId sendiri.')).toBe("fallback");
    expect(fieldForMessage("Nama tidak boleh kosong.")).toBe("name");
    expect(fieldForMessage("ID hanya boleh berisi huruf kecil.")).toBe("id");
    expect(fieldForMessage("Tarif model x: salah.")).toBe("prices");
    expect(fieldForMessage("lain sekali")).toBe("lain");
  });
});

describe("jendela konteks model", () => {
  test("dibaca dari tampilan, divalidasi, dan ikut payload", () => {
    const view = fullView();
    view.profiles[0]!.models = [{ id: "m1", contextWindow: 1000000 }, { id: "m2" }];
    const draft = toDraft(view);
    expect(draft.profiles[0]!.modelWindows).toEqual({ m1: "1000000" });
    const payload = toPayload(draft) as { profiles: Array<{ models: unknown[] }> };
    expect(payload.profiles[0]!.models[0]).toEqual({ id: "m1", contextWindow: 1000000 });
    expect(payload.profiles[0]!.models[1]).toBe("m2");

    const bad = validProfile({ modelsText: "m1", modelWindows: { m1: "abc" } });
    expect(JSON.stringify(validateDraft(draftWith(bad)))).toContain("Jendela konteks");
  });
});
