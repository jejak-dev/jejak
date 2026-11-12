import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { buildClientBundle } from "../src/server/client-bundle";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-client-routes-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeApp(client: { dev?: boolean; entry?: string } = {}) {
  return createApp({
    providersPath: join(dir, "providers.json"),
    env: { MOCK: "true" },
    runner: {
      async *run() {
        yield { type: "result", ok: true } as const;
      },
    },
    client,
  });
}

function get(app: ReturnType<typeof createApp>, path: string): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, { headers: { host: "127.0.0.1:3000" } }),
  );
}

async function writeEntry(name: string, body: string): Promise<string> {
  const entry = join(dir, name);
  await writeFile(entry, body, "utf8");
  return entry;
}

describe("GET /", () => {
  test("menyajikan HTML shell dengan CSP dan nosniff", async () => {
    const res = await get(makeApp(), "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    const html = await res.text();
    expect(html).toContain('<div id="app">');
    expect(html).toContain("/app.js");
    expect(html).toContain("/app.css");
  });
});

describe("GET /app.js dan /app.css", () => {
  test("menyajikan javascript dan css hasil build", async () => {
    const app = makeApp();

    const js = await get(app, "/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    const jsText = await js.text();
    expect(jsText.length).toBeGreaterThan(0);
    expect(jsText).toContain("Jejak");

    const css = await get(app, "/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await css.text()).length).toBeGreaterThan(0);
  });

  test("entri rusak menghasilkan 500 JSON dan server tetap hidup", async () => {
    const entry = await writeEntry("rusak.tsx", "export const x = <div>;\n");
    const app = makeApp({ entry });

    const res = await get(app, "/app.js");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("gagal membangun klien");
    expect(data.error).not.toContain(dir);

    const health = await get(app, "/api/health");
    expect(health.status).toBe(200);
  });

  test("mode dev membangun ulang tiap permintaan", async () => {
    const entry = await writeEntry("dev.ts", 'export const teks = "versi-satu";\n');
    const app = makeApp({ dev: true, entry });

    const first = await (await get(app, "/app.js")).text();
    expect(first).toContain("versi-satu");

    await writeFile(entry, 'export const teks = "versi-dua";\n', "utf8");

    const second = await (await get(app, "/app.js")).text();
    expect(second).toContain("versi-dua");
    expect(second).not.toContain("versi-satu");
  });

  test("mode non-dev meng-cache hasil build", async () => {
    const entry = await writeEntry("cache.ts", 'export const teks = "versi-satu";\n');
    const app = makeApp({ dev: false, entry });

    const first = await (await get(app, "/app.js")).text();
    expect(first).toContain("versi-satu");

    await writeFile(entry, 'export const teks = "versi-dua";\n', "utf8");

    const second = await (await get(app, "/app.js")).text();
    expect(second).toBe(first);
  });
});

describe("GET /:file (chunk hasil code-splitting)", () => {
  test("menyajikan chunk bundel sebagai javascript", async () => {
    const bundle = await buildClientBundle();
    const name = [...bundle.files.keys()].find((key) => key.startsWith("chunk-"));
    expect(name).toBeDefined();

    const res = await get(makeApp(), `/${name as string}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  test("nama tak dikenal dan nama traversal menjawab 404 JSON", async () => {
    const app = makeApp();
    for (const path of ["/tidak-ada.js", "/a..b.js", "/%2e%2e.js"]) {
      const res = await get(app, path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const data = (await res.json()) as { error: string };
      expect(typeof data.error).toBe("string");
      expect(data.error.length).toBeGreaterThan(0);
    }
  });

  test("nama bertingkat tidak dilayani", async () => {
    const res = await get(makeApp(), "/satu/dua.js");
    expect(res.status).toBe(404);
  });

  test("rute lain tidak tertimpa oleh rute param", async () => {
    const app = makeApp();
    expect((await get(app, "/")).status).toBe(200);
    expect((await get(app, "/app.js")).status).toBe(200);
    expect((await get(app, "/app.css")).status).toBe(200);
    expect((await get(app, "/api/health")).status).toBe(200);
  });
});
