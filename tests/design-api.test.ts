import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";

let dir: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-api-"));
  const configDir = await mkdtemp(join(tmpdir(), "jejak-design-api-config-"));
  providersFile = join(configDir, "providers.json");
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
  await rm(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function makeApp(): App {
  return createApp({ providersPath: providersFile, env: { MOCK: "true" }, runner: createMockRunner() });
}

function req(server: App, method: string, path: string): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { host: "127.0.0.1:3000" },
    }),
  );
}

async function createSession(server: App, cwd = dir): Promise<string> {
  const created = await server.handle(
    new Request("http://127.0.0.1:3000/api/sessions", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Halo", cwd }),
    }),
  );
  expect(created.status).toBe(201);
  const data = (await created.json()) as { session: { id: string } };
  return data.session.id;
}

interface DesignBody {
  exists: boolean;
  pages: Array<{ slug: string; title: string; device: string; x: number; y: number; missing: boolean }>;
  tokens: { mtime: number | null };
  warnings: string[];
}

interface ErrorBody {
  error: string;
}

describe("GET /api/sessions/:id/design", () => {
  test("sesi tak dikenal 404", async () => {
    const server = makeApp();
    const res = await req(server, "GET", "/api/sessions/s_tidakada/design");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error).toBe('Sesi "s_tidakada" tidak ditemukan.');
  });

  test("repo tanpa folder design menjawab exists false", async () => {
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, "GET", `/api/sessions/${id}/design`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DesignBody;
    expect(body.exists).toBe(false);
    expect(body.pages).toEqual([]);
    expect(body.tokens.mtime).toBeNull();
  });

  test("repo dengan folder design mengembalikan halaman", async () => {
    await mkdir(join(dir, "design", "pages"), { recursive: true });
    await writeFile(
      join(dir, "design", "design.json"),
      JSON.stringify({ version: 1, pages: [{ slug: "beranda", title: "Beranda", device: "mobile" }] }),
      "utf8",
    );
    await writeFile(join(dir, "design", "pages", "beranda.html"), "<html></html>", "utf8");
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, "GET", `/api/sessions/${id}/design`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DesignBody;
    expect(body.exists).toBe(true);
    expect(body.pages).toHaveLength(1);
    expect(body.pages[0]!.slug).toBe("beranda");
    expect(body.pages[0]!.device).toBe("mobile");
  });

  test("parameter repo tak sah ditolak seperti rute berkas", async () => {
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, "GET", `/api/sessions/${id}/design?repo=web`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error).toBe("Sesi ini tidak punya workspace.");
  });
});

describe("GET /api/sessions/:id/design/stamp", () => {
  test("sesi tak dikenal 404", async () => {
    const server = makeApp();
    const res = await req(server, "GET", "/api/sessions/s_tidakada/design/stamp");
    expect(res.status).toBe(404);
  });

  test("stamp stabil tanpa perubahan dan berubah saat berkas berubah", async () => {
    const server = makeApp();
    const id = await createSession(server);

    const first = await req(server, "GET", `/api/sessions/${id}/design/stamp`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { stamp: string };
    expect(firstBody.stamp).toMatch(/^[0-9a-f]{12}$/);

    const again = await req(server, "GET", `/api/sessions/${id}/design/stamp`);
    expect(((await again.json()) as { stamp: string }).stamp).toBe(firstBody.stamp);

    await mkdir(join(dir, "design", "pages"), { recursive: true });
    await writeFile(join(dir, "design", "pages", "baru.html"), "<html></html>", "utf8");
    const changed = await req(server, "GET", `/api/sessions/${id}/design/stamp`);
    expect(((await changed.json()) as { stamp: string }).stamp).not.toBe(firstBody.stamp);
  });

  test("parameter repo tak sah ditolak", async () => {
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, "GET", `/api/sessions/${id}/design/stamp?repo=web`);
    expect(res.status).toBe(400);
  });
});

describe("rute design dan autentikasi", () => {
  test("tanpa cookie ditolak 401, dengan cookie lolos ke pemeriksaan sesi", async () => {
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      auth: { password: "sandi-uji-123", port: 3000 },
    });
    const host = { host: "127.0.0.1:3000" };
    const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
      app.handle(new Request(`http://127.0.0.1:3000${path}`, { headers: { ...host, ...headers } }));

    for (const path of ["/api/sessions/x/design", "/api/sessions/x/design/stamp"]) {
      const tanpa = await get(path);
      expect(tanpa.status).toBe(401);
    }

    const login = await app.handle(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { ...host, "content-type": "application/json" },
        body: JSON.stringify({ password: "sandi-uji-123" }),
      }),
    );
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const dengan = await get("/api/sessions/x/design", { cookie });
    expect(dengan.status).toBe(404);
  });
});
