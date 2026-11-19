import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";

let dir: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-notes-api-"));
  const configDir = await mkdtemp(join(tmpdir(), "jejak-design-notes-api-config-"));
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
  await writeFile(
    join(dir, "design", "pages", "beranda.html"),
    "<!doctype html><html><body><h1>Beranda</h1></body></html>",
    "utf8",
  );
  await writeManifest();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeManifest(
  pages: Array<Record<string, unknown>> = [
    { slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 },
  ],
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

interface NotesBody {
  notes: Array<{ id: string; x: number; y: number; text: string }>;
}

describe("PUT /api/sessions/:id/design/notes", () => {
  test("200: catatan tersimpan dan terbaca lewat GET design", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/notes`;

    const res = await reqBody(server, "PUT", base, {
      notes: [{ x: 12, y: 34, text: "Cek kontras tombol" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as NotesBody;
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0]?.id).toMatch(/^n_[0-9a-f]{8}$/);
    expect(body.notes[0]?.x).toBe(12);
    expect(body.notes[0]?.text).toBe("Cek kontras tombol");

    const manifest = JSON.parse(
      await readFile(join(dir, "design", "design.json"), "utf8"),
    ) as { notes: Array<Record<string, unknown>> };
    expect(manifest.notes).toHaveLength(1);

    const design = (await (
      await req(server, "GET", `/api/sessions/${id}/design`)
    ).json()) as { notes: NotesBody["notes"] };
    expect(design.notes).toHaveLength(1);
    expect(design.notes[0]?.text).toBe("Cek kontras tombol");
  });

  test("body tak sah -> 400 dan berkas tak berubah", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/notes`;

    const cases: unknown[] = [
      "{rusak",
      [],
      {},
      { notes: "bukan daftar" },
      { notes: [{ x: 0, y: 0, text: 12 }] },
      { notes: [{ x: 0, y: 0, text: "a".repeat(501) }] },
      { notes: [{ id: "salah", x: 0, y: 0, text: "a" }] },
      { notes: [], lain: 1 },
    ];
    for (const body of cases) {
      const res = await reqBody(server, "PUT", base, body);
      expect(res.status).toBe(400);
    }

    const manifest = JSON.parse(
      await readFile(join(dir, "design", "design.json"), "utf8"),
    ) as { notes?: unknown };
    expect(manifest.notes).toBeUndefined();
  });

  test("lebih dari 50 catatan -> 400", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/notes`;

    const notes = Array.from({ length: 51 }, (_, index) => ({ x: index, y: 0, text: "x" }));
    const res = await reqBody(server, "PUT", base, { notes });
    expect(res.status).toBe(400);
  });

  test("sesi tak ada -> 404", async () => {
    const server = makeApp();
    const res = await reqBody(server, "PUT", "/api/sessions/tidak-ada/design/notes", {
      notes: [],
    });
    expect(res.status).toBe(404);
  });

  test("editEnabled=false -> 403", async () => {
    const server = makeApp({ JEJAK_FILE_EDIT: "0" });
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/notes`;

    const res = await reqBody(server, "PUT", base, { notes: [{ x: 0, y: 0, text: "a" }] });
    expect(res.status).toBe(403);
    const manifest = JSON.parse(
      await readFile(join(dir, "design", "design.json"), "utf8"),
    ) as { notes?: unknown };
    expect(manifest.notes).toBeUndefined();
  });

  test("audit mencatat jumlah saja", async () => {
    const audit = new SqliteAuditStore(":memory:");
    try {
      const server = makeApp({}, audit);
      const id = await createSession(server);
      const base = `/api/sessions/${id}/design/notes`;

      await reqBody(server, "PUT", base, {
        notes: [{ x: 0, y: 0, text: "rahasia catatan" }],
      });

      const entries = audit.list({ kind: "berkas", limit: 50 }).filter(
        (entry) => entry.meta.aksi === "design-notes",
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.summary).toBe("Catatan desain disimpan");
      expect(entries[0]?.meta.jumlah).toBe(1);
      const json = JSON.stringify(entries);
      expect(json).not.toContain("rahasia catatan");
    } finally {
      audit.close();
    }
  });
});
