import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import type { DesignToken } from "../src/server/design/tokens";

let dir: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-tokens-api-"));
  const configDir = await mkdtemp(join(tmpdir(), "jejak-design-tokens-api-config-"));
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
  await writeFile(join(dir, "design", "pages", "home.html"), "<html><body></body></html>", "utf8");
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

interface TokensBody {
  tokens: DesignToken[];
  mtime: number | null;
}

const VALID: DesignToken[] = [
  { name: "--warna-latar", value: "#ffffff" },
  { name: "--font-sans", value: 'system-ui, "Segoe UI", sans-serif' },
];

describe("rute token desain", () => {
  test("GET dan PUT token", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/tokens`;

    const empty = await req(server, "GET", base);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ tokens: [], mtime: null });

    const saved = await reqBody(server, "PUT", base, { tokens: VALID });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as TokensBody;
    expect(savedBody.tokens).toEqual(VALID);
    expect(savedBody.mtime).toBeGreaterThan(0);

    const listed = await req(server, "GET", base);
    const listedBody = (await listed.json()) as TokensBody;
    expect(listedBody.tokens).toEqual(VALID);
    expect(listedBody.mtime).toBe(savedBody.mtime);
  });

  test("baseMtime dipakai: cocok ditulis, basi 409", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/tokens`;

    const first = await reqBody(server, "PUT", base, { tokens: VALID });
    const firstBody = (await first.json()) as TokensBody;

    const basi = await reqBody(server, "PUT", base, {
      tokens: VALID,
      baseMtime: (firstBody.mtime ?? 0) + 5000,
    });
    expect(basi.status).toBe(409);
    expect(((await basi.json()) as ErrorBody).error).toBe("Token berubah sejak dibaca; muat ulang.");

    const cocok = await reqBody(server, "PUT", base, {
      tokens: [{ name: "--a", value: "1" }],
      baseMtime: firstBody.mtime,
    });
    expect(cocok.status).toBe(200);
  });

  test("body rusak ditolak 400", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/tokens`;

    expect((await reqBody(server, "PUT", base, "{rusak")).status).toBe(400);
    expect((await reqBody(server, "PUT", base, [])).status).toBe(400);
    expect((await reqBody(server, "PUT", base, {})).status).toBe(400);
    expect((await reqBody(server, "PUT", base, { tokens: "bukan daftar" })).status).toBe(400);
    expect((await reqBody(server, "PUT", base, { tokens: VALID, lain: 1 })).status).toBe(400);
    expect((await reqBody(server, "PUT", base, { tokens: [{ name: "salah", value: "1" }] })).status).toBe(
      400,
    );
    expect(
      (await reqBody(server, "PUT", base, { tokens: [{ name: "--a", value: "x{y" }] })).status,
    ).toBe(400);
    expect(
      (
        await reqBody(server, "PUT", base, {
          tokens: [
            { name: "--a", value: "1" },
            { name: "--a", value: "2" },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await reqBody(server, "PUT", base, { tokens: VALID, baseMtime: "x" })).status).toBe(400);
  });

  test("sesi tak ada 404 dan desain belum dibuat 404", async () => {
    const server = makeApp();
    await createSession(server);

    expect((await req(server, "GET", "/api/sessions/s_tidakada/design/tokens")).status).toBe(404);
    expect((await reqBody(server, "PUT", "/api/sessions/s_tidakada/design/tokens", { tokens: [] })).status).toBe(
      404,
    );

    const kosong = await mkdtemp(join(tmpdir(), "jejak-design-tokens-api-kosong-"));
    try {
      const lainId = await createSession(server, kosong);
      const lain = `/api/sessions/${lainId}/design/tokens`;
      expect((await req(server, "GET", lain)).status).toBe(200);
      expect(await (await req(server, "GET", lain)).json()).toEqual({ tokens: [], mtime: null });
      const belum = await reqBody(server, "PUT", lain, { tokens: VALID });
      expect(belum.status).toBe(404);
      expect(((await belum.json()) as ErrorBody).error).toBe("Desain belum dibuat.");
    } finally {
      await rm(kosong, { recursive: true, force: true });
    }
  });

  test("editEnabled=false: PUT 403, GET tetap 200", async () => {
    const server = makeApp({ JEJAK_FILE_EDIT: "0" });
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/tokens`;

    expect((await req(server, "GET", base)).status).toBe(200);
    const denied = await reqBody(server, "PUT", base, { tokens: VALID });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as ErrorBody).error).toBe("Penyuntingan berkas dimatikan.");
  });

  test("audit tercatat tanpa nilai token", async () => {
    const audit = new SqliteAuditStore(":memory:");
    try {
      const server = makeApp({}, audit);
      const id = await createSession(server);
      const base = `/api/sessions/${id}/design/tokens`;

      await reqBody(server, "PUT", base, { tokens: VALID });

      const entries = audit.list({ kind: "berkas", limit: 50 }).filter(
        (entry) => entry.meta.aksi === "design-tokens",
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.summary).toBe("Token desain disimpan");
      expect(entries[0]?.meta.jumlah).toBe(2);
      const json = JSON.stringify(entries);
      expect(json).not.toContain("#ffffff");
      expect(json).not.toContain("Segoe UI");
    } finally {
      audit.close();
    }
  });
});
