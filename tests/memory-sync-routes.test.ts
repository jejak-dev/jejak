import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { claudeMemorySyncRoutes } from "../src/server/routes/claude-memory-sync";
import { ClaudeMemorySync } from "../src/server/memory/claude-memory-sync";
import {
  FileMemorySyncStore,
  MEMORY_SYNC_ENV,
  memorySyncSettingsPath,
  parseMemorySyncSettings,
  resolveMemorySync,
} from "../src/server/memory/memory-sync-store";
import { authGuard } from "../src/server/auth/auth-guard";
import { createSessionCodec } from "../src/server/auth/session-cookie";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import type { Memory } from "../src/server/memory/memory-files";

let dir: string;
let claudeRoot: string;
let jejakHome: string;
let store: FileMemorySyncStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-sync-routes-"));
  claudeRoot = join(dir, "claude");
  jejakHome = join(dir, "jejak");
  await mkdir(jejakHome, { recursive: true });
  store = new FileMemorySyncStore(memorySyncSettingsPath({ JEJAK_HOME: jejakHome }));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ID_A = "11111111-1111-4111-8111-111111111111";

function makeMemory(): Memory {
  return {
    id: ID_A,
    layer: "project",
    projectKey: "/tmp/proyek",
    title: "Gaya kode",
    body: "Gunakan dua spasi.",
    status: "active",
    confidence: "confirmed",
    origin: { kind: "manual", at: "2026-01-01T00:00:00.000Z" },
    staleReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    decidedAt: null,
    replaces: null,
  };
}

function makeApp(
  env: Record<string, string | undefined> = {},
  memories?: Memory[],
  audit?: SqliteAuditStore,
): Elysia {
  const sync = new ClaudeMemorySync({
    configRoot: claudeRoot,
    enabled: () => resolveMemorySync(env, store.get()).enabled,
    projects: () => [{ key: "/tmp/proyek", path: "/tmp/proyek" }],
    ...(memories === undefined ? {} : { memories: async () => memories }),
  });
  return new Elysia().use(
    claudeMemorySyncRoutes({
      store,
      env,
      sync,
      ...(audit === undefined ? {} : { audit }),
    }),
  ) as unknown as Elysia;
}

function request(
  app: Elysia,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const json = method === "GET" || method === "HEAD";
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: {
        host: "127.0.0.1:3000",
        ...(json ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe("rute saklar sinkron Claude Code", () => {
  test("saklar bawaan mati", async () => {
    const app = makeApp();
    const res = await request(app, "GET", "/api/memory/claude/sync");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, locked: false });
  });

  test("PUT menyalakan saklar dan menyimpan berkas", async () => {
    const app = makeApp();
    const res = await request(app, "PUT", "/api/memory/claude/sync", { enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, locked: false });
    const raw = await readFile(memorySyncSettingsPath({ JEJAK_HOME: jejakHome }), "utf8");
    expect(parseMemorySyncSettings(JSON.parse(raw))).toEqual({ claude: true });
  });

  test("PUT dengan bentuk salah 400", async () => {
    const app = makeApp();
    const salah = await request(app, "PUT", "/api/memory/claude/sync", { enabled: "ya" });
    expect(salah.status).toBe(400);
    const asing = await request(app, "PUT", "/api/memory/claude/sync", { lain: true });
    expect(asing.status).toBe(400);
    const rusak = await app.handle(
      new Request("http://127.0.0.1:3000/api/memory/claude/sync", {
        method: "PUT",
        headers: { host: "127.0.0.1:3000" },
        body: "{bukan json",
      }),
    );
    expect(rusak.status).toBe(400);
  });

  test("env mengunci saklar: PUT 409 dan status terkunci", async () => {
    const app = makeApp({ [MEMORY_SYNC_ENV]: "1" });
    const res = await request(app, "PUT", "/api/memory/claude/sync", { enabled: false });
    expect(res.status).toBe(409);
    const status = await request(app, "GET", "/api/memory/claude/sync");
    expect(await status.json()).toEqual({ enabled: true, locked: true });
  });

  test("run ditolak 409 saat saklar mati", async () => {
    const app = makeApp({}, [makeMemory()]);
    const res = await request(app, "POST", "/api/memory/claude/sync/run");
    expect(res.status).toBe(409);
  });

  test("run mengembalikan ringkasan", async () => {
    const app = makeApp({}, [makeMemory()]);
    await request(app, "PUT", "/api/memory/claude/sync", { enabled: true });
    const res = await request(app, "POST", "/api/memory/claude/sync/run");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ditulis: number;
      konflik: string[];
      ditolakRahasia: number;
    };
    expect(body.ditulis).toBe(1);
    expect(body.konflik).toEqual([]);
    expect(body.ditolakRahasia).toBe(0);
  });

  test("perubahan saklar dicatat di audit log", async () => {
    const audit = new SqliteAuditStore(":memory:");
    const app = makeApp({}, undefined, audit);
    await request(app, "PUT", "/api/memory/claude/sync", { enabled: true });
    const entries = audit.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.meta).toEqual({ aksi: "sinkron-claude", nilai: true });
    audit.close();
  });

  test("tanpa autentikasi ditolak 401", async () => {    const codec = createSessionCodec({ port: 3000 });
    const sync = new ClaudeMemorySync({
      configRoot: claudeRoot,
      enabled: () => false,
      projects: () => [],
    });
    const app = new Elysia()
      .use(authGuard({ codec }))
      .use(
        claudeMemorySyncRoutes({
          store,
          env: {},
          sync,
        }),
      ) as unknown as Elysia;
    const res = await request(app, "GET", "/api/memory/claude/sync");
    expect(res.status).toBe(401);
  });
});

describe("penyimpanan status sinkron", () => {
  test("berkas rusak dibaca sebagai bawaan", () => {
    expect(parseMemorySyncSettings({ claude: true })).toEqual({ claude: true });
    expect(() => parseMemorySyncSettings({ claude: "ya" })).toThrow();
    expect(() => parseMemorySyncSettings({ lain: true })).toThrow();
  });

  test("env menang atas berkas", () => {
    expect(resolveMemorySync({}, { claude: true })).toEqual({
      enabled: true,
      locked: false,
    });
    expect(resolveMemorySync({ [MEMORY_SYNC_ENV]: "0" }, { claude: true })).toEqual({
      enabled: false,
      locked: true,
    });
    expect(resolveMemorySync({ [MEMORY_SYNC_ENV]: "1" }, { claude: false })).toEqual({
      enabled: true,
      locked: true,
    });
  });
});
