import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import { FilePasswordStore } from "../src/server/auth/password-store";

const PASSWORD = "sandi-uji-123";
const SANDI_BARU = "sandi-baru-456";
const HOST = { host: "127.0.0.1:3000" };
const DESKTOP_TOKEN = "token-desktop-uji-1234567890abcdefgh";

let dir: string;
let audit: SqliteAuditStore;

type App = ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-auth-password-"));
  audit = new SqliteAuditStore(":memory:");
});

afterEach(async () => {
  audit.close();
  await rm(dir, { recursive: true, force: true });
});

/** App dengan autentikasi CLI (sandi internal) dan penyimpanan sandi di home uji. */
function makeApp(): App {
  return createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    audit,
    auth: { password: PASSWORD, port: 3000 },
  });
}

/** App mode desktop: sandi internal acak plus token masuk sekali pakai. */
function makeDesktopApp(): App {
  return createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    audit,
    auth: { password: PASSWORD, port: 3000 },
    desktop: { token: DESKTOP_TOKEN },
  });
}

/** Penyimpanan sandi yang dipakai app di JEJAK_HOME uji. */
function store(): FilePasswordStore {
  return new FilePasswordStore(join(dir, "home", "auth.json"));
}

function request(
  app: App,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { ...HOST, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function loginCookie(app: App, password = PASSWORD): Promise<string> {
  const res = await request(app, "POST", "/api/auth/login", { password });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function desktopCookie(app: App): Promise<string> {
  const res = await app.handle(
    new Request(`http://127.0.0.1:3000/__desktop/enter?t=${DESKTOP_TOKEN}`, { headers: HOST }),
  );
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("rute sandi akses", () => {
  test("rute sandi butuh sesi terautentikasi", async () => {
    const app = makeApp();
    const status = await request(app, "GET", "/api/auth/password");
    expect(status.status).toBe(401);
    const simpan = await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU });
    expect(simpan.status).toBe(401);
  });

  test("status sandi: belum ada lalu aktif setelah dibuat", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);

    const kosong = await request(app, "GET", "/api/auth/password", undefined, { cookie });
    expect(kosong.status).toBe(200);
    expect(await kosong.json()).toEqual({ configured: false });

    const simpan = await request(
      app,
      "PUT",
      "/api/auth/password",
      { password: SANDI_BARU },
      { cookie },
    );
    expect(simpan.status).toBe(200);
    const hasil = (await simpan.json()) as { ok: boolean; updatedAt?: string };
    expect(hasil.ok).toBe(true);
    expect(typeof hasil.updatedAt).toBe("string");

    const aktif = await request(app, "GET", "/api/auth/password", undefined, { cookie });
    const isi = (await aktif.json()) as { configured: boolean; updatedAt?: string };
    expect(isi.configured).toBe(true);
    expect(typeof isi.updatedAt).toBe("string");
  });

  test("sandi tersimpan bisa dipakai untuk masuk", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU }, { cookie });

    const masuk = await request(app, "POST", "/api/auth/login", { password: SANDI_BARU });
    expect(masuk.status).toBe(200);
    expect(await masuk.json()).toEqual({ ok: true });
  });

  test("sandi tersimpan berlaku langsung tanpa restart", async () => {
    const app = makeApp();
    // Disimpan lewat berkas langsung: perubahan berlaku tanpa restart.
    store().set(SANDI_BARU);

    const masuk = await request(app, "POST", "/api/auth/login", { password: SANDI_BARU });
    expect(masuk.status).toBe(200);
  });

  test("ganti sandi wajib memakai sandi lama yang benar", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU }, { cookie });

    const tanpaCurrent = await request(
      app,
      "PUT",
      "/api/auth/password",
      { password: "sandi-ketiga-789" },
      { cookie },
    );
    expect(tanpaCurrent.status).toBe(401);
    expect(await tanpaCurrent.json()).toEqual({ error: "sandi lama salah" });

    const salah = await request(
      app,
      "PUT",
      "/api/auth/password",
      { password: "sandi-ketiga-789", current: "sandi-bukan-itu" },
      { cookie },
    );
    expect(salah.status).toBe(401);

    const benar = await request(
      app,
      "PUT",
      "/api/auth/password",
      { password: "sandi-ketiga-789", current: SANDI_BARU },
      { cookie },
    );
    expect(benar.status).toBe(200);
    expect(store().verify("sandi-ketiga-789")).toBe(true);
    expect(store().verify(SANDI_BARU)).toBe(false);
  });

  test("current yang salah berulang diblokir throttle yang sama dengan login", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU }, { cookie });

    for (let index = 0; index < 5; index += 1) {
      const gagal = await request(
        app,
        "PUT",
        "/api/auth/password",
        { password: "sandi-ketiga-789", current: "sandi-salah" },
        { cookie },
      );
      expect(gagal.status).toBe(401);
    }
    const diblokir = await request(
      app,
      "PUT",
      "/api/auth/password",
      { password: "sandi-ketiga-789", current: "sandi-salah" },
      { cookie },
    );
    expect(diblokir.status).toBe(429);
    expect(diblokir.headers.get("retry-after")).toBe("2");
  });

  test("panjang sandi tak valid ditolak dengan pesan Indonesia", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);

    const pendek = await request(app, "PUT", "/api/auth/password", { password: "pendek" }, { cookie });
    expect(pendek.status).toBe(400);
    expect(await pendek.json()).toEqual({ error: "Kata sandi minimal 8 karakter." });

    const panjang = await request(
      app,
      "PUT",
      "/api/auth/password",
      { password: "a".repeat(257) },
      { cookie },
    );
    expect(panjang.status).toBe(400);
    expect(await panjang.json()).toEqual({ error: "Kata sandi maksimal 256 karakter." });
  });

  test("hapus sandi wajib memakai sandi lama yang benar", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU }, { cookie });

    const salah = await request(
      app,
      "DELETE",
      "/api/auth/password",
      { current: "sandi-bukan-itu" },
      { cookie },
    );
    expect(salah.status).toBe(401);

    const benar = await request(
      app,
      "DELETE",
      "/api/auth/password",
      { current: SANDI_BARU },
      { cookie },
    );
    expect(benar.status).toBe(200);
    expect(await benar.json()).toEqual({ ok: true });

    const status = await request(app, "GET", "/api/auth/password", undefined, { cookie });
    expect(await status.json()).toEqual({ configured: false });
    expect(store().has()).toBe(false);
  });

  test("hapus sandi tanpa sandi lama ditolak", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU }, { cookie });

    const res = await request(app, "DELETE", "/api/auth/password", {}, { cookie });
    expect(res.status).toBe(401);
    expect(store().has()).toBe(true);
  });

  test("audit mencatat aksi tanpa nilai sandi", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU }, { cookie });
    await request(
      app,
      "PUT",
      "/api/auth/password",
      { password: "sandi-ketiga-789", current: SANDI_BARU },
      { cookie },
    );
    await request(app, "DELETE", "/api/auth/password", { current: "sandi-ketiga-789" }, { cookie });

    const entries = audit.list({ kind: "pengaturan" });
    const actions = entries.map((entry) => entry.meta.aksi);
    expect(actions).toContain("sandi-diatur");
    expect(actions).toContain("sandi-diganti");
    expect(actions).toContain("sandi-dihapus");

    const dump = JSON.stringify(entries);
    expect(dump).not.toContain(SANDI_BARU);
    expect(dump).not.toContain("sandi-ketiga-789");
  });

  test("sandi tak pernah muncul di respons rute", async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);
    const simpan = await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU }, { cookie });
    const isi = await simpan.text();
    expect(isi).not.toContain(SANDI_BARU);
    const status = await request(app, "GET", "/api/auth/password", undefined, { cookie });
    expect(await status.text()).not.toContain(SANDI_BARU);
  });
});

describe("mode desktop", () => {
  test("manualLogin false tanpa sandi tersimpan dan true setelah sandi dibuat", async () => {
    const app = makeDesktopApp();
    const status = await request(app, "GET", "/api/auth/status");
    expect(await status.json()).toEqual({
      required: true,
      authenticated: false,
      manualLogin: false,
    });

    const cookie = await desktopCookie(app);
    await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU }, { cookie });

    const sesudah = await request(app, "GET", "/api/auth/status");
    expect(await sesudah.json()).toEqual({
      required: true,
      authenticated: false,
      manualLogin: true,
    });
  });

  test("keluar ditolak tanpa sandi tersimpan dan diizinkan dengan sandi tersimpan", async () => {
    const app = makeDesktopApp();
    const cookie = await desktopCookie(app);

    const tanpaSandi = await request(app, "POST", "/api/auth/logout", {}, { cookie });
    expect(tanpaSandi.status).toBe(404);
    expect(await tanpaSandi.json()).toEqual({
      error: "keluar tidak tersedia di aplikasi desktop",
    });

    await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU }, { cookie });

    const denganSandi = await request(app, "POST", "/api/auth/logout", {}, { cookie });
    expect(denganSandi.status).toBe(200);
    expect(denganSandi.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  test("sandi tersimpan bisa dipakai untuk masuk di desktop", async () => {
    const app = makeDesktopApp();
    const cookie = await desktopCookie(app);
    await request(app, "PUT", "/api/auth/password", { password: SANDI_BARU }, { cookie });

    const masuk = await request(app, "POST", "/api/auth/login", { password: SANDI_BARU });
    expect(masuk.status).toBe(200);
    expect(await masuk.json()).toEqual({ ok: true });
  });

  test("sandi internal desktop tetap bisa dipakai untuk masuk", async () => {
    const app = makeDesktopApp();
    const masuk = await request(app, "POST", "/api/auth/login", { password: PASSWORD });
    expect(masuk.status).toBe(200);
  });
});
