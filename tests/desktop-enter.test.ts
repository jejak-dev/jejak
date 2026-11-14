import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { DESKTOP_ENTER_PATH } from "../src/server/desktop";

const TOKEN = "token-desktop-uji-abcdefghijklmnop";
const INTERNAL_PASSWORD = "sandi-internal-acak-yang-tak-ditebak";
const HOST = { host: "127.0.0.1:3000" };
/** Max-Age cookie sesi mode desktop: 30 hari dalam detik. */
const THIRTY_DAYS = 30 * 24 * 60 * 60;

let dir: string;

type App = ReturnType<typeof createApp>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-desktop-enter-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeApp(options: { desktop?: boolean } = {}): App {
  return createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    auth: { password: INTERNAL_PASSWORD, port: 3000 },
    ...(options.desktop === false ? {} : { desktop: { token: TOKEN } }),
  });
}

function get(
  app: App,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, { headers: { ...HOST, ...headers } }));
}

describe("rute masuk desktop", () => {
  test("token benar memberi 302 ke / dan cookie sesi", async () => {
    const app = makeApp();
    const res = await get(app, `${DESKTOP_ENTER_PATH}?t=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain(`Max-Age=${THIRTY_DAYS}`);
    expect(cookie).toContain("jejak_sid_3000");
  });

  test("respons anti bocor: referrer dan cache", async () => {
    const app = makeApp();
    const res = await get(app, `${DESKTOP_ENTER_PATH}?t=${TOKEN}`);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("token dipakai kedua kali ditolak", async () => {
    const app = makeApp();
    const pertama = await get(app, `${DESKTOP_ENTER_PATH}?t=${TOKEN}`);
    expect(pertama.status).toBe(302);
    const kedua = await get(app, `${DESKTOP_ENTER_PATH}?t=${TOKEN}`);
    expect(kedua.status).toBe(403);
  });

  test("token salah ditolak", async () => {
    const app = makeApp();
    const res = await get(app, `${DESKTOP_ENTER_PATH}?t=${"x".repeat(32)}`);
    expect(res.status).toBe(403);
  });

  test("tanpa parameter token ditolak", async () => {
    const app = makeApp();
    const res = await get(app, DESKTOP_ENTER_PATH);
    expect([400, 403]).toContain(res.status);
  });

  test("token dengan panjang berbeda tidak melempar", async () => {
    const app = makeApp();
    const res = await get(app, `${DESKTOP_ENTER_PATH}?t=pendek`);
    expect(res.status).toBe(403);
  });

  test("rute tidak ada pada mode biasa", async () => {
    const app = makeApp({ desktop: false });
    const res = await get(app, `${DESKTOP_ENTER_PATH}?t=${TOKEN}`);
    expect(res.status).toBe(404);
  });

  test("host buruk ditolak penjaga lokal", async () => {
    const app = makeApp();
    const res = await app.handle(
      new Request(`http://evil.test${DESKTOP_ENTER_PATH}?t=${TOKEN}`),
    );
    expect(res.status).toBe(403);
  });

  test("origin buruk ditolak penjaga lokal", async () => {
    const app = makeApp();
    const res = await get(app, `${DESKTOP_ENTER_PATH}?t=${TOKEN}`, {
      origin: "http://evil.test",
    });
    expect(res.status).toBe(403);
  });

  test("cookie hasil masuk membuka rute terproteksi", async () => {
    const app = makeApp();
    const masuk = await get(app, `${DESKTOP_ENTER_PATH}?t=${TOKEN}`);
    const cookie = (masuk.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).not.toBe("");

    const tanpa = await get(app, "/api/sessions");
    expect(tanpa.status).toBe(401);

    const dengan = await get(app, "/api/sessions", { cookie });
    expect(dengan.status).toBe(200);
  });

  test("login kata sandi tak bisa ditebak", async () => {
    const app = makeApp();
    for (const tebakan of ["", "password", "admin", "jejak", INTERNAL_PASSWORD + "x"]) {
      const res = await app.handle(
        new Request("http://127.0.0.1:3000/api/auth/login", {
          method: "POST",
          headers: { ...HOST, "content-type": "application/json" },
          body: JSON.stringify({ password: tebakan }),
        }),
      );
      expect(res.status).toBe(401);
    }
  });
});
