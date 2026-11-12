import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";

const PASSWORD = "sandi-uji-123";

/** CSP harus tetap sama; tugas PWA tidak boleh melonggarkan kebijakan. */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'none'";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-client-pwa-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function makeApp(auth = false): App {
  return createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    ...(auth ? { auth: { password: PASSWORD, port: 3000 } } : {}),
  });
}

function get(app: App, path: string): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, { headers: { host: "127.0.0.1:3000" } }),
  );
}

describe("rute aset PWA", () => {
  test("manifest disajikan sebagai application/manifest+json", async () => {
    const res = await get(makeApp(), "/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const data = (await res.json()) as { name: string; start_url: string; display: string };
    expect(data.name).toBe("Jejak");
    expect(data.start_url).toBe("/");
    expect(data.display).toBe("standalone");
  });

  test("ikon disajikan sebagai image/svg+xml", async () => {
    for (const path of ["/icon.svg", "/icon-maskable.svg"]) {
      const res = await get(makeApp(), path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const svg = await res.text();
      expect(svg).toContain("<svg");
      expect(svg).not.toContain("<script");
    }
  });

  test("service worker disajikan sebagai javascript dan tidak di-cache browser", async () => {
    const res = await get(makeApp(), "/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  test("aset tetap terbuka saat autentikasi aktif", async () => {
    const app = makeApp(true);
    for (const path of ["/manifest.webmanifest", "/icon.svg", "/icon-maskable.svg", "/sw.js"]) {
      const res = await get(app, path);
      expect(res.status).toBe(200);
    }
  });

  test("rute param tidak menimpa rute statis dan nama tak dikenal tetap 404", async () => {
    const app = makeApp();
    for (const path of ["/tidak-ada.js", "/a..b.js", "/manifest.webmanifest2"]) {
      const res = await get(app, path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
    expect((await get(app, "/manifest.webmanifest")).status).toBe(200);
    expect((await get(app, "/sw.js")).status).toBe(200);
  });
});

describe("HTML untuk mode aplikasi", () => {
  test("memuat link manifest, ikon, dan theme-color", async () => {
    const res = await get(makeApp(), "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icon.svg">');
    expect(html).toContain('<meta name="theme-color" content="#faf9f6" media="(prefers-color-scheme: light)">');
    expect(html).toContain('<meta name="theme-color" content="#1d1c1a" media="(prefers-color-scheme: dark)">');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
    expect(html).toContain('<meta name="mobile-web-app-capable" content="yes">');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default">');
  });

  test("viewport memakai viewport-fit=cover dan interactive-widget", async () => {
    const res = await get(makeApp(), "/");
    const html = await res.text();
    expect(html).toContain("width=device-width,initial-scale=1,viewport-fit=cover");
    expect(html).toContain("interactive-widget=resizes-content");
  });

  test("CSP tidak berubah", async () => {
    const res = await get(makeApp(), "/");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
  });
});
