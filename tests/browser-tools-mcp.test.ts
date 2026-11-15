import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { BrowserManager, type BrowserProcess } from "../src/server/browser/browser-manager";
import {
  WEB_CONTENT_FOOTER,
  WEB_CONTENT_HEADER,
} from "../src/server/browser/browser-tools";
import { locateChrome } from "../src/server/browser/chrome-locator";
import type { MemoryBridge } from "../src/server/memory/memory-bridge";
import { KoneksiPalsu } from "./browser-fake-cdp";

const HALAMAN = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>jejak-lokal</title></head>
  <body><h1>halo dari halaman lokal</h1><button id="tombol">Kirim</button></body>
</html>`;

const HOST = "127.0.0.1:3000";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-browser-mcp-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Server lokal untuk halaman uji. */
function jalankanServer(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(HALAMAN, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  return { port: server.port ?? 0, stop: () => server.stop(true) };
}

/** Proses Chrome palsu untuk manajer dengan CDP palsu. */
function prosesPalsu(): BrowserProcess {
  return {
    pid: 4242,
    exited: new Promise<number>(() => undefined),
    kill: (): void => undefined,
  };
}

/** Panggil /mcp pada aplikasi Jejak dengan token sesi. */
async function mcp(
  app: ReturnType<typeof createApp>,
  token: string,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const res = await app.handle(
    new Request("http://127.0.0.1:3000/mcp", {
      method: "POST",
      headers: {
        host: HOST,
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

/** Teks hasil tools/call. */
function teksPanggilan(hasil: Record<string, unknown>): string {
  const result = hasil.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? "";
}

describe("tool browser lewat /mcp (CDP palsu)", () => {
  test("initialize, tools/list, navigate, dan snapshot lewat token sesi", async () => {
    const server = jalankanServer();
    const halaman = await fetch(`http://127.0.0.1:${server.port}/`).then((res) => res.text());
    const koneksi = new KoneksiPalsu();
    koneksi.snapshot = {
      url: `http://127.0.0.1:${server.port}/`,
      title: "jejak-lokal",
      text: "halo dari halaman lokal",
      elements: [{ ref: 1, tag: "button", name: "Kirim", x: 10, y: 20 }],
    };
    const manager = new BrowserManager({
      env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: "/fake/chrome" },
      platform: "linux",
      exists: (path) => path === "/fake/chrome",
      spawn: () => prosesPalsu(),
      connect: async () => koneksi,
      readDevToolsPort: () => ({ port: 9222, path: "/devtools/browser/abc" }),
    });

    const app = createApp({
      providersPath: join(dir, "providers.json"),
      env: { MOCK: "true", JEJAK_HOME: dir },
      browser: manager,
    });
    let opened: Awaited<ReturnType<MemoryBridge["open"]>> | undefined;
    try {
      const bridge = (app as unknown as { memoryBridge: MemoryBridge }).memoryBridge;
      opened = await bridge.open({ sessionId: "s_e2e", cwd: dir });
      const token = opened.memory.token ?? "";

      const init = await mcp(app, token, "initialize", { protocolVersion: "2025-06-18" });
      expect((init.result as { protocolVersion?: string } | undefined)?.protocolVersion).toBe(
        "2025-06-18",
      );

      const list = await mcp(app, token, "tools/list");
      const result = list.result as { tools?: Array<{ name?: string }> } | undefined;
      const nama = (result?.tools ?? []).map((tool) => tool.name ?? "");
      expect(nama).toContain("browser_tabs");
      expect(nama).toContain("browser_snapshot");
      expect(nama).toContain("browser_screenshot");
      expect(nama).toContain("browser_navigate");

      const nav = await mcp(app, token, "tools/call", {
        name: "browser_navigate",
        arguments: { url: `http://127.0.0.1:${server.port}/` },
      });
      expect((nav.result as { isError?: boolean } | undefined)?.isError).toBe(false);
      expect(teksPanggilan(nav)).toContain(WEB_CONTENT_HEADER);
      expect(koneksi.calls("Page.navigate")).toHaveLength(1);

      const snap = await mcp(app, token, "tools/call", {
        name: "browser_snapshot",
        arguments: {},
      });
      const teks = teksPanggilan(snap);
      expect(teks.startsWith(WEB_CONTENT_HEADER)).toBe(true);
      expect(teks.endsWith(WEB_CONTENT_FOOTER)).toBe(true);
      expect(teks).toContain("halo dari halaman lokal");
      expect(teks).toContain("[1] button");
      expect(halaman).toContain("halo dari halaman lokal");

      // Screenshot: blok gambar plus teks ringkas.
      const shot = await mcp(app, token, "tools/call", {
        name: "browser_screenshot",
        arguments: {},
      });
      const content = (shot.result as { content?: Array<Record<string, unknown>> } | undefined)
        ?.content;
      const blokGambar = content?.find((blok) => blok.type === "image");
      expect(blokGambar?.data).toBe("YmVuaWgtMTE=");
      expect(blokGambar?.mimeType).toBe("image/jpeg");
      const blokTeks = content?.find((blok) => blok.type === "text");
      expect(String(blokTeks?.text ?? "")).toContain("1280x800");
      expect(String(blokTeks?.text ?? "")).not.toContain("YmVuaWgtMTE=");
    } finally {
      opened?.close();
      await manager.close();
      server.stop();
    }
  });
});

const chrome = locateChrome(process.env, process.platform, existsSync);
const bolehChrome = process.env.JEJAK_TEST_CHROME?.trim() === "1" && chrome !== undefined;

describe("tool browser lewat /mcp (Chrome nyata)", () => {
  test.skipIf(!bolehChrome)("snapshot mengembalikan teks halaman lokal dalam pembungkus", async () => {
    const server = jalankanServer();
    const manager = new BrowserManager({
      env: { JEJAK_HOME: dir, JEJAK_CHROME_PATH: chrome },
      platform: process.platform,
      exists: existsSync,
    });
    const app = createApp({
      providersPath: join(dir, "providers.json"),
      env: { MOCK: "true", JEJAK_HOME: dir },
      browser: manager,
    });
    let opened: Awaited<ReturnType<MemoryBridge["open"]>> | undefined;
    try {
      const bridge = (app as unknown as { memoryBridge: MemoryBridge }).memoryBridge;
      opened = await bridge.open({ sessionId: "s_e2e_chrome", cwd: dir });
      const token = opened.memory.token ?? "";

      const nav = await mcp(app, token, "tools/call", {
        name: "browser_navigate",
        arguments: { url: `http://127.0.0.1:${server.port}/` },
      });
      expect((nav.result as { isError?: boolean } | undefined)?.isError).toBe(false);

      // Tunggu halaman selesai dimuat.
      for (let i = 0; i < 100; i += 1) {
        if (manager.state().loading === false) break;
        await Bun.sleep(100);
      }

      const snap = await mcp(app, token, "tools/call", {
        name: "browser_snapshot",
        arguments: {},
      });
      const teks = teksPanggilan(snap);
      expect(teks.startsWith(WEB_CONTENT_HEADER)).toBe(true);
      expect(teks.endsWith(WEB_CONTENT_FOOTER)).toBe(true);
      expect(teks).toContain("halo dari halaman lokal");
    } finally {
      await manager.close();
      server.stop();
    }
  });
});
