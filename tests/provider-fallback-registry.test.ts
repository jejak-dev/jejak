import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import {
  fallbackSelection,
  parseRegistry,
  redactRegistry,
  serializeRegistry,
  validateRegistry,
  type ProviderRegistry,
} from "../src/server/provider";
import { loadRegistry } from "../src/server/provider-store";

const WITH_FALLBACK: ProviderRegistry = {
  activeProfileId: "alpha",
  profiles: [
    {
      id: "alpha",
      name: "Alpha",
      models: [{ id: "m1" }],
      fallbackProfileId: "beta",
    },
    { id: "beta", name: "Beta", models: [{ id: "m2" }], defaultModel: "m2" },
  ],
};

describe("fallbackProfileId di registry", () => {
  test("parseRegistry membawa fallbackProfileId", () => {
    const registry = parseRegistry({
      profiles: [
        { id: "alpha", name: "Alpha", models: [], fallbackProfileId: "beta" },
        { id: "beta", name: "Beta", models: [] },
      ],
    });
    expect(registry.profiles[0]?.fallbackProfileId).toBe("beta");
    expect(registry.profiles[1]?.fallbackProfileId).toBeUndefined();
  });

  test("serializeRegistry round-trip membawa fallbackProfileId", () => {
    const parsed = parseRegistry(serializeRegistry(WITH_FALLBACK));
    expect(parsed.profiles[0]?.fallbackProfileId).toBe("beta");
    expect(parsed.profiles[1]?.fallbackProfileId).toBeUndefined();
  });

  test("redactRegistry membawa fallbackProfileId (bukan rahasia)", () => {
    const redacted = redactRegistry(WITH_FALLBACK) as {
      profiles: Array<Record<string, unknown>>;
    };
    expect(redacted.profiles[0]?.fallbackProfileId).toBe("beta");
  });

  test("validateRegistry menerima fallback yang valid", () => {
    expect(validateRegistry(WITH_FALLBACK)).toEqual([]);
  });

  test("validateRegistry menolak profil cadangan yang tidak ada", () => {
    const errors = validateRegistry({
      profiles: [{ id: "alpha", name: "Alpha", models: [], fallbackProfileId: "hilang" }],
    });
    expect(errors.some((error) => error.includes("hilang") && error.includes("tidak ditemukan"))).toBe(
      true,
    );
  });

  test("validateRegistry menolak cadangan diri sendiri", () => {
    const errors = validateRegistry({
      profiles: [{ id: "alpha", name: "Alpha", models: [], fallbackProfileId: "alpha" }],
    });
    expect(errors.some((error) => error.includes("dirinya sendiri"))).toBe(true);
  });

  test("validateRegistry menolak rantai fallback", () => {
    const errors = validateRegistry({
      profiles: [
        { id: "alpha", name: "Alpha", models: [], fallbackProfileId: "beta" },
        { id: "beta", name: "Beta", models: [], fallbackProfileId: "gamma" },
        { id: "gamma", name: "Gamma", models: [] },
      ],
    });
    expect(errors.some((error) => error.includes("tidak boleh memiliki fallbackProfileId"))).toBe(
      true,
    );
  });

  test("fallbackSelection memakai model default profil cadangan", () => {
    expect(fallbackSelection(WITH_FALLBACK, "alpha")).toEqual({ profileId: "beta" });
    expect(fallbackSelection(WITH_FALLBACK, "beta")).toBeUndefined();
    expect(fallbackSelection(WITH_FALLBACK, "tidak-ada")).toBeUndefined();
  });
});

describe("rute provider dan fallbackProfileId", () => {
  let dir: string;
  let providersFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jejak-fallback-registry-"));
    providersFile = join(dir, "providers.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function request(method: string, path: string, body?: unknown): Promise<Response> {
    const app = createApp({ providersPath: providersFile, env: {} });
    const headers: Record<string, string> = { host: "127.0.0.1:3000" };
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined) headers["content-type"] = "application/json";
    return app.handle(
      new Request(`http://127.0.0.1:3000${path}`, {
        method,
        headers,
        ...(serialized === undefined ? {} : { body: serialized }),
      }),
    );
  }

  test("PUT menyimpan fallbackProfileId dan GET mengembalikannya", async () => {
    const payload = {
      profiles: [
        { id: "alpha", name: "Alpha", apiKey: "sk-alpha", models: [], fallbackProfileId: "beta" },
        { id: "beta", name: "Beta", apiKey: "sk-beta", models: [] },
      ],
      activeProfileId: "alpha",
    };
    const put = await request("PUT", "/api/providers", payload);
    expect(put.status).toBe(200);

    const get = await request("GET", "/api/providers");
    const data = (await get.json()) as { registry: { profiles: Array<Record<string, unknown>> } };
    expect(data.registry.profiles[0]?.fallbackProfileId).toBe("beta");

    const stored = await loadRegistry(providersFile, {});
    expect(stored.profiles[0]?.fallbackProfileId).toBe("beta");
  });

  test("PUT menolak cadangan tidak ada / diri sendiri / rantai", async () => {
    const cases = [
      [
        { id: "alpha", name: "Alpha", models: [], fallbackProfileId: "hilang" },
      ],
      [{ id: "alpha", name: "Alpha", models: [], fallbackProfileId: "alpha" }],
      [
        { id: "alpha", name: "Alpha", models: [], fallbackProfileId: "beta" },
        { id: "beta", name: "Beta", models: [], fallbackProfileId: "alpha" },
      ],
    ];

    for (const profiles of cases) {
      const res = await request("PUT", "/api/providers", { profiles });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: string };
      expect(typeof data.error).toBe("string");
    }
  });

  test("PUT menolak field cadangan yang bukan string", async () => {
    const res = await request("PUT", "/api/providers", {
      profiles: [{ id: "alpha", name: "Alpha", models: [], fallbackProfileId: 42 }],
    });
    expect(res.status).toBe(400);
  });

  test("PUT menghapus profil yang masih jadi cadangan ditolak", async () => {
    await request("PUT", "/api/providers", {
      profiles: [
        { id: "alpha", name: "Alpha", models: [], fallbackProfileId: "beta" },
        { id: "beta", name: "Beta", models: [] },
      ],
    });

    // Profil beta dibuang tetapi alpha masih menunjuknya sebagai cadangan.
    const res = await request("PUT", "/api/providers", {
      profiles: [{ id: "alpha", name: "Alpha", models: [], fallbackProfileId: "beta" }],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("cadangan");

    const text = await readFile(providersFile, "utf8");
    expect(text).toContain("beta");
  });
});
