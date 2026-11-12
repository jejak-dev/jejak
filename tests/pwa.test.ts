import { describe, expect, test } from "bun:test";
import {
  ICON_MASKABLE_SVG,
  ICON_SVG,
  MANIFEST,
  SERVICE_WORKER,
  shouldHandle,
} from "../src/server/pwa";

const ORIGIN = "http://127.0.0.1:3000";

describe("manifes PWA", () => {
  test("bentuk JSON dengan field wajib", () => {
    const data = JSON.parse(MANIFEST) as {
      name: string;
      short_name: string;
      description: string;
      start_url: string;
      scope: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };
    expect(data.name).toBe("Jejak");
    expect(data.short_name).toBe("Jejak");
    expect(data.description.length).toBeGreaterThan(0);
    expect(data.start_url).toBe("/");
    expect(data.scope).toBe("/");
    expect(data.display).toBe("standalone");
    expect(data.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(data.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(data.icons.length).toBeGreaterThan(0);
    expect(data.icons.some((icon) => icon.type === "image/svg+xml")).toBe(true);
    expect(data.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
  });
});

describe("ikon SVG", () => {
  test("bebas skrip dan referensi luar", () => {
    for (const svg of [ICON_SVG, ICON_MASKABLE_SVG]) {
      expect(svg).toContain("<svg");
      expect(svg).not.toContain("<script");
      expect(svg).not.toContain("onload");
      expect(svg).not.toContain('href="http');
    }
  });

  test("memuat warna aksen teal logo", () => {
    expect(ICON_SVG).toContain("#2DD4BF");
    expect(ICON_MASKABLE_SVG).toContain("#2DD4BF");
  });

  test("berkas assets/logo.svg identik dengan ICON_SVG", async () => {
    const berkas = Bun.file(new URL("../assets/logo.svg", import.meta.url));
    expect(await berkas.exists()).toBe(true);
    expect(await berkas.text()).toBe(ICON_SVG);
  });
});

describe("pemilihshouldHandle", () => {
  test("menangani cangkang antarmuka saja", () => {
    expect(shouldHandle(new URL(`${ORIGIN}/`), ORIGIN)).toBe(true);
    expect(shouldHandle(new URL(`${ORIGIN}/app.js`), ORIGIN)).toBe(true);
    expect(shouldHandle(new URL(`${ORIGIN}/app.css`), ORIGIN)).toBe(true);
    expect(shouldHandle(new URL(`${ORIGIN}/chunk-abc.js`), ORIGIN)).toBe(true);
  });

  test("tidak menangani data sesi, MCP, service worker, dan origin lain", () => {
    expect(shouldHandle(new URL(`${ORIGIN}/api/sessions`), ORIGIN)).toBe(false);
    expect(shouldHandle(new URL(`${ORIGIN}/api/health`), ORIGIN)).toBe(false);
    expect(shouldHandle(new URL(`${ORIGIN}/mcp`), ORIGIN)).toBe(false);
    expect(shouldHandle(new URL(`${ORIGIN}/sw.js`), ORIGIN)).toBe(false);
    expect(shouldHandle(new URL("https://lain.example/app.js"), ORIGIN)).toBe(false);
  });
});

describe("skrip service worker", () => {
  test("menyebut pengecualian /api/ dan tidak pernah cache.put ke /api", () => {
    expect(SERVICE_WORKER).toContain("/api/");
    expect(SERVICE_WORKER).toContain("jejak-shell-v1");
    expect(SERVICE_WORKER).not.toMatch(/cache\.put\([^)]*\/api/);
    expect(SERVICE_WORKER).toContain("skipWaiting");
    expect(SERVICE_WORKER).toContain("clients.claim");
  });
});

/* -*- Sandbox service worker -*- */

interface FakeRequest {
  method: string;
  url: string;
  mode: string;
}

interface FakeEvent {
  request: FakeRequest;
  respondWith: (value: Promise<Response>) => void;
  waitUntil: (value: Promise<unknown>) => void;
}

type Handler = (event: FakeEvent) => void;

function kunci(url: string | { url: string }): string {
  const mentah = typeof url === "string" ? url : url.url;
  return new URL(mentah, ORIGIN).pathname;
}

interface Sandbox {
  listeners: Map<string, Handler>;
  isi: Map<string, Map<string, Response>>;
}

function buatSandbox(fetchImpl: (url: string) => Promise<Response>): Sandbox {
  const listeners = new Map<string, Handler>();
  const isi = new Map<string, Map<string, Response>>();

  const cachesApi = {
    async open(name: string) {
      let isiCache = isi.get(name);
      if (isiCache === undefined) {
        isiCache = new Map<string, Response>();
        isi.set(name, isiCache);
      }
      const cache = isiCache;
      return {
        async addAll(urls: string[]) {
          for (const url of urls) cache.set(kunci(url), new Response("cangkang", { status: 200 }));
        },
        async put(request: { url: string }, response: Response) {
          cache.set(kunci(request), response);
        },
      };
    },
    async keys(): Promise<string[]> {
      return [...isi.keys()];
    },
    async delete(name: string): Promise<boolean> {
      return isi.delete(name);
    },
    async match(request: { url: string }): Promise<Response | undefined> {
      const path = kunci(request);
      for (const cache of isi.values()) {
        const hit = cache.get(path);
        if (hit !== undefined) return hit;
      }
      return undefined;
    },
  };

  const self = {
    addEventListener(type: string, handler: Handler) {
      listeners.set(type, handler);
    },
    location: { origin: ORIGIN },
    skipWaiting: () => undefined,
    clients: { claim: () => undefined },
  };

  // Skrip dievaluasi di lingkungan kecil: self, caches, dan fetch palsu.
  const jalankan = new Function("self", "caches", "fetch", SERVICE_WORKER) as (
    s: unknown,
    c: unknown,
    f: unknown,
  ) => void;
  jalankan(self, cachesApi, fetchImpl);

  return { listeners, isi };
}

function tembak(
  sandbox: Sandbox,
  path: string,
  options: { method?: string; mode?: string } = {},
): Promise<Response> | undefined {
  let hasil: Promise<Response> | undefined;
  const event: FakeEvent = {
    request: {
      method: options.method ?? "GET",
      url: `${ORIGIN}${path}`,
      mode: options.mode ?? "cors",
    },
    respondWith: (value) => {
      hasil = value;
    },
    waitUntil: () => undefined,
  };
  const handler = sandbox.listeners.get("fetch");
  expect(handler).toBeDefined();
  handler?.(event);
  return hasil;
}

describe("perilaku service worker di sandbox", () => {
  test("hanya cangkang antarmuka yang ditangani", async () => {
    const sandbox = buatSandbox(async () => new Response("ok", { status: 200 }));
    for (const path of ["/api/sessions", "/mcp", "/api/health", "/sw.js"]) {
      expect(tembak(sandbox, path)).toBeUndefined();
    }
    expect(tembak(sandbox, "/")).toBeDefined();
    expect(tembak(sandbox, "/app.js")).toBeDefined();
    expect(tembak(sandbox, "/app.css")).toBeDefined();
    expect(tembak(sandbox, "/chunk-abc.js")).toBeDefined();
  });

  test("origin lain dibiarkan ke jaringan", async () => {
    const sandbox = buatSandbox(async () => new Response("ok", { status: 200 }));
    let hasil: Promise<Response> | undefined;
    const event: FakeEvent = {
      request: { method: "GET", url: "https://lain.example/app.js", mode: "cors" },
      respondWith: (value) => {
        hasil = value;
      },
      waitUntil: () => undefined,
    };
    sandbox.listeners.get("fetch")?.(event);
    expect(hasil).toBeUndefined();
  });

  test("permintaan non-GET dibiarkan ke jaringan", async () => {
    const sandbox = buatSandbox(async () => new Response("ok", { status: 200 }));
    expect(tembak(sandbox, "/app.js", { method: "POST" })).toBeUndefined();
  });

  test("install menyimpan cangkang di cache jejak-shell-v1", async () => {
    const sandbox = buatSandbox(async () => new Response("ok", { status: 200 }));
    let sampai: Promise<unknown> | undefined;
    sandbox.listeners.get("install")?.({
      request: { method: "GET", url: `${ORIGIN}/`, mode: "cors" },
      respondWith: () => undefined,
      waitUntil: (value) => {
        sampai = value;
      },
    });
    await sampai;
    const cache = sandbox.isi.get("jejak-shell-v1");
    expect(cache).toBeDefined();
    expect([...(cache?.keys() ?? [])].sort()).toEqual(["/", "/app.css", "/app.js"]);
  });

  test("activate menghapus cache lama berawalan jejak-", async () => {
    const sandbox = buatSandbox(async () => new Response("ok", { status: 200 }));
    sandbox.isi.set("jejak-shell-v0", new Map());
    sandbox.isi.set("jejak-shell-v1", new Map());
    sandbox.isi.set("lainnya", new Map());
    let sampai: Promise<unknown> | undefined;
    sandbox.listeners.get("activate")?.({
      request: { method: "GET", url: `${ORIGIN}/`, mode: "cors" },
      respondWith: () => undefined,
      waitUntil: (value) => {
        sampai = value;
      },
    });
    await sampai;
    expect([...sandbox.isi.keys()].sort()).toEqual(["jejak-shell-v1", "lainnya"]);
  });

  test("network-first, lalu jatuh ke cache saat jaringan gagal", async () => {
    const sandbox = buatSandbox(async () => new Response("dari jaringan", { status: 200 }));
    const install = sandbox.listeners.get("install");
    install?.({
      request: { method: "GET", url: `${ORIGIN}/`, mode: "cors" },
      respondWith: () => undefined,
      waitUntil: () => undefined,
    });
    // Pasang cangkang secara manual supaya bisa diuji tanpa jaringan.
    sandbox.isi.set("jejak-shell-v1", new Map([["/", new Response("dari cache", { status: 200 })]]));

    const online = await tembak(sandbox, "/");
    expect(online).toBeDefined();
    expect(await (online as Response).text()).toBe("dari jaringan");

    const offline = buatSandbox(async () => {
      throw new Error("jaringan mati");
    });
    offline.isi.set("jejak-shell-v1", new Map([["/", new Response("dari cache", { status: 200 })]]));
    const jatuh = await tembak(offline, "/", { mode: "navigate" });
    expect(jatuh).toBeDefined();
    expect(await (jatuh as Response).text()).toBe("dari cache");
  });

  test("hanya response.ok yang disimpan", async () => {
    const sandbox = buatSandbox(async () => new Response("gagal", { status: 500 }));
    const hasil = tembak(sandbox, "/app.js");
    expect(hasil).toBeDefined();
    await hasil;
    // Tunggu antrean cache.put (pembuatan salinan bersifat asinkron).
    await Bun.sleep(10);
    const cache = sandbox.isi.get("jejak-shell-v1");
    expect(cache?.get("/app.js")).toBeUndefined();
  });
});
