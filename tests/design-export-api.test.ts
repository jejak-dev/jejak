import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";

let dir: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-export-api-"));
  const configDir = await mkdtemp(join(tmpdir(), "jejak-design-export-api-config-"));
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

function makeApp(audit?: AuditStore): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    runner: createMockRunner(),
    ...(audit === undefined ? {} : { audit }),
  });
}

function req(server: App, path: string): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, { headers: { host: "127.0.0.1:3000" } }),
  );
}

async function createSession(server: App): Promise<string> {
  const created = await server.handle(
    new Request("http://127.0.0.1:3000/api/sessions", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Halo", cwd: dir }),
    }),
  );
  expect(created.status).toBe(201);
  const data = (await created.json()) as { session: { id: string } };
  const id = data.session.id;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await req(server, `/api/sessions/${id}`);
    const status = ((await detail.json()) as { session: { status: string } }).session.status;
    if (status !== "berjalan") break;
    await Bun.sleep(5);
  }
  return id;
}

interface ErrorBody {
  error: string;
}

async function seedDesign(): Promise<void> {
  await mkdir(join(dir, "design", "pages"), { recursive: true });
  await writeFile(
    join(dir, "design", "pages", "beranda.html"),
    "<html><head></head><body><p>Halo</p></body></html>",
    "utf8",
  );
  await writeFile(join(dir, "design", "tokens.css"), ":root { --warna: #000; }", "utf8");
  await writeFile(
    join(dir, "design", "design.json"),
    JSON.stringify({ version: 1, pages: [{ slug: "beranda" }] }),
    "utf8",
  );
}

describe("GET /api/sessions/:id/design/export", () => {
  test("sesi tak dikenal 404", async () => {
    const server = makeApp();
    const res = await req(server, "/api/sessions/s_tidakada/design/export?format=html&slug=beranda");
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error).toBe('Sesi "s_tidakada" tidak ditemukan.');
  });

  test("format html mengembalikan berkas mandiri", async () => {
    await seedDesign();
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, `/api/sessions/${id}/design/export?format=html&slug=beranda`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="beranda.html"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).not.toContain("jejak-design-v1");
    expect(html).not.toContain("Content-Security-Policy");
    expect(html).toContain("<p>Halo</p>");
  });

  test("format zip mengembalikan arsip design/", async () => {
    await seedDesign();
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, `/api/sessions/${id}/design/export?format=zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="design.zip"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = new Uint8Array(await res.arrayBuffer());
    expect(data[0]).toBe(0x50);
    expect(data[1]).toBe(0x4b);
    expect(new TextDecoder().decode(data)).toContain("pages/beranda.html");
  });

  test("format react mengembalikan arsip proyek React", async () => {
    await seedDesign();
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, `/api/sessions/${id}/design/export?format=react`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="design-react.zip"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = new Uint8Array(await res.arrayBuffer());
    expect(data[0]).toBe(0x50);
    expect(data[1]).toBe(0x4b);
    const teks = new TextDecoder().decode(data);
    expect(teks).toContain("src/App.tsx");
    expect(teks).toContain("package.json");
  });

  test("format tak dikenal 400", async () => {
    await seedDesign();
    const server = makeApp();
    const id = await createSession(server);

    for (const path of [
      `/api/sessions/${id}/design/export`,
      `/api/sessions/${id}/design/export?format=pdf`,
      `/api/sessions/${id}/design/export?format=`,
    ]) {
      const res = await req(server, path);
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error).toBe("Format ekspor tidak dikenal.");
    }
  });

  test("slug tak sah 400 dan halaman hilang 404", async () => {
    await seedDesign();
    const server = makeApp();
    const id = await createSession(server);

    const takSah = await req(server, `/api/sessions/${id}/design/export?format=html&slug=../x`);
    expect(takSah.status).toBe(400);
    expect(((await takSah.json()) as ErrorBody).error).toBe("Slug halaman tidak valid.");

    const hilang = await req(server, `/api/sessions/${id}/design/export?format=html&slug=hilang`);
    expect(hilang.status).toBe(404);
    expect(((await hilang.json()) as ErrorBody).error).toBe("Halaman tidak ditemukan.");
  });

  test("zip tanpa folder design 404", async () => {
    const server = makeApp();
    const id = await createSession(server);

    const res = await req(server, `/api/sessions/${id}/design/export?format=zip`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error).toBe("Folder desain tidak ditemukan.");
  });

  test("ekspor tercatat di audit", async () => {
    await seedDesign();
    const audit = new SqliteAuditStore(":memory:");
    const server = makeApp(audit);
    const id = await createSession(server);

    await req(server, `/api/sessions/${id}/design/export?format=html&slug=beranda`);
    await req(server, `/api/sessions/${id}/design/export?format=zip`);
    await req(server, `/api/sessions/${id}/design/export?format=react`);
    const entries = audit.list({ kind: "berkas", limit: 50 });
    const ekspor = entries.filter((item) => item.meta.aksi === "design.export");
    expect(ekspor).toHaveLength(3);
    const html = ekspor.find((item) => item.meta.format === "html");
    expect(html?.meta.slug).toBe("beranda");
    const zip = ekspor.find((item) => item.meta.format === "zip");
    expect(zip?.meta.jumlah).toBe(3);
    const react = ekspor.find((item) => item.meta.format === "react");
    expect(react).toBeDefined();
    expect(typeof react?.meta.jumlah).toBe("number");
    audit.close();
  });
});
