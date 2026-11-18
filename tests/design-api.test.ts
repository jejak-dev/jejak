import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { buildCsp } from "../src/server/design/assemble";
import { createMockRunner, type AgentRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";

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

function makeApp(extra: Record<string, string> = {}, audit?: AuditStore): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home"), ...extra },
    runner: createMockRunner(),
    ...(audit === undefined ? {} : { audit }),
  });
}

function req(server: App, method: string, path: string): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { host: "127.0.0.1:3000" },
    }),
  );
}

function reqBody(server: App, method: string, path: string, body: unknown): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
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
  const id = data.session.id;
  // Tunggu runner selesai agar sesi tidak berstatus "berjalan".
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await req(server, "GET", `/api/sessions/${id}`);
    const status = ((await detail.json()) as { session: { status: string } }).session.status;
    if (status !== "berjalan") break;
    await Bun.sleep(5);
  }
  return id;
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

describe("GET /api/sessions/:id/design/page", () => {
  test("sesi tak dikenal 404", async () => {
    const server = makeApp();
    const res = await req(server, "GET", "/api/sessions/s_tidakada/design/page?slug=beranda");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error).toBe('Sesi "s_tidakada" tidak ditemukan.');
  });

  test("halaman dirakit 200 dengan CSP dan runtime", async () => {
    await mkdir(join(dir, "design", "pages"), { recursive: true });
    await writeFile(
      join(dir, "design", "pages", "beranda.html"),
      "<html><head></head><body><p>Halo</p></body></html>",
      "utf8",
    );
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, "GET", `/api/sessions/${id}/design/page?slug=beranda`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; html: string; mtime: number; warnings: string[] };
    expect(body.slug).toBe("beranda");
    expect(body.html).toContain("Content-Security-Policy");
    expect(body.html).toContain("<script data-jejak-design-runtime>");
    expect(body.html).toContain('"beranda"');
    expect(body.mtime).toBeGreaterThan(0);
    expect(body.warnings).toEqual([]);
  });

  test("slug tak sah 400, halaman tak ada 404, melebihi batas 413", async () => {
    await mkdir(join(dir, "design", "pages"), { recursive: true });
    await writeFile(join(dir, "design", "pages", "besar.html"), "a".repeat(512 * 1024 + 1), "utf8");
    const server = makeApp();
    const id = await createSession(server);

    const invalid = await req(server, "GET", `/api/sessions/${id}/design/page?slug=../x`);
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as ErrorBody).error).toBe("Slug halaman tidak valid.");

    const missing = await req(server, "GET", `/api/sessions/${id}/design/page?slug=hilang`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorBody).error).toBe("Halaman tidak ditemukan.");

    const tooLarge = await req(server, "GET", `/api/sessions/${id}/design/page?slug=besar`);
    expect(tooLarge.status).toBe(413);
    expect(((await tooLarge.json()) as ErrorBody).error).toBe("Halaman melebihi 512 KB.");
  });
});

describe("GET /api/sessions/:id/design/frame", () => {
  test("sesi tak dikenal 404", async () => {
    const server = makeApp();
    const res = await req(server, "GET", "/api/sessions/s_tidakada/design/frame?slug=beranda");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error).toBe('Sesi "s_tidakada" tidak ditemukan.');
  });

  test("200 HTML dengan CSP, nosniff, dan no-store", async () => {
    await mkdir(join(dir, "design", "pages"), { recursive: true });
    await writeFile(
      join(dir, "design", "pages", "beranda.html"),
      "<html><head></head><body><p>Halo</p></body></html>",
      "utf8",
    );
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, "GET", `/api/sessions/${id}/design/frame?slug=beranda&v=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(buildCsp(false));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain("<script data-jejak-design-runtime>");
  });

  test("CSP mengikuti sakelar Google Fonts", async () => {
    await mkdir(join(dir, "design", "pages"), { recursive: true });
    await writeFile(join(dir, "design", "pages", "beranda.html"), "<html></html>", "utf8");
    const server = makeApp({ JEJAK_DESIGN_GOOGLE_FONTS: "1" });
    const id = await createSession(server);

    const res = await req(server, "GET", `/api/sessions/${id}/design/frame?slug=beranda`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(buildCsp(true));
  });

  test("slug tak sah 400, halaman tak ada 404", async () => {
    await mkdir(join(dir, "design", "pages"), { recursive: true });
    const server = makeApp();
    const id = await createSession(server);

    const invalid = await req(server, "GET", `/api/sessions/${id}/design/frame?slug=../x`);
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as ErrorBody).error).toBe("Slug halaman tidak valid.");

    const missing = await req(server, "GET", `/api/sessions/${id}/design/frame?slug=hilang`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorBody).error).toBe("Halaman tidak ditemukan.");
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

    for (const path of [
      "/api/sessions/x/design",
      "/api/sessions/x/design/stamp",
      "/api/sessions/x/design/page?slug=beranda",
      "/api/sessions/x/design/frame?slug=beranda",
    ]) {
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

describe("PUT /api/sessions/:id/design/layout", () => {
  test("200 dan isi design.json berubah", async () => {
    await mkdir(join(dir, "design"), { recursive: true });
    await writeFile(
      join(dir, "design", "design.json"),
      JSON.stringify({
        version: 1,
        pages: [{ slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 }],
      }),
      "utf8",
    );
    const server = makeApp();
    const id = await createSession(server);

    const res = await reqBody(server, "PUT", `/api/sessions/${id}/design/layout`, {
      pages: [{ slug: "beranda", x: 24, y: 16, device: "mobile" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 1 });

    const manifest = JSON.parse(
      await readFile(join(dir, "design", "design.json"), "utf8"),
    ) as { pages: Array<Record<string, unknown>> };
    expect(manifest.pages[0]).toEqual({
      slug: "beranda",
      title: "Beranda",
      device: "mobile",
      x: 24,
      y: 16,
    });
  });

  test("JEJAK_FILE_EDIT=0 -> 403", async () => {
    const server = makeApp({ JEJAK_FILE_EDIT: "0" });
    const id = await createSession(server);
    const res = await reqBody(server, "PUT", `/api/sessions/${id}/design/layout`, { pages: [] });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error).toBe("Penyuntingan berkas dimatikan.");
  });

  test("sesi berjalan ditolak 409", async () => {
    const hanging: AgentRunner = {
      async *run() {
        await new Promise<void>(() => {});
      },
    };
    const server = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      runner: hanging,
    });
    const created = await reqBody(server, "POST", "/api/sessions", { prompt: "Halo", cwd: dir });
    const id = ((await created.json()) as { session: { id: string } }).session.id;

    const res = await reqBody(server, "PUT", `/api/sessions/${id}/design/layout`, { pages: [] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error).toBe(
      "Sesi sedang berjalan. Tunggu selesai atau hentikan dulu.",
    );
    await reqBody(server, "POST", `/api/sessions/${id}/interrupt`, {});
  });

  test("sesi tak dikenal 404 dan body bukan JSON 400", async () => {
    const server = makeApp();
    const id = await createSession(server);
    expect(
      (await reqBody(server, "PUT", "/api/sessions/tidak-ada/design/layout", { pages: [] })).status,
    ).toBe(404);
    expect(
      (await reqBody(server, "PUT", `/api/sessions/${id}/design/layout`, "{rusak")).status,
    ).toBe(400);
  });

  test("entri audit tercatat", async () => {
    await mkdir(join(dir, "design"), { recursive: true });
    await writeFile(
      join(dir, "design", "design.json"),
      JSON.stringify({ version: 1, pages: [{ slug: "beranda", x: 0, y: 0 }] }),
      "utf8",
    );
    const audit = new SqliteAuditStore(":memory:");
    const server = makeApp({}, audit);
    const id = await createSession(server);

    await reqBody(server, "PUT", `/api/sessions/${id}/design/layout`, {
      pages: [{ slug: "beranda", x: 8, y: 8 }],
    });
    const entries = audit.list({ kind: "berkas", limit: 50 });
    const entry = entries.find((item) => item.meta.aksi === "design-layout");
    expect(entry?.summary).toBe("Tata letak desain disimpan");
    expect(entry?.meta.halaman).toBe(1);
    audit.close();
  });
});

describe("POST /api/sessions/:id/design/init", () => {
  test("201 lalu 409", async () => {
    const server = makeApp();
    const id = await createSession(server);

    const first = await reqBody(server, "POST", `/api/sessions/${id}/design/init`, {});
    expect(first.status).toBe(201);
    const body = (await first.json()) as { ok: boolean; created: string[] };
    expect(body.ok).toBe(true);
    expect(body.created).toHaveLength(4);

    const second = await reqBody(server, "POST", `/api/sessions/${id}/design/init`, {});
    expect(second.status).toBe(409);
  });

  test("JEJAK_FILE_EDIT=0 -> 403", async () => {
    const server = makeApp({ JEJAK_FILE_EDIT: "0" });
    const id = await createSession(server);
    const res = await reqBody(server, "POST", `/api/sessions/${id}/design/init`, {});
    expect(res.status).toBe(403);
  });

  test("401 tanpa cookie untuk PUT dan POST", async () => {
    const app = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      auth: { password: "sandi-uji-123", port: 3000 },
    });
    const host = { host: "127.0.0.1:3000" };
    const send = (method: string, path: string): Promise<Response> =>
      app.handle(
        new Request(`http://127.0.0.1:3000${path}`, {
          method,
          headers: { ...host, "content-type": "application/json" },
          body: JSON.stringify({ pages: [] }),
        }),
      );
    expect((await send("PUT", "/api/sessions/x/design/layout")).status).toBe(401);
    expect((await send("POST", "/api/sessions/x/design/init")).status).toBe(401);
  });
});
