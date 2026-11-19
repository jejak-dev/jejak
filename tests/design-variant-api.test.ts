import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import { DEVICES, GAP } from "../src/server/design/manifest";

let dir: string;
let providersFile: string;

const HTML = "<!doctype html><html><body><h1>Beranda</h1></body></html>";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-variant-api-"));
  const configDir = await mkdtemp(join(tmpdir(), "jejak-design-variant-api-config-"));
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
  await mkdir(join(dir, "design", "pages"), { recursive: true });
  await writeFile(join(dir, "design", "pages", "beranda.html"), HTML, "utf8");
  await writeManifest([{ slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 }]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeManifest(
  pages: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(dir, "design", "design.json"),
    JSON.stringify({ version: 1, ...extra, pages }, null, 2),
    "utf8",
  );
}

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
  const created = await reqBody(server, "POST", "/api/sessions", { prompt: "Halo", cwd });
  expect(created.status).toBe(201);
  const data = (await created.json()) as { session: { id: string } };
  const id = data.session.id;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await req(server, "GET", `/api/sessions/${id}`);
    const status = ((await detail.json()) as { session: { status: string } }).session.status;
    if (status !== "berjalan") break;
    await Bun.sleep(5);
  }
  return id;
}

interface ErrorBody {
  error: string;
}

interface VariantBody {
  page: { slug: string; title: string; x: number; y: number };
}

describe("POST /api/sessions/:id/design/variant", () => {
  test("200: berkas disalin, manifest bertambah, DESIGN.md disinkronkan", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/variant`;

    const res = await reqBody(server, "POST", base, { slug: "beranda", variant: "gelap" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as VariantBody;
    expect(body.page).toEqual({
      slug: "beranda-gelap",
      title: "Beranda (gelap)",
      x: DEVICES.desktop.width + GAP,
      y: 0,
    });

    expect(await readFile(join(dir, "design", "pages", "beranda-gelap.html"), "utf8")).toBe(HTML);

    const manifest = JSON.parse(
      await readFile(join(dir, "design", "design.json"), "utf8"),
    ) as { pages: Array<Record<string, unknown>> };
    expect(manifest.pages).toHaveLength(2);
    expect(manifest.pages[1]?.variant).toBe("gelap");
    expect(manifest.pages[1]?.group).toBe("Beranda");
    expect(manifest.pages[0]?.group).toBe("Beranda");

    const doc = await readFile(join(dir, "design", "DESIGN.md"), "utf8");
    expect(doc).toContain("beranda-gelap");
  });

  test("group pada body dipakai untuk varian dan sumber", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/variant`;

    const res = await reqBody(server, "POST", base, {
      slug: "beranda",
      variant: "galat",
      group: "Menu",
    });
    expect(res.status).toBe(200);

    const manifest = JSON.parse(
      await readFile(join(dir, "design", "design.json"), "utf8"),
    ) as { pages: Array<Record<string, unknown>> };
    expect(manifest.pages[0]?.group).toBe("Menu");
    expect(manifest.pages[1]?.group).toBe("Menu");
  });

  test("body tidak valid -> 400", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/variant`;

    const cases: unknown[] = [
      "{rusak",
      [],
      {},
      { slug: "beranda" },
      { variant: "gelap" },
      { slug: "beranda", variant: "gelap", lain: 1 },
      { slug: "Beranda", variant: "gelap" },
      { slug: "beranda", variant: "" },
      { slug: "beranda", variant: "x".repeat(31) },
      { slug: "beranda", variant: "gelap", group: "" },
    ];
    for (const body of cases) {
      const res = await reqBody(server, "POST", base, body);
      expect(res.status).toBe(400);
    }

    const manifest = JSON.parse(
      await readFile(join(dir, "design", "design.json"), "utf8"),
    ) as { pages: unknown[] };
    expect(manifest.pages).toHaveLength(1);
  });

  test("sesi tak ada dan sumber tak ada -> 404", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/variant`;

    const tanpaSesi = await reqBody(server, "POST", "/api/sessions/tidak-ada/design/variant", {
      slug: "beranda",
      variant: "gelap",
    });
    expect(tanpaSesi.status).toBe(404);

    const tanpaSumber = await reqBody(server, "POST", base, {
      slug: "halaman",
      variant: "gelap",
    });
    expect(tanpaSumber.status).toBe(404);
    expect(((await tanpaSumber.json()) as ErrorBody).error).toBe("Halaman sumber tidak ditemukan.");
  });

  test("slug varian bentrok semua -> 409", async () => {
    for (let index = 1; index <= 20; index += 1) {
      const name = index === 1 ? "beranda-gelap.html" : `beranda-gelap-${index}.html`;
      await writeFile(join(dir, "design", "pages", name), "lama", "utf8");
    }
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/variant`;

    const res = await reqBody(server, "POST", base, { slug: "beranda", variant: "gelap" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error).toBe("Slug varian bertabrakan.");
  });

  test("editEnabled=false -> 403", async () => {
    const server = makeApp({ JEJAK_FILE_EDIT: "0" });
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/variant`;

    const res = await reqBody(server, "POST", base, { slug: "beranda", variant: "gelap" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error).toBe("Penyuntingan berkas dimatikan.");
    expect(
      await readFile(join(dir, "design", "pages", "beranda-gelap.html"), "utf8").catch(() => ""),
    ).toBe("");
  });

  test("audit tercatat tanpa isi berkas", async () => {
    const audit = new SqliteAuditStore(":memory:");
    try {
      const server = makeApp({}, audit);
      const id = await createSession(server);
      const base = `/api/sessions/${id}/design/variant`;

      await reqBody(server, "POST", base, { slug: "beranda", variant: "gelap" });

      const entries = audit.list({ kind: "berkas", limit: 50 }).filter(
        (entry) => entry.meta.aksi === "design-variant",
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.summary).toBe("Varian desain dibuat");
      expect(entries[0]?.meta.asal).toBe("beranda");
      expect(entries[0]?.meta.baru).toBe("beranda-gelap");
      const json = JSON.stringify(entries);
      expect(json).not.toContain("Beranda</h1>");
    } finally {
      audit.close();
    }
  });
});
