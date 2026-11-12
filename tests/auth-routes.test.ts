import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";

const PASSWORD = "sandi-uji-123";
const HOST = { host: "127.0.0.1:3000" };

let dir: string;
let audit: SqliteAuditStore;

type App = ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-auth-routes-"));
  audit = new SqliteAuditStore(":memory:");
});

afterEach(async () => {
  audit.close();
  await rm(dir, { recursive: true, force: true });
});

function makeApp(auth: boolean): App {
  return createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    audit,
    ...(auth ? { auth: { password: PASSWORD, port: 3000 } } : {}),
  });
}

function post(app: App, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: "POST",
      headers: { ...HOST, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function get(app: App, path: string, headers: Record<string, string> = {}) {
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, { headers: { ...HOST, ...headers } }));
}

describe("rute autentikasi", () => {
  test("status tanpa login bilang perlu autentikasi", async () => {
    const res = await get(makeApp(true), "/api/auth/status");
    expect(await res.json()).toEqual({ required: true, authenticated: false });
  });

  test("status dengan cookie sah bilang sudah masuk", async () => {
    const app = makeApp(true);
    const login = await post(app, "/api/auth/login", { password: PASSWORD });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await get(app, "/api/auth/status", { cookie });
    expect(await res.json()).toEqual({ required: true, authenticated: true });
  });

  test("login dengan sandi benar memberi cookie sesi", async () => {
    const res = await post(makeApp(true), "/api/auth/login", { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("jejak_sid_3000=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("login dengan sandi salah ditolak", async () => {
    const res = await post(makeApp(true), "/api/auth/login", { password: "sandi-salah" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "sandi salah" });
  });

  test("login tanpa body ditolak", async () => {
    const res = await post(makeApp(true), "/api/auth/login", {});
    expect(res.status).toBe(401);
  });

  test("logout menghapus cookie sesi", async () => {
    const app = makeApp(true);
    const login = await post(app, "/api/auth/login", { password: PASSWORD });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await post(app, "/api/auth/logout", {}, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  test("logout tanpa cookie ditolak penjaga", async () => {
    const res = await post(makeApp(true), "/api/auth/logout", {});
    expect(res.status).toBe(401);
  });

  test("lima kegagalan lalu diblokir dengan retry-after", async () => {
    const app = makeApp(true);
    for (let index = 0; index < 5; index += 1) {
      const gagal = await post(app, "/api/auth/login", { password: "sandi-salah" });
      expect(gagal.status).toBe(401);
    }
    const diblokir = await post(app, "/api/auth/login", { password: PASSWORD });
    expect(diblokir.status).toBe(429);
    expect(diblokir.headers.get("retry-after")).toBe("2");
  });

  test("tidak ada auth: status bebas, login dan logout 404", async () => {
    const app = makeApp(false);
    const status = await get(app, "/api/auth/status");
    expect(await status.json()).toEqual({ required: false, authenticated: true });
    const login = await post(app, "/api/auth/login", { password: PASSWORD });
    expect(login.status).toBe(404);
    const logout = await post(app, "/api/auth/logout", {});
    expect(logout.status).toBe(404);
  });

  test("audit mencatat masuk dan keluar tanpa memuat sandi", async () => {
    const app = makeApp(true);
    await post(app, "/api/auth/login", { password: "sandi-salah" });
    const login = await post(app, "/api/auth/login", { password: PASSWORD });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await post(app, "/api/auth/logout", {}, { cookie });

    const entries = audit.list({ kind: "pengaturan" });
    const actions = entries.map((entry) => entry.meta.aksi);
    expect(actions).toContain("masuk-gagal");
    expect(actions).toContain("masuk-berhasil");
    expect(actions).toContain("keluar");

    const dump = JSON.stringify(entries);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain("sandi-salah");
  });

  test("audit mencatat throttle terblokir", async () => {
    const app = makeApp(true);
    for (let index = 0; index < 6; index += 1) {
      await post(app, "/api/auth/login", { password: "sandi-salah" });
    }
    const entries = audit.list({ kind: "pengaturan" });
    const actions = entries.map((entry) => entry.meta.aksi);
    expect(actions).toContain("terblokir-throttle");
    expect(JSON.stringify(entries)).not.toContain("sandi-salah");
  });
});
