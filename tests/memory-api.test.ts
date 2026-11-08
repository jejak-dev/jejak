import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";

let dir: string;
let home: string;
let providersFile: string;
let store: FileMemoryStore | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-memory-api-"));
  home = join(dir, "home");
  providersFile = join(dir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://lokal.test",
          apiKey: "sk-rahasia",
          models: [{ id: "mock-model" }],
          defaultModel: "mock-model",
        },
      ],
      activeProfileId: "lokal",
    }),
    "utf8",
  );
});

afterEach(async () => {
  store?.close();
  store = undefined;
  await rm(dir, { recursive: true, force: true });
});

function makeApp(options: Partial<CreateAppOptions> = {}) {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true" },
    runner: createMockRunner(),
    ...options,
  });
}

function makeMemoryApp(): ReturnType<typeof createApp> {
  store = new FileMemoryStore({ dir: join(home, "memory") });
  const service = new MemoryService({ store, cwd: dir });
  return makeApp({ memory: service });
}

type App = ReturnType<typeof createApp>;

function req(
  app: App,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const headersOut: Record<string, string> = {
    host: "127.0.0.1:3000",
    "content-type": "application/json",
    ...headers,
  };
  const bodyOut = body === undefined ? undefined : JSON.stringify(body);
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: headersOut,
      body: bodyOut,
    }),
  );
}

interface ItemBody {
  item: {
    id: string;
    title: string;
    body: string;
    status: string;
    confidence: string;
    layer: string;
    projectKey: string | null;
    staleReason: string | null;
    decidedAt: string | null;
    origin: { kind: string; file?: string; fileSha256?: string };
  };
}

interface ListBody {
  items: ItemBody["item"][];
  counts: { proposed: number; active: number };
  problems: { file: string; reason: string }[];
}

describe("rute memory aktif", () => {
  test("POST membuat memory manual active/confirmed dengan 201", async () => {
    const app = makeMemoryApp();
    const res = await req(app, "POST", "/api/memory", {
      layer: "profile",
      title: "Gunakan bun test",
      body: "Jalankan bun test sebelum commit.",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ItemBody;
    expect(body.item.status).toBe("active");
    expect(body.item.confidence).toBe("confirmed");
    expect(body.item.layer).toBe("profile");
    expect(body.item.projectKey).toBeNull();
    expect(body.item.origin.kind).toBe("manual");
  });

  test("GET daftar mengembalikan items, counts, dan problems", async () => {
    const app = makeMemoryApp();
    await req(app, "POST", "/api/memory", { layer: "profile", title: "A", body: "a" });

    const res = await req(app, "GET", "/api/memory");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items).toHaveLength(1);
    expect(body.counts).toEqual({ proposed: 0, active: 1 });
    expect(body.problems).toEqual([]);
  });

  test("GET mendukung status, layer, project, q, dan limit", async () => {
    const app = makeMemoryApp();
    await req(app, "POST", "/api/memory", {
      layer: "project",
      projectKey: dir,
      title: "Perintah proyek",
      body: "bun test",
    });
    await req(app, "POST", "/api/memory", { layer: "profile", title: "Profil", body: "gaya" });

    const scoped = (await (await req(
      app,
      "GET",
      `/api/memory?project=${encodeURIComponent(dir)}`,
    )).json()) as ListBody;
    expect(scoped.items.map((item) => item.title).sort()).toEqual(["Perintah proyek", "Profil"]);

    const searched = (await (await req(app, "GET", "/api/memory?q=bun")).json()) as ListBody;
    expect(searched.items.map((item) => item.title)).toEqual(["Perintah proyek"]);

    const limited = (await (await req(app, "GET", "/api/memory?limit=1")).json()) as ListBody;
    expect(limited.items).toHaveLength(1);

    const byLayer = (await (await req(app, "GET", "/api/memory?layer=profile")).json()) as ListBody;
    expect(byLayer.items.map((item) => item.title)).toEqual(["Profil"]);
  });

  test("GET dengan status pending kosong karena belum ada usulan", async () => {
    const app = makeMemoryApp();
    await req(app, "POST", "/api/memory", { layer: "profile", title: "A", body: "a" });
    const body = (await (await req(app, "GET", "/api/memory?status=proposed")).json()) as ListBody;
    expect(body.items).toEqual([]);
    expect(body.counts.proposed).toBe(0);
  });

  test("PATCH mengubah judul atau isi", async () => {
    const app = makeMemoryApp();
    const created = (await (await req(app, "POST", "/api/memory", {
      layer: "profile",
      title: "Awal",
      body: "Isi awal",
    })).json()) as ItemBody;

    const res = await req(app, "PATCH", `/api/memory/${created.item.id}`, {
      title: "Diubah",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemBody;
    expect(body.item.title).toBe("Diubah");
    expect(body.item.body).toBe("Isi awal");
  });

  test("accept, reject, archive lewat rute", async () => {
    const store2 = new FileMemoryStore({ dir: join(home, "memory2") });
    const service = new MemoryService({ store: store2, cwd: dir });
    const app = makeApp({ memory: service });
    try {
      const proposed = await service.propose({ layer: "profile", title: "Usul", body: "Isi" });

      const accepted = (await (await req(app, "POST", `/api/memory/${proposed.id}/accept`)).json()) as ItemBody;
      expect(accepted.item.status).toBe("active");
      expect(accepted.item.confidence).toBe("confirmed");
      expect(accepted.item.decidedAt).not.toBeNull();

      const second = await service.propose({ layer: "profile", title: "Usul 2", body: "Isi" });
      const rejected = (await (await req(app, "POST", `/api/memory/${second.id}/reject`)).json()) as ItemBody;
      expect(rejected.item.status).toBe("rejected");

      const archived = (await (await req(app, "POST", `/api/memory/${proposed.id}/archive`)).json()) as ItemBody;
      expect(archived.item.status).toBe("archived");
    } finally {
      store2.close();
    }
  });

  test("DELETE menghapus dan 404 setelahnya", async () => {
    const app = makeMemoryApp();
    const created = (await (await req(app, "POST", "/api/memory", {
      layer: "profile",
      title: "A",
      body: "a",
    })).json()) as ItemBody;

    const removed = await req(app, "DELETE", `/api/memory/${created.item.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });

    const again = await req(app, "DELETE", `/api/memory/${created.item.id}`);
    expect(again.status).toBe(404);
    expect(await again.json()).toHaveProperty("error");
  });
});

describe("kode status dan galat", () => {
  const missing = "00000000-0000-4000-8000-000000000000";

  test("id tidak ada 404", async () => {
    const app = makeMemoryApp();
    for (const [method, path] of [
      ["PATCH", `/api/memory/${missing}`],
      ["POST", `/api/memory/${missing}/accept`],
      ["POST", `/api/memory/${missing}/reject`],
      ["POST", `/api/memory/${missing}/archive`],
      ["DELETE", `/api/memory/${missing}`],
    ] as const) {
      const res = await req(app, method, path, method === "DELETE" ? undefined : {});
      expect(res.status).toBe(404);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  test("validasi 400 untuk body salah", async () => {
    const app = makeMemoryApp();
    const cases: Array<[string, string, unknown]> = [
      ["POST", "/api/memory", { layer: "lain", title: "a", body: "b" }],
      ["POST", "/api/memory", { layer: "profile", title: "", body: "b" }],
      ["POST", "/api/memory", { layer: "profile", title: 5, body: "b" }],
      ["POST", "/api/memory", "bukan objek"],
      ["GET", "/api/memory?status=entah", undefined],
      ["GET", "/api/memory?limit=999", undefined],
      ["GET", "/api/memory?takdikenal=1", undefined],
    ];
    for (const [method, path, body] of cases) {
      const res = await req(app, method, path, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  test("rahasia ditolak 400 dengan pesan tanpa isi rahasia", async () => {
    const app = makeMemoryApp();
    const secret = "ghp_abcdefghijklmnopqrst";
    const res = await req(app, "POST", "/api/memory", {
      layer: "profile",
      title: "Token",
      body: `pakai ${secret}`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("rahasia");
    expect(body.error).not.toContain(secret);
  });

  test("transisi tidak sah 409", async () => {
    const app = makeMemoryApp();
    const created = (await (await req(app, "POST", "/api/memory", {
      layer: "profile",
      title: "A",
      body: "a",
    })).json()) as ItemBody;

    const res = await req(app, "POST", `/api/memory/${created.item.id}/reject`);
    expect(res.status).toBe(409);
    expect(await res.json()).toHaveProperty("error");
  });

  test("mutasi tanpa content-type json ditolak 415", async () => {
    const app = makeMemoryApp();
    const res = await app.handle(
      new Request("http://127.0.0.1:3000/api/memory", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "text/plain" },
        body: JSON.stringify({ layer: "profile", title: "a", body: "b" }),
      }),
    );
    expect(res.status).toBe(415);
  });

  test("guard Host dan Origin tetap berlaku", async () => {
    const app = makeMemoryApp();
    const badHost = await req(app, "GET", "/api/memory", undefined, { host: "evil.test" });
    expect(badHost.status).toBe(403);

    const badOrigin = await req(app, "GET", "/api/memory", undefined, {
      origin: "http://evil.test",
    });
    expect(badOrigin.status).toBe(403);
  });
});

describe("memory dimatikan", () => {
  test("semua rute menjawab 503 dan tidak menyentuh disk", async () => {
    const app = makeApp({ env: { MOCK: "true", JEJAK_HOME: home } });
    for (const [method, path] of [
      ["GET", "/api/memory"],
      ["POST", "/api/memory"],
      ["PATCH", "/api/memory/x"],
      ["POST", "/api/memory/x/accept"],
      ["POST", "/api/memory/x/reject"],
      ["POST", "/api/memory/x/archive"],
      ["DELETE", "/api/memory/x"],
    ] as const) {
      const res = await req(app, method, path, method === "GET" || method === "DELETE" ? undefined : {});
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Memory dimatikan." });
    }
    await expect(
      import("node:fs/promises").then((fs) => fs.stat(join(home, "memory"))),
    ).rejects.toThrow();
  });
});

describe("problems dan counts lewat API", () => {
  test("berkas rusak muncul di problems tanpa menggagalkan daftar", async () => {
    const app = makeMemoryApp();
    await req(app, "POST", "/api/memory", { layer: "profile", title: "Valid", body: "isi" });
    await mkdir(join(home, "memory", "profile"), { recursive: true });
    await writeFile(join(home, "memory", "profile", "rusak.md"), "bukan frontmatter", {
      mode: 0o600,
    });

    const body = (await (await req(app, "GET", "/api/memory")).json()) as ListBody;
    expect(body.items.map((item) => item.title)).toEqual(["Valid"]);
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]?.file).toBe("profile/rusak.md");
  });

  test("counts global tidak terpengaruh filter", async () => {
    const app = makeMemoryApp();
    await req(app, "POST", "/api/memory", { layer: "profile", title: "A", body: "a" });
    await req(app, "POST", "/api/memory", { layer: "profile", title: "B", body: "b" });

    const filtered = (await (await req(app, "GET", "/api/memory?q=tidakada")).json()) as ListBody;
    expect(filtered.items).toEqual([]);
    expect(filtered.counts).toEqual({ proposed: 0, active: 2 });
  });
});

describe("basi lewat API", () => {
  test("berkas asal berubah menandai item", async () => {
    store = new FileMemoryStore({ dir: join(home, "memory") });
    const service = new MemoryService({ store, cwd: dir });
    const app = makeApp({ memory: service });

    await writeFile(join(dir, "asal.ts"), "v1");
    const proposed = await service.propose({
      layer: "project",
      projectKey: dir,
      title: "Asal",
      body: "Isi",
      originFile: "asal.ts",
    });
    await writeFile(join(dir, "asal.ts"), "v2");

    const body = (await (await req(app, "GET", "/api/memory")).json()) as ListBody;
    const found = body.items.find((item) => item.id === proposed.id);
    expect(found?.staleReason).toBe("berkas asal berubah");
  });
});
