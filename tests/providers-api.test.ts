import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { loadRegistry } from "../src/server/provider-store";

const ENV = {
  JEJAK_API_KEY: "sk-env-rahasia",
  JEJAK_MODEL: "env-model",
};

let dir: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-providers-api-"));
  providersFile = join(dir, "providers.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function app(options: { fetch?: typeof fetch } = {}) {
  return createApp({ providersPath: providersFile, env: ENV, fetch: options.fetch });
}

function request(
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
  options: { fetch?: typeof fetch } = {},
) {
  const headers: Record<string, string> = { host: "127.0.0.1:3000", ...init.headers };
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }
  return app(options).handle(new Request(`http://127.0.0.1:3000${path}`, { method, headers, body }));
}

async function readFileText(): Promise<string> {
  return readFile(providersFile, "utf8");
}

describe("GET /api/providers", () => {
  test("tanpa berkas memakai profil default dari env", async () => {
    const res = await request("GET", "/api/providers");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { registry: { profiles: Array<Record<string, unknown>> } };
    expect(data.registry.profiles).toHaveLength(1);
    expect(data.registry.profiles[0]?.id).toBe("default");
    expect(data.registry.profiles[0]?.defaultModel).toBe("env-model");
    expect(data.registry.profiles[0]?.apiKey).toBe("***");
  });
});

describe("PUT /api/providers", () => {
  const twoProfiles = {
    profiles: [
      { id: "alpha", name: "Alpha", baseUrl: "https://alpha.test", apiKey: "sk-alpha-rahasia", models: [{ id: "m1" }] },
      { id: "beta", name: "Beta", apiKey: "sk-beta-rahasia", models: ["m2"] },
    ],
    activeProfileId: "alpha",
  };

  test("menyimpan dua profil dan respons tersamar", async () => {
    const res = await request("PUT", "/api/providers", { body: twoProfiles });
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).not.toContain("sk-alpha-rahasia");
    expect(text).not.toContain("sk-beta-rahasia");
    const data = JSON.parse(text) as { registry: { profiles: Array<Record<string, unknown>> } };
    expect(data.registry.profiles.map((profile) => profile.id)).toEqual(["alpha", "beta"]);
    expect(data.registry.profiles[0]?.apiKey).toBe("***");

    const getRes = await request("GET", "/api/providers");
    const getText = await getRes.text();
    expect(getText).not.toContain("sk-alpha-rahasia");
    expect(getText).not.toContain("sk-beta-rahasia");
    const getData = JSON.parse(getText) as { registry: { profiles: Array<Record<string, unknown>> } };
    expect(getData.registry.profiles.map((profile) => profile.id)).toEqual(["alpha", "beta"]);

    const stored = await loadRegistry(providersFile, {});
    expect(stored.profiles.find((profile) => profile.id === "alpha")?.apiKey).toBe("sk-alpha-rahasia");
    expect(stored.profiles.find((profile) => profile.id === "beta")?.apiKey).toBe("sk-beta-rahasia");
  });

  test("apiKey *** mempertahankan key lama", async () => {
    await request("PUT", "/api/providers", { body: twoProfiles });

    const update = {
      profiles: [
        { id: "alpha", name: "Alpha Baru", baseUrl: "https://alpha.test", apiKey: "***", models: [{ id: "m1" }] },
        { id: "beta", name: "Beta", apiKey: "***", models: ["m2"] },
      ],
    };
    const res = await request("PUT", "/api/providers", { body: update });
    expect(res.status).toBe(200);

    const stored = await loadRegistry(providersFile, {});
    expect(stored.profiles.find((profile) => profile.id === "alpha")?.name).toBe("Alpha Baru");
    expect(stored.profiles.find((profile) => profile.id === "alpha")?.apiKey).toBe("sk-alpha-rahasia");
    expect(stored.profiles.find((profile) => profile.id === "beta")?.apiKey).toBe("sk-beta-rahasia");
  });

  test("apiKeyEnv tidak menulis key env ke berkas", async () => {
    const res = await request("PUT", "/api/providers", {
      body: {
        profiles: [
          { id: "gamma", name: "Gamma", apiKeyEnv: "JEJAK_API_KEY", models: [{ id: "m1" }] },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(await readFileText()).not.toContain("sk-env-rahasia");

    const stored = await loadRegistry(providersFile, {});
    expect(stored.profiles[0]?.apiKeyEnv).toBe("JEJAK_API_KEY");
  });

  test("registry tidak valid ditolak dan berkas tidak berubah", async () => {
    await request("PUT", "/api/providers", { body: twoProfiles });
    const before = await readFileText();

    const res = await request("PUT", "/api/providers", {
      body: { profiles: [{ id: "DUPLIKAT", name: "", models: [] }] },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(typeof data.error).toBe("string");
    expect(data.error).not.toContain("sk-alpha-rahasia");
    expect(await readFileText()).toBe(before);
  });

  test("body bukan JSON valid ditolak 400", async () => {
    const res = await app().handle(
      new Request("http://127.0.0.1:3000/api/providers", {
        method: "PUT",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: "{bukan json",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/providers/active", () => {
  test("mengubah profil aktif dan id tak ada ditolak", async () => {
    await request("PUT", "/api/providers", {
      body: {
        profiles: [
          { id: "alpha", name: "Alpha", models: [] },
          { id: "beta", name: "Beta", models: [] },
        ],
        activeProfileId: "alpha",
      },
    });

    const ok = await request("POST", "/api/providers/active", { body: { profileId: "beta" } });
    expect(ok.status).toBe(200);
    const data = (await ok.json()) as { registry: { activeProfileId: string } };
    expect(data.registry.activeProfileId).toBe("beta");

    const stored = await loadRegistry(providersFile, {});
    expect(stored.activeProfileId).toBe("beta");

    const bad = await request("POST", "/api/providers/active", { body: { profileId: "tidak-ada" } });
    expect(bad.status).toBe(400);
    const badData = (await bad.json()) as { error: string };
    expect(typeof badData.error).toBe("string");
  });

  test("body salah ditolak 400", async () => {
    const res = await request("POST", "/api/providers/active", { body: { profileId: 42 } });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/providers/resolve", () => {
  beforeEach(async () => {
    await request("PUT", "/api/providers", {
      body: {
        profiles: [
          {
            id: "alpha",
            name: "Alpha",
            baseUrl: "https://alpha.test",
            apiKey: "sk-alpha-rahasia",
            models: [{ id: "m1" }, { id: "m2" }],
            defaultModel: "m1",
          },
        ],
        activeProfileId: "alpha",
      },
    });
  });

  test("mengembalikan apiKey tersamar", async () => {
    const res = await request("GET", "/api/providers/resolve?model=m1");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-alpha-rahasia");
    const data = JSON.parse(text) as { resolved: Record<string, unknown> };
    expect(data.resolved.profileId).toBe("alpha");
    expect(data.resolved.apiKey).toBe("***");
    expect(data.resolved.model).toBe("m1");
  });

  test("model di luar daftar ditolak 400", async () => {
    const res = await request("GET", "/api/providers/resolve?model=tidak-ada");
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(typeof data.error).toBe("string");
  });
});

describe("POST /api/providers/test", () => {
  const twoProfiles = {
    profiles: [
      {
        id: "alpha",
        name: "Alpha",
        baseUrl: "https://alpha.test",
        apiKey: "sk-alpha-rahasia",
        models: [{ id: "m1" }],
        defaultModel: "m1",
      },
      {
        id: "beta",
        name: "Beta",
        baseUrl: "https://beta.test/api/",
        apiKey: "sk-beta-rahasia",
        models: [{ id: "m2" }],
        defaultModel: "m2",
      },
    ],
    activeProfileId: "alpha",
  };

  interface FetchCall {
    url: string;
    init: RequestInit;
  }

  function fakeFetch(payload: unknown) {
    const calls: FetchCall[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { impl, calls };
  }

  const toolUsePayload = {
    content: [{ type: "tool_use", name: "echo", input: { text: "ping" } }],
  };

  test("memakai profil aktif dan hasil memuat toolCalling", async () => {
    await request("PUT", "/api/providers", { body: twoProfiles });
    const { impl, calls } = fakeFetch(toolUsePayload);

    const res = await request("POST", "/api/providers/test", { body: {} }, { fetch: impl });
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).not.toContain("sk-alpha-rahasia");
    expect(text).not.toContain("sk-beta-rahasia");
    const data = JSON.parse(text) as {
      result: { ok: boolean; toolCalling: string; model?: string; status?: number };
    };
    expect(data.result.ok).toBe(true);
    expect(data.result.toolCalling).toBe("ok");
    expect(data.result.model).toBe("m1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://alpha.test/v1/messages");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-alpha-rahasia");
  });

  test("profil lain memakai baseUrl dan key profil itu", async () => {
    await request("PUT", "/api/providers", { body: twoProfiles });
    const { impl, calls } = fakeFetch(toolUsePayload);

    const res = await request(
      "POST",
      "/api/providers/test",
      { body: { profileId: "beta" } },
      { fetch: impl },
    );
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://beta.test/api/v1/messages");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-beta-rahasia");
  });

  test("model di luar daftar ditolak 400", async () => {
    await request("PUT", "/api/providers", { body: twoProfiles });
    const { impl, calls } = fakeFetch(toolUsePayload);

    const res = await request(
      "POST",
      "/api/providers/test",
      { body: { model: "tidak-ada" } },
      { fetch: impl },
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("body bukan objek ditolak 400", async () => {
    await request("PUT", "/api/providers", { body: twoProfiles });

    const res = await request("POST", "/api/providers/test", { body: ["alpha"] });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(typeof data.error).toBe("string");
  });

  test("body kosong dianggap objek kosong", async () => {
    await request("PUT", "/api/providers", { body: twoProfiles });
    const { impl } = fakeFetch(toolUsePayload);

    const res = await app({ fetch: impl }).handle(
      new Request("http://127.0.0.1:3000/api/providers/test", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("respons tidak memuat key asli", async () => {
    await request("PUT", "/api/providers", { body: twoProfiles });
    const { impl } = fakeFetch({ content: [{ type: "tool_use", input: { text: "sk-alpha-rahasia" } }] });

    const res = await request("POST", "/api/providers/test", { body: {} }, { fetch: impl });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-alpha-rahasia");
    expect(text).not.toContain("sk-beta-rahasia");
  });

  test("Host evil.test ditolak 403", async () => {
    const res = await request(
      "POST",
      "/api/providers/test",
      { body: {}, headers: { host: "evil.test" } },
      { fetch: fakeFetch(toolUsePayload).impl },
    );
    expect(res.status).toBe(403);
  });
});

describe("guard pada API provider", () => {
  test("Host evil.test ditolak 403", async () => {
    const res = await request("GET", "/api/providers", { headers: { host: "evil.test" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "host tidak diizinkan" });
  });

  test("PUT tanpa content-type json ditolak 415", async () => {
    const res = await app().handle(
      new Request("http://127.0.0.1:3000/api/providers", {
        method: "PUT",
        headers: { host: "127.0.0.1:3000" },
        body: JSON.stringify({ profiles: [] }),
      }),
    );
    expect(res.status).toBe(415);
  });
});
