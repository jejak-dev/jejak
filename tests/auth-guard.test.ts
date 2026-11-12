import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import { MemoryService } from "../src/server/memory/memory-service";
import type { MemoryBridge } from "../src/server/memory/memory-bridge";

const PASSWORD = "sandi-uji-123";
const HOST = { host: "127.0.0.1:3000" };

let dir: string;
let store: FileMemoryStore;
let service: MemoryService;
let bridge: MemoryBridge;

type App = ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-auth-guard-"));
  store = new FileMemoryStore({ dir: join(dir, "memory") });
  service = new MemoryService({ store, cwd: dir });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function makeApp(): App {
  const app = createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    memory: service,
    auth: { password: PASSWORD, port: 3000 },
  });
  bridge = (app as unknown as { memoryBridge: MemoryBridge }).memoryBridge;
  return app;
}

function get(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, { headers: { ...HOST, ...headers } }));
}

async function loginCookie(app: App, password = PASSWORD): Promise<string> {
  const res = await app.handle(
    new Request("http://127.0.0.1:3000/api/auth/login", {
      method: "POST",
      headers: { ...HOST, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  );
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

describe("authGuard", () => {
  test("path terbuka tetap terbuka tanpa cookie", async () => {
    const app = makeApp();
    const health = await get(app, "/api/health");
    expect(health.status).toBe(200);
    const status = await get(app, "/api/auth/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ required: true, authenticated: false });
  });

  test("aset klien di luar /api tidak disentuh", async () => {
    const app = makeApp();
    const res = await get(app, "/");
    expect(res.status).not.toBe(401);
  });

  test("rute api lain butuh cookie valid", async () => {
    const app = makeApp();
    const res = await get(app, "/api/sessions");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "perlu login" });
  });

  test("cookie valid membuka rute api", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    const res = await get(app, "/api/sessions", { cookie });
    expect(res.status).toBe(200);
  });

  test("cookie dengan tanda tangan rusak ditolak", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    const rusak = `${cookie.slice(0, -1)}${cookie.endsWith("a") ? "b" : "a"}`;
    const res = await get(app, "/api/sessions", { cookie: rusak });
    expect(res.status).toBe(401);
  });

  test("path mirip tidak membuka celah", async () => {
    const app = makeApp();
    for (const path of ["/api/healthx", "/api/health/../x", "/api/health/"]) {
      const res = await get(app, path);
      // Tidak boleh dilayani: 401 (butuh login) atau 404 (rute tidak ada).
      expect(res.ok).toBe(false);
      expect([401, 404]).toContain(res.status);
    }
    // Di luar awalan `/api/` penjaga tidak berlaku, tapi rutenya juga tidak ada.
    const diLuar = await get(app, "/api/auth");
    expect(diLuar.status).toBe(404);
  });

  test("query string pada path terbuka tetap terbuka", async () => {
    const app = makeApp();
    const res = await get(app, "/api/health?x=1");
    expect(res.status).toBe(200);
  });

  test("host tidak diizinkan tetap 403 walau cookie valid", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    const res = await get(app, "/api/sessions", { cookie, host: "evil.test" });
    expect(res.status).toBe(403);
  });

  test("SSE tanpa cookie ditolak", async () => {
    const app = makeApp();
    const res = await get(app, "/api/sessions/s_abc/events");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "perlu login" });
  });

  test("/mcp tetap dilayani tanpa cookie sesi", async () => {
    const app = makeApp();
    const opened = await bridge.open({ sessionId: "s_mcp", cwd: dir });
    const res = await app.handle(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: {
          ...HOST,
          "content-type": "application/json",
          authorization: `Bearer ${opened.memory.token ?? ""}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    opened.close();
  });

  test("tanpa auth aktif semua rute lama tetap terbuka", async () => {
    const app = createApp({
      providersPath: join(dir, "providers.json"),
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    });
    const sessions = await get(app, "/api/sessions");
    expect(sessions.status).toBe(200);
    const status = await get(app, "/api/auth/status");
    expect(await status.json()).toEqual({ required: false, authenticated: true });
  });

  test("daftar host diizinkan diperluas dengan host tambahan", async () => {
    const app = createApp({
      providersPath: join(dir, "providers.json"),
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      allowedHosts: ["jejak.lan"],
    });
    const tambahan = await app.handle(
      new Request("http://jejak.lan/api/health", { headers: { host: "jejak.lan" } }),
    );
    expect(tambahan.status).toBe(200);
    // Host bawaan loopback tetap diizinkan.
    const bawaan = await get(app, "/api/health");
    expect(bawaan.status).toBe(200);
  });
});
