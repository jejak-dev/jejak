import { expect, test } from "bun:test";
import {
  parseRegistry,
  redactRegistry,
  redactResolved,
  registryFromEnv,
  resolveProvider,
  serializeRegistry,
  setActiveProfile,
  toSdkEnv,
  validateRegistry,
  type ProviderRegistry,
} from "../src/server/provider";

const TWO_PROFILES: ProviderRegistry = {
  activeProfileId: "deepseek",
  profiles: [
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.test/v1",
      apiKey: "deepseek-key",
      models: [{ id: "deepseek-chat", label: "DeepSeek Chat" }, { id: "deepseek-light" }],
      defaultModel: "deepseek-chat",
      lightModel: "deepseek-light",
    },
    {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.test",
      apiKey: "anthropic-key",
      models: [{ id: "claude-sonnet" }, { id: "claude-haiku" }],
      defaultModel: "claude-sonnet",
      lightModel: "claude-haiku",
    },
  ],
};

test("registryFromEnv memprioritaskan JEJAK_* atas ANTHROPIC_*", () => {
  expect(
    registryFromEnv({
      JEJAK_BASE_URL: "https://jejak.test/v1",
      ANTHROPIC_BASE_URL: "https://anthropic.test",
      JEJAK_API_KEY: "jejak-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      ANTHROPIC_AUTH_TOKEN: "auth-token",
      JEJAK_MODEL: "jejak-model",
      ANTHROPIC_MODEL: "anthropic-model",
      JEJAK_LIGHT_MODEL: "jejak-light",
      ANTHROPIC_SMALL_FAST_MODEL: "anthropic-light",
    }),
  ).toEqual({
    activeProfileId: "default",
    profiles: [
      {
        id: "default",
        name: "Default",
        baseUrl: "https://jejak.test/v1",
        apiKey: "jejak-key",
        models: [],
        defaultModel: "jejak-model",
        lightModel: "jejak-light",
      },
    ],
  });
});

test("registryFromEnv jatuh ke ANTHROPIC_* dan mengabaikan string kosong", () => {
  expect(
    registryFromEnv({
      JEJAK_BASE_URL: "   ",
      ANTHROPIC_BASE_URL: "https://anthropic.test",
      JEJAK_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "auth-token",
      ANTHROPIC_MODEL: "   ",
      JEJAK_LIGHT_MODEL: "  light-model  ",
    }),
  ).toEqual({
    activeProfileId: "default",
    profiles: [
      {
        id: "default",
        name: "Default",
        baseUrl: "https://anthropic.test",
        apiKey: "auth-token",
        models: [],
        lightModel: "light-model",
      },
    ],
  });
});

test("registryFromEnv tidak memuat properti yang tidak diset", () => {
  const registry = registryFromEnv({});
  const profile = registry.profiles[0]!;

  expect(registry.activeProfileId).toBe("default");
  expect(profile.models).toEqual([]);
  expect("baseUrl" in profile).toBe(false);
  expect("apiKey" in profile).toBe(false);
  expect("defaultModel" in profile).toBe(false);
  expect("lightModel" in profile).toBe(false);
});

test("registryFromEnv memangkas spasi di sekitar nilai", () => {
  const profile = registryFromEnv({
    JEJAK_BASE_URL: "  https://space.test/v1  ",
    JEJAK_API_KEY: "  secret  ",
    JEJAK_MODEL: "  model  ",
    JEJAK_LIGHT_MODEL: "  light  ",
  }).profiles[0]!;

  expect(profile.baseUrl).toBe("https://space.test/v1");
  expect(profile.apiKey).toBe("secret");
  expect(profile.defaultModel).toBe("model");
  expect(profile.lightModel).toBe("light");
});

test("parseRegistry membaca apiKeyEnv dari env dan menormalkan models string", () => {
  const registry = parseRegistry(
    {
      profiles: [
        {
          id: "proxy",
          name: "Proxy LiteLLM",
          apiKey: "literal-key",
          apiKeyEnv: "LITELLM_KEY",
          models: ["gpt-1", { id: "gpt-2", label: "GPT 2" }],
        },
      ],
    },
    { LITELLM_KEY: "  env-key  " },
  );

  expect(registry.activeProfileId).toBe("proxy");
  expect(registry.profiles[0]).toEqual({
    id: "proxy",
    name: "Proxy LiteLLM",
    apiKey: "env-key",
    apiKeyEnv: "LITELLM_KEY",
    models: [{ id: "gpt-1" }, { id: "gpt-2", label: "GPT 2" }],
  });
});

test("parseRegistry memakai apiKey literal bila apiKeyEnv tidak terisi", () => {
  const registry = parseRegistry(
    {
      activeProfileId: "proxy",
      profiles: [{ id: "proxy", name: "Proxy", apiKey: "literal-key", apiKeyEnv: "KOSONG" }],
    },
    {},
  );

  expect(registry.profiles[0]?.apiKey).toBe("literal-key");
  expect(registry.profiles[0]?.models).toEqual([]);
});

test("parseRegistry melempar untuk bentuk input yang salah", () => {
  expect(() => parseRegistry(null)).toThrow();
  expect(() => parseRegistry("bukan objek")).toThrow();
  expect(() => parseRegistry({ profiles: {} })).toThrow();
  expect(() => parseRegistry({ profiles: ["bukan objek"] })).toThrow();
  expect(() => parseRegistry({ profiles: [{ id: 1, name: "X" }] })).toThrow();
  expect(() => parseRegistry({ profiles: [{ id: "x", name: "X", models: "bukan array" }] })).toThrow();
  expect(() => parseRegistry({ profiles: [{ id: "x", name: "X" }], activeProfileId: 1 })).toThrow();
});

test("validateRegistry menerima registry valid dengan dua profil", () => {
  expect(validateRegistry(TWO_PROFILES)).toEqual([]);
});

test("validateRegistry menolak registry tanpa profil", () => {
  expect(validateRegistry({ profiles: [] })).toEqual([
    "Registry provider harus memiliki minimal satu profil.",
  ]);
});

test("validateRegistry menolak id tidak sesuai pola dan id duplikat", () => {
  const errors = validateRegistry({
    profiles: [
      { id: "Besar", name: "Besar", models: [] },
      { id: "ok", name: "Satu", models: [] },
      { id: "ok", name: "Dua", models: [] },
    ],
  });

  expect(errors.some((error) => error.includes("tidak valid"))).toBe(true);
  expect(errors.some((error) => error.includes("duplikat"))).toBe(true);
});

test("validateRegistry menolak nama kosong dan baseUrl tidak valid", () => {
  const errors = validateRegistry({
    profiles: [
      { id: "a", name: "   ", models: [], baseUrl: "bukan url" },
      { id: "b", name: "B", models: [], baseUrl: "ftp://x.test" },
    ],
  });

  expect(errors.some((error) => error.includes("nama profil"))).toBe(true);
  expect(errors.filter((error) => error.includes("baseUrl")).length).toBe(2);
});

test("validateRegistry menolak model kosong, duplikat, dan model default di luar daftar", () => {
  const errors = validateRegistry({
    profiles: [
      {
        id: "p",
        name: "P",
        models: [{ id: "m1" }, { id: "  " }, { id: "m2" }, { id: "m2" }],
        defaultModel: "m9",
        lightModel: "m8",
      },
    ],
  });

  expect(errors.some((error) => error.includes("id model kosong"))).toBe(true);
  expect(errors.some((error) => error.includes("duplikat: \"m2\""))).toBe(true);
  expect(errors.some((error) => error.includes("defaultModel"))).toBe(true);
  expect(errors.some((error) => error.includes("lightModel"))).toBe(true);
});

test("validateRegistry mengabaikan defaultModel bila daftar model kosong", () => {
  expect(
    validateRegistry({
      profiles: [{ id: "p", name: "P", models: [], defaultModel: "bebas", lightModel: "bebas" }],
    }),
  ).toEqual([]);
});

test("validateRegistry menolak activeProfileId yang tidak cocok", () => {
  const errors = validateRegistry({ ...TWO_PROFILES, activeProfileId: "tidak-ada" });
  expect(errors.some((error) => error.includes("activeProfileId"))).toBe(true);
});

test("setActiveProfile berpindah profil tanpa memutasi registry asal", () => {
  const updated = setActiveProfile(TWO_PROFILES, "anthropic");

  expect(updated.activeProfileId).toBe("anthropic");
  expect(TWO_PROFILES.activeProfileId).toBe("deepseek");
});

test("setActiveProfile melempar bila id tidak ada", () => {
  expect(() => setActiveProfile(TWO_PROFILES, "tidak-ada")).toThrow();
});

test("resolveProvider memakai profil aktif secara default", () => {
  expect(resolveProvider(TWO_PROFILES)).toEqual({
    profileId: "deepseek",
    baseUrl: "https://api.deepseek.test/v1",
    apiKey: "deepseek-key",
    model: "deepseek-chat",
    lightModel: "deepseek-light",
  });
});

test("resolveProvider menghormati override profileId per sesi dengan key berbeda", () => {
  const resolved = resolveProvider(TWO_PROFILES, { profileId: "anthropic" });

  expect(resolved.profileId).toBe("anthropic");
  expect(resolved.apiKey).toBe("anthropic-key");
  expect(resolved.model).toBe("claude-sonnet");
  expect(toSdkEnv(resolved).ANTHROPIC_API_KEY).toBe("anthropic-key");
});

test("resolveProvider menghormati override model yang valid", () => {
  const resolved = resolveProvider(TWO_PROFILES, { model: "deepseek-light", lightModel: "deepseek-chat" });

  expect(resolved.model).toBe("deepseek-light");
  expect(resolved.lightModel).toBe("deepseek-chat");
});

test("resolveProvider melempar untuk model di luar daftar profil", () => {
  expect(() => resolveProvider(TWO_PROFILES, { model: "tidak-ada" })).toThrow();
  expect(() => resolveProvider(TWO_PROFILES, { lightModel: "tidak-ada" })).toThrow();
});

test("resolveProvider membolehkan model bebas bila daftar model kosong", () => {
  const registry = registryFromEnv({ JEJAK_API_KEY: "k" });
  expect(resolveProvider(registry, { model: "model-bebas" }).model).toBe("model-bebas");
});

test("resolveProvider melempar untuk profil tidak ada atau registry kosong", () => {
  expect(() => resolveProvider(TWO_PROFILES, { profileId: "tidak-ada" })).toThrow();
  expect(() => resolveProvider({ profiles: [] })).toThrow();
});

test("resolveProvider tidak memuat properti yang tidak diset", () => {
  const resolved = resolveProvider({ profiles: [{ id: "x", name: "X", models: [] }] });

  expect(resolved).toEqual({ profileId: "x" });
});

test("toSdkEnv hanya memetakan field yang diset", () => {
  expect(
    toSdkEnv({
      profileId: "p",
      baseUrl: "https://x.test/v1",
      apiKey: "secret",
      model: "model",
      lightModel: "light",
    }),
  ).toEqual({
    ANTHROPIC_BASE_URL: "https://x.test/v1",
    ANTHROPIC_API_KEY: "secret",
    ANTHROPIC_MODEL: "model",
    ANTHROPIC_SMALL_FAST_MODEL: "light",
  });

  expect(toSdkEnv({ profileId: "p", model: "model" })).toEqual({ ANTHROPIC_MODEL: "model" });
  expect(toSdkEnv({ profileId: "p" })).toEqual({});
});

test("redactResolved menyamarkan apiKey dan userinfo baseUrl", () => {
  const apiKey = "super-secret-key";
  const redacted = redactResolved({
    profileId: "p",
    baseUrl: "https://user:pass@proxy.test/v1",
    apiKey,
    model: "model",
    lightModel: "light",
  });

  expect(redacted).toEqual({
    profileId: "p",
    baseUrl: "https://***@proxy.test/v1",
    apiKey: "***",
    model: "model",
    lightModel: "light",
  });

  const serialized = JSON.stringify(redacted);
  expect(serialized).not.toContain(apiKey);
  expect(serialized).not.toContain("pass");
  expect(serialized).not.toContain("user:");
});

test("redactResolved menyembunyikan baseUrl yang tidak valid", () => {
  const redacted = redactResolved({ profileId: "p", baseUrl: "bukan url rahasia" });

  expect(redacted.baseUrl).toBe("(tidak valid)");
  expect(JSON.stringify(redacted)).not.toContain("rahasia");
});

test("redactRegistry tidak pernah membocorkan key asli maupun userinfo", () => {
  const registry: ProviderRegistry = {
    activeProfileId: "proxy",
    profiles: [
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.test/v1",
        apiKey: "deepseek-secret",
        models: [{ id: "deepseek-chat" }],
        defaultModel: "deepseek-chat",
      },
      {
        id: "proxy",
        name: "Proxy",
        baseUrl: "https://user:pass@proxy.test/v1",
        apiKey: "proxy-secret",
        models: [],
      },
    ],
  };

  const serialized = JSON.stringify(redactRegistry(registry));

  expect(serialized).not.toContain("deepseek-secret");
  expect(serialized).not.toContain("proxy-secret");
  expect(serialized).not.toContain("pass");
  expect(redactRegistry(registry)).toEqual({
    activeProfileId: "proxy",
    profiles: [
      {
        id: "deepseek",
        name: "DeepSeek",
        models: [{ id: "deepseek-chat" }],
        baseUrl: "https://api.deepseek.test/v1",
        apiKey: "***",
        defaultModel: "deepseek-chat",
      },
      {
        id: "proxy",
        name: "Proxy",
        models: [],
        baseUrl: "https://***@proxy.test/v1",
        apiKey: "***",
      },
    ],
  });
});

test("redactRegistry menyembunyikan baseUrl tidak valid tanpa membocorkan teks mentah", () => {
  const serialized = JSON.stringify(
    redactRegistry({ profiles: [{ id: "x", name: "X", baseUrl: "kunci-rahasia", models: [] }] }),
  );

  expect(serialized).toContain("(tidak valid)");
  expect(serialized).not.toContain("kunci-rahasia");
});

test("serializeRegistry tidak menyimpan key yang berasal dari apiKeyEnv", () => {
  const registry = parseRegistry(
    {
      activeProfileId: "proxy",
      profiles: [
        {
          id: "proxy",
          name: "Proxy",
          baseUrl: "https://proxy.test/v1",
          apiKeyEnv: "PROXY_KEY",
          models: ["m1"],
          defaultModel: "m1",
        },
      ],
    },
    { PROXY_KEY: "rahasia-dari-env" },
  );

  const serialized = JSON.stringify(serializeRegistry(registry));

  expect(serialized).not.toContain("rahasia-dari-env");
  expect(serialized).not.toContain('"apiKey"');
  expect(JSON.parse(serialized)).toEqual({
    activeProfileId: "proxy",
    profiles: [
      {
        id: "proxy",
        name: "Proxy",
        baseUrl: "https://proxy.test/v1",
        apiKeyEnv: "PROXY_KEY",
        models: [{ id: "m1" }],
        defaultModel: "m1",
      },
    ],
  });
});

test("serializeRegistry tetap menyimpan apiKey literal tanpa apiKeyEnv", () => {
  const serialized = serializeRegistry({
    profiles: [{ id: "p", name: "P", apiKey: "literal-key", models: [] }],
  });

  expect(JSON.parse(JSON.stringify(serialized)).profiles[0].apiKey).toBe("literal-key");
});

test("parseRegistry(serializeRegistry(r)) melakukan round-trip setara", () => {
  const registry = parseRegistry(
    {
      activeProfileId: "anthropic",
      profiles: [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.test/v1",
          apiKeyEnv: "DEEPSEEK_KEY",
          models: [{ id: "deepseek-chat" }],
          lightModel: "deepseek-chat",
        },
        { id: "anthropic", name: "Anthropic", apiKey: "anthropic-key", models: [] },
      ],
    },
    { DEEPSEEK_KEY: "deepseek-env-key" },
  );

  const env = { DEEPSEEK_KEY: "deepseek-env-key" };
  expect(parseRegistry(serializeRegistry(registry), env)).toEqual(registry);
});

test("serializeRegistry tidak memutasi registry asal", () => {
  const registry: ProviderRegistry = {
    profiles: [{ id: "p", name: "P", apiKey: "literal-key", apiKeyEnv: "P_KEY", models: [] }],
  };

  serializeRegistry(registry);

  expect(registry.profiles[0]).toEqual({
    id: "p",
    name: "P",
    apiKey: "literal-key",
    apiKeyEnv: "P_KEY",
    models: [],
  });
});

test("validateRegistry memeriksa format apiKeyEnv", () => {
  expect(
    validateRegistry({ profiles: [{ id: "p", name: "P", apiKeyEnv: "1SALAH", models: [] }] }),
  ).toEqual([expect.stringContaining("apiKeyEnv")]);
  expect(
    validateRegistry({ profiles: [{ id: "p", name: "P", apiKeyEnv: "ADA SPASI", models: [] }] }),
  ).toEqual([expect.stringContaining("apiKeyEnv")]);
  expect(
    validateRegistry({ profiles: [{ id: "p", name: "P", apiKeyEnv: "_OK_123", models: [] }] }),
  ).toEqual([]);
});

test("validateRegistry menolak price yang tidak valid", () => {
  const errors = validateRegistry({
    profiles: [
      {
        id: "p",
        name: "P",
        models: [
          {
            id: "m1",
            price: { input: -1, output: 10 },
          },
        ],
      },
    ],
  });
  expect(errors).toContainEqual(expect.stringContaining("price.input"));
});

test("validateRegistry menerima price yang valid", () => {
  const errors = validateRegistry({
    profiles: [
      {
        id: "p",
        name: "P",
        models: [
          {
            id: "m1",
            price: { input: 10, output: 20, cacheRead: 5, cacheWrite: 15 },
          },
        ],
      },
    ],
  });
  expect(errors).toEqual([]);
});

test("parseRegistry mengabaikan price yang tidak valid", () => {
  const registry = parseRegistry({
    profiles: [
      {
        id: "p",
        name: "P",
        models: [
          {
            id: "m1",
            price: { input: -1, output: 10 },
          },
        ],
      },
    ],
  });

  expect(registry.profiles[0]?.models[0]?.price).toBeUndefined();
});

test("parseRegistry mempertahankan price yang valid", () => {
  const registry = parseRegistry({
    profiles: [
      {
        id: "p",
        name: "P",
        models: [
          {
            id: "m1",
            price: { input: 10, output: 20, cacheRead: 5, cacheWrite: 15 },
          },
        ],
      },
    ],
  });

  expect(registry.profiles[0]?.models[0]?.price).toEqual({
    input: 10,
    output: 20,
    cacheRead: 5,
    cacheWrite: 15,
  });
});

test("serializeRegistry menyertakan price yang valid", () => {
  const registry = parseRegistry({
    profiles: [
      {
        id: "p",
        name: "P",
        models: [
          {
            id: "m1",
            price: { input: 10, output: 20, cacheRead: 5, cacheWrite: 15 },
          },
        ],
      },
    ],
  });

  const serialized = serializeRegistry(registry);
  expect((serialized as any).profiles[0].models[0].price).toEqual({
    input: 10,
    output: 20,
    cacheRead: 5,
    cacheWrite: 15,
  });
});

test("resolveProvider mengisi price untuk model yang cocok", () => {
  const registry = {
    profiles: [
      {
        id: "p",
        name: "P",
        models: [
          {
            id: "m1",
            price: { input: 10, output: 20 },
          },
          {
            id: "m2",
            price: { input: 5, output: 15 },
          },
          { id: "m3" },
        ],
        defaultModel: "m1",
      },
    ],
  };

  const resolved = resolveProvider(registry, { model: "m1" });
  expect(resolved.price).toEqual({ input: 10, output: 20 });

  const resolved2 = resolveProvider(registry, { model: "m2" });
  expect(resolved2.price).toEqual({ input: 5, output: 15 });

  // Tanpa pilihan model, defaultModel (m1) yang dipakai.
  expect(resolveProvider(registry, {}).price).toEqual({ input: 10, output: 20 });

  // Model tanpa tarif tidak mengisi price.
  expect(resolveProvider(registry, { model: "m3" }).price).toBeUndefined();
});

test("redactResolved tidak memuat price", () => {
  const registry = {
    profiles: [
      {
        id: "p",
        name: "P",
        models: [
          {
            id: "m1",
            price: { input: 10, output: 20 },
          },
        ],
        defaultModel: "m1",
      },
    ],
  };

  const resolved = resolveProvider(registry, {});
  const redacted = redactResolved(resolved);
  expect(redacted.price).toBeUndefined();
});
