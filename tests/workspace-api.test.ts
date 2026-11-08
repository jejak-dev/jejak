import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { defaultWorkspaceService } from "../src/server/routes/workspaces";
import { WorkspaceService } from "../src/server/workspaces/workspace-service";

let root: string;
let home: string;
let providersFile: string;
let repoA: string;
let repoB: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-workspace-api-"));
  home = join(root, "home");
  providersFile = join(root, "providers.json");
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
  repoA = join(root, "api");
  repoB = join(root, "web");
  await mkdir(repoA, { recursive: true, mode: 0o700 });
  await mkdir(repoB, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeApp(options: Partial<CreateAppOptions> = {}) {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: home },
    runner: createMockRunner(),
    ...options,
  });
}

function makeWorkspaceApp(): ReturnType<typeof createApp> {
  const service = new WorkspaceService({ dir: join(home, "workspaces") });
  return makeApp({ workspaces: service });
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

interface CardBody {
  description: string;
  kind: string;
  tables: string[];
  queues: string[];
  calls: string[];
  updatedAt: string | null;
}

interface RepoBody {
  name: string;
  path: string;
  card: CardBody;
  missing: boolean;
}

interface ItemBody {
  item: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    repos: RepoBody[];
  };
}

interface ListBody {
  items: ItemBody["item"][];
  problems: { file: string; reason: string }[];
}

const MISSING = "00000000-0000-4000-8000-000000000000";

describe("rute workspace aktif", () => {
  test("POST membuat workspace 201 dengan kartu awal", async () => {
    const app = makeWorkspaceApp();
    const res = await req(app, "POST", "/api/workspaces", {
      name: "Kantor",
      repos: [{ name: "api", path: repoA }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ItemBody;
    expect(body.item.name).toBe("Kantor");
    expect(body.item.repos).toHaveLength(1);
    expect(body.item.repos[0]!.missing).toBe(false);
    expect(body.item.repos[0]!.card.kind).toBe("lainnya");
  });

  test("GET daftar mengembalikan items dan problems", async () => {
    const app = makeWorkspaceApp();
    await req(app, "POST", "/api/workspaces", { name: "A" });
    const res = await req(app, "GET", "/api/workspaces");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items).toHaveLength(1);
    expect(body.problems).toEqual([]);
  });

  test("PATCH mengubah nama dan mengganti repos", async () => {
    const app = makeWorkspaceApp();
    const created = (await (await req(app, "POST", "/api/workspaces", {
      name: "Awal",
      repos: [{ name: "api", path: repoA }],
    })).json()) as ItemBody;

    const res = await req(app, "PATCH", `/api/workspaces/${created.item.id}`, {
      name: "Baru",
      repos: [{ name: "web", path: repoB }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemBody;
    expect(body.item.name).toBe("Baru");
    expect(body.item.repos.map((repo) => repo.name)).toEqual(["web"]);
  });

  test("PUT kartu mengisi field dan mempertahankan yang tak ada", async () => {
    const app = makeWorkspaceApp();
    const created = (await (await req(app, "POST", "/api/workspaces", {
      name: "W",
      repos: [{ name: "api", path: repoA }],
    })).json()) as ItemBody;

    const first = await req(app, "PUT", `/api/workspaces/${created.item.id}/repos/api/card`, {
      description: "Layanan utama",
      kind: "backend",
      tables: ["pesanan"],
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as ItemBody;
    expect(firstBody.item.repos[0]!.card.tables).toEqual(["pesanan"]);
    expect(firstBody.item.repos[0]!.card.updatedAt).not.toBeNull();

    const second = (await (await req(
      app,
      "PUT",
      `/api/workspaces/${created.item.id}/repos/api/card`,
      { queues: ["antrian"] },
    )).json()) as ItemBody;
    expect(second.item.repos[0]!.card.description).toBe("Layanan utama");
    expect(second.item.repos[0]!.card.tables).toEqual(["pesanan"]);
    expect(second.item.repos[0]!.card.queues).toEqual(["antrian"]);
  });

  test("DELETE menghapus workspace dan 404 setelahnya", async () => {
    const app = makeWorkspaceApp();
    const created = (await (await req(app, "POST", "/api/workspaces", {
      name: "W",
    })).json()) as ItemBody;

    const removed = await req(app, "DELETE", `/api/workspaces/${created.item.id}`, {});
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });

    const again = await req(app, "DELETE", `/api/workspaces/${created.item.id}`, {});
    expect(again.status).toBe(404);
    expect(await again.json()).toHaveProperty("error");
  });
});

describe("kode status dan galat", () => {
  test("id bukan UUID dan id tak ada menjawab 404", async () => {
    const app = makeWorkspaceApp();
    const cases: Array<[string, string, unknown]> = [
      ["PATCH", "/api/workspaces/bukan-uuid", { name: "X" }],
      ["PUT", "/api/workspaces/bukan-uuid/repos/api/card", { kind: "backend" }],
      ["DELETE", "/api/workspaces/bukan-uuid", undefined],
      ["PATCH", `/api/workspaces/${MISSING}`, { name: "X" }],
      ["PUT", `/api/workspaces/${MISSING}/repos/api/card`, { kind: "backend" }],
      ["DELETE", `/api/workspaces/${MISSING}`, undefined],
    ];
    for (const [method, path, body] of cases) {
      const res = await req(app, method, path, body);
      expect(res.status).toBe(404);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  test("validasi 400 untuk body salah", async () => {
    const app = makeWorkspaceApp();
    const created = (await (await req(app, "POST", "/api/workspaces", {
      name: "W",
      repos: [{ name: "api", path: repoA }],
    })).json()) as ItemBody;

    const cases: Array<[string, string, unknown]> = [
      ["POST", "/api/workspaces", { name: "" }],
      ["POST", "/api/workspaces", { name: 5 }],
      ["POST", "/api/workspaces", { name: "W", takdikenal: true }],
      ["POST", "/api/workspaces", "bukan objek"],
      ["POST", "/api/workspaces", { name: "W", repos: [{ name: "Api", path: repoA }] }],
      ["POST", "/api/workspaces", { name: "W", repos: [{ name: "api", path: "relatif" }] }],
      ["PATCH", `/api/workspaces/${created.item.id}`, {}],
      ["PATCH", `/api/workspaces/${created.item.id}`, { nama: "x" }],
      ["PUT", `/api/workspaces/${created.item.id}/repos/api/card`, { kind: "entah" }],
      ["PUT", `/api/workspaces/${created.item.id}/repos/api/card`, { deskripsi: "x" }],
      ["PUT", `/api/workspaces/${created.item.id}/repos/api/card`, {}],
    ];
    for (const [method, path, body] of cases) {
      const res = await req(app, method, path, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  test("repo tak dikenal pada kartu 404", async () => {
    const app = makeWorkspaceApp();
    const created = (await (await req(app, "POST", "/api/workspaces", {
      name: "W",
      repos: [{ name: "api", path: repoA }],
    })).json()) as ItemBody;
    const res = await req(
      app,
      "PUT",
      `/api/workspaces/${created.item.id}/repos/lain/card`,
      { kind: "backend" },
    );
    expect(res.status).toBe(404);
  });

  test("rahasia ditolak 400 tanpa mengulang teks", async () => {
    const app = makeWorkspaceApp();
    const secret = "ghp_abcdefghijklmnopqrst";
    const res = await req(app, "POST", "/api/workspaces", { name: `W ${secret}` });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("rahasia");
    expect(body.error).not.toContain(secret);
  });

  test("berkas rusak di problems lewat API", async () => {
    const app = makeWorkspaceApp();
    await req(app, "POST", "/api/workspaces", { name: "Valid" });
    await writeFile(join(home, "workspaces", `${crypto.randomUUID()}.json`), "rusak", {
      mode: 0o600,
    });

    const body = (await (await req(app, "GET", "/api/workspaces")).json()) as ListBody;
    expect(body.items.map((item) => item.name)).toEqual(["Valid"]);
    expect(body.problems).toHaveLength(1);
  });

  test("mutasi tanpa content-type json ditolak 415", async () => {
    const app = makeWorkspaceApp();
    const res = await app.handle(
      new Request("http://127.0.0.1:3000/api/workspaces", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "text/plain" },
        body: JSON.stringify({ name: "W" }),
      }),
    );
    expect(res.status).toBe(415);
  });

  test("guard Host dan Origin tetap berlaku", async () => {
    const app = makeWorkspaceApp();
    const badHost = await req(app, "GET", "/api/workspaces", undefined, { host: "evil.test" });
    expect(badHost.status).toBe(403);

    const badOrigin = await req(app, "GET", "/api/workspaces", undefined, {
      origin: "http://evil.test",
    });
    expect(badOrigin.status).toBe(403);
  });
});

describe("workspace dimatikan", () => {
  test("defaultWorkspaceService mengikuti JEJAK_WORKSPACES=0", () => {
    expect(defaultWorkspaceService({ JEJAK_HOME: home })).toBeInstanceOf(WorkspaceService);
    expect(defaultWorkspaceService({ JEJAK_HOME: home, JEJAK_WORKSPACES: "0" })).toBeUndefined();
  });

  test("semua rute menjawab 503 dan createApp tanpa opsi tidak menyentuh disk", async () => {
    const app = makeApp();
    for (const [method, path] of [
      ["GET", "/api/workspaces"],
      ["POST", "/api/workspaces"],
      ["PATCH", "/api/workspaces/x"],
      ["PUT", "/api/workspaces/x/repos/api/card"],
      ["DELETE", "/api/workspaces/x"],
    ] as const) {
      const res = await req(
        app,
        method,
        path,
        method === "GET" || method === "DELETE" ? undefined : {},
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Workspace dimatikan." });
    }
    await expect(stat(join(home, "workspaces"))).rejects.toThrow();
    await expect(readdir(home)).rejects.toThrow();
  });
});
