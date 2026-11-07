import { describe, expect, test } from "bun:test";
import type { RegistryView } from "../src/client/lib/registry-view";
import {
  addProfile,
  isDirty,
  newProfileDraft,
  removeProfile,
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
      name: "Profil baru",
      baseUrl: "",
      keyMode: "none",
      apiKeyEnv: "",
      apiKey: "",
      modelsText: "",
      modelLabels: {},
      isNew: true,
    });
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
