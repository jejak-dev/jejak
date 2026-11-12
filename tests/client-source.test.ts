import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getEmbeddedClientSource,
  loadEmbeddedClient,
  registerEmbeddedClient,
  resetEmbeddedClient,
  type ClientSource,
  type EmbeddedClientManifest,
} from "../src/server/client-source";
import { clientRoutes } from "../src/server/routes/client";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-client-source-"));
});

afterEach(async () => {
  resetEmbeddedClient();
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body, "utf8");
  return path;
}

/** Manifes tertanam dari berkas sementara: app.js, app.css, dan satu chunk. */
async function makeManifest(): Promise<EmbeddedClientManifest> {
  const js = await write("app.js", "console.log('klien-tertanam');\n");
  const css = await write("app.css", "body{color:red}\n");
  const chunk = await write("chunk-abc123.js", "console.log('chunk');\n");
  return {
    js,
    css,
    files: {
      "chunk-abc123.js": { path: chunk, contentType: "application/javascript; charset=utf-8" },
    },
  };
}

function get(app: ReturnType<typeof clientRoutes>, path: string): Promise<Response> {
  return app.handle(new Request(`http://127.0.0.1:3000${path}`));
}

describe("loadEmbeddedClient", () => {
  test("memuat js, css, dan berkas tambahan dari manifes", async () => {
    const manifest = await makeManifest();
    const bundle = await loadEmbeddedClient(manifest);

    expect(bundle.js).toContain("klien-tertanam");
    expect(bundle.css).toContain("color:red");
    expect(bundle.files.size).toBe(1);
    const chunk = bundle.files.get("chunk-abc123.js");
    expect(chunk).toBeDefined();
    expect(chunk?.body).toContain("chunk");
    expect(chunk?.contentType).toBe("application/javascript; charset=utf-8");
  });

  test("berkas hilang menghasilkan galat yang menyebut nama berkas", async () => {
    const manifest = await makeManifest();
    manifest.files["hilang.js"] = {
      path: join(dir, "hilang.js"),
      contentType: "application/javascript; charset=utf-8",
    };

    await expect(loadEmbeddedClient(manifest)).rejects.toThrow(/hilang\.js/);
  });
});

describe("clientRoutes dengan sumber eksplisit", () => {
  const source: ClientSource = async () => ({
    js: "console.log('sumber');\n",
    css: "body{color:blue}\n",
    files: new Map([
      ["chunk-xyz.js", { body: "console.log('chunk');\n", contentType: "application/javascript; charset=utf-8" }],
    ]),
  });

  test("menyajikan HTML, app.js, app.css, dan chunk dari sumber", async () => {
    const app = clientRoutes({ source });

    const html = await get(app, "/");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("content-security-policy")).toContain("default-src 'self'");

    const js = await get(app, "/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await js.text()).toContain("sumber");

    const css = await get(app, "/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toContain("color:blue");

    const chunk = await get(app, "/chunk-xyz.js");
    expect(chunk.status).toBe(200);
    expect(chunk.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(chunk.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await chunk.text()).toContain("chunk");
  });

  test("nama tak dikenal dan nama traversal menjawab 404 JSON", async () => {
    const app = clientRoutes({ source });
    for (const path of ["/tidak-ada.js", "/a..b.js", "/%2e%2e.js"]) {
      const res = await get(app, path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      const data = (await res.json()) as { error: string };
      expect(typeof data.error).toBe("string");
      expect(data.error.length).toBeGreaterThan(0);
    }
  });

  test("sumber yang melempar menjawab 500 dengan isi {error}", async () => {
    const app = clientRoutes({
      source: async () => {
        throw new Error("gagal memuat klien uji");
      },
    });

    const res = await get(app, "/app.js");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("gagal memuat klien uji");
  });
});

describe("klien tertanam terdaftar", () => {
  test("dipakai secara default tanpa menyentuh pembangun runtime", async () => {
    const manifest = await makeManifest();
    registerEmbeddedClient(manifest);

    // Entry tidak ada: bila pembangun runtime tersentuh, permintaan gagal.
    const app = clientRoutes({ entry: join(dir, "tidak-ada.ts") });

    const js = await get(app, "/app.js");
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("klien-tertanam");

    const css = await get(app, "/app.css");
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("color:red");

    const chunk = await get(app, "/chunk-abc123.js");
    expect(chunk.status).toBe(200);
    expect(await chunk.text()).toContain("chunk");
  });

  test("sumber eksplisit mengalahkan klien tertanam", async () => {
    registerEmbeddedClient(await makeManifest());

    const app = clientRoutes({
      entry: join(dir, "tidak-ada.ts"),
      source: async () => ({
        js: "console.log('eksplisit');\n",
        css: "",
        files: new Map(),
      }),
    });

    const js = await get(app, "/app.js");
    expect(js.status).toBe(200);
    expect(await js.text()).toContain("eksplisit");
  });

  test("getEmbeddedClientSource mengembalikan undefined bila belum ada", () => {
    expect(getEmbeddedClientSource()).toBeUndefined();
  });

  test("pendaftaran ulang menimpa manifes sebelumnya", async () => {
    registerEmbeddedClient(await makeManifest());
    const kedua = await write("kedua.js", "console.log('kedua');\n");
    registerEmbeddedClient({
      js: kedua,
      css: kedua,
      files: {},
    });

    const source = getEmbeddedClientSource();
    expect(source).toBeDefined();
    const bundle = await (source as ClientSource)();
    expect(bundle.js).toContain("kedua");
  });
});
