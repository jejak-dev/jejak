import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import type { BrowserFrame, BrowserState } from "../src/server/browser/browser-manager";
import type { BrowserManager } from "../src/server/browser/browser-manager";

/** Manajer browser palsu: tanpa Chrome, tapi bisa disuruh mengalir frame. */
class BrowserPalsu {
  readonly dipanggil: string[] = [];
  private readonly pendengar = new Set<(frame: BrowserFrame) => void>();
  keadaan: BrowserState = {
    status: "mati",
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
  };

  async ensure(): Promise<void> {
    this.dipanggil.push("ensure");
    this.keadaan = { ...this.keadaan, status: "menyala" };
  }

  state(): BrowserState {
    return this.keadaan;
  }

  async navigate(url: unknown): Promise<BrowserState> {
    this.dipanggil.push(`navigate:${String(url)}`);
    this.keadaan = { ...this.keadaan, status: "menyala", url: String(url) };
    return this.keadaan;
  }

  subscribe(listener: (frame: BrowserFrame) => void): () => void {
    this.pendengar.add(listener);
    return () => this.pendengar.delete(listener);
  }

  async close(): Promise<void> {
    this.dipanggil.push("close");
    this.keadaan = { ...this.keadaan, status: "mati" };
  }

  /** Kirim satu frame ke pelanggan yang sedang listening. */
  kirimFrame(frame: BrowserFrame): void {
    for (const listener of this.pendengar) listener(frame);
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-browser-rute-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Setup {
  app: ReturnType<typeof createApp>;
  audit: SqliteAuditStore;
  browser: BrowserPalsu;
  req: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
}

function setup(options: { aktif?: boolean } = {}): Setup {
  const audit = new SqliteAuditStore(":memory:");
  const browser = new BrowserPalsu();
  const app = createApp({
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home"), JEJAK_WORKTREES: "0" },
    audit,
    ...(options.aktif === false ? {} : { browser: browser as unknown as BrowserManager }),
  });
  const req = (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response> => {
    const merged: Record<string, string> = { host: "127.0.0.1:3000", ...headers };
    const init: RequestInit = { method, headers: merged };
    if (body !== undefined) {
      merged["content-type"] = merged["content-type"] ?? "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
  };
  return { app, audit, browser, req };
}

const DISABLED = "Browser dimatikan. Jalankan Jejak dengan JEJAK_BROWSER=1 untuk menyalakannya.";

describe("rute browser", () => {
  test("tanpa manajer semua rute menjawab 503", async () => {
    const { req, audit } = setup({ aktif: false });
    for (const [method, path] of [
      ["GET", "/api/browser"],
      ["POST", "/api/browser/navigate"],
      ["GET", "/api/browser/stream"],
      ["DELETE", "/api/browser"],
    ] as const) {
      const res = await req(
        method,
        path,
        method === "GET" ? undefined : method === "POST" ? { url: "https://a.test" } : {},
      );
      expect(res.status).toBe(503);
      const payload = (await res.json()) as { error?: string };
      expect(payload.error).toBe(DISABLED);
    }
    audit.close();
  });

  test("state tidak Repliesan Chrome", async () => {
    const { req, browser, audit } = setup();
    const res = await req("GET", "/api/browser");
    expect(res.status).toBe(200);
    const payload = (await res.json()) as BrowserState;
    expect(payload.status).toBe("mati");
    expect(browser.dipanggil).toEqual([]);
    audit.close();
  });

  test("navigate mengembalikan state dan mencatat audit tanpa isi halaman", async () => {
    const { req, browser, audit } = setup();
    const res = await req("POST", "/api/browser/navigate", { url: "https://example.com" });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as BrowserState;
    expect(payload.url).toBe("https://example.com");
    expect(browser.dipanggil).toEqual(["navigate:https://example.com"]);

    const entries = audit.list();
    const catatan = entries.find((entry) => entry.meta.aksi === "browser-dinavigasi");
    expect(catatan).toBeDefined();
    expect(catatan?.meta.url).toBe("https://example.com");
    // Isi halaman tak pernah ikut dicatat.
    expect(Object.keys(catatan?.meta ?? {}).sort()).toEqual(["aksi", "url"]);
    audit.close();
  });

  test("body navigate divalidasi", async () => {
    const { req, audit } = setup();
    const asing = await req("POST", "/api/browser/navigate", { url: "https://a.test", cmd: "ls" });
    expect(asing.status).toBe(400);
    const rusak = await req("POST", "/api/browser/navigate", "{bukan json");
    expect(rusak.status).toBe(400);
    const kosong = await req("POST", "/api/browser/navigate", {});
    expect(kosong.status).toBe(400);
    audit.close();
  });

  test("aliran SSE mengirim state lalu frame", async () => {
    const { req, browser, audit } = setup();
    const res = await req("GET", "/api/browser/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(browser.dipanggil).toContain("ensure");

    browser.kirimFrame({ data: "aW1n", width: 1280, height: 800, ts: 1 });
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    let teks = "";
    const decoder = new TextDecoder();
    while (teks.indexOf("event: frame") < 0) {
      const bagian = await reader!.read();
      if (bagian.done) break;
      teks += decoder.decode(bagian.value, { stream: true });
    }
    expect(teks.indexOf("event: state")).toBeGreaterThanOrEqual(0);
    expect(teks.indexOf("event: state")).toBeLessThan(teks.indexOf("event: frame"));
    expect(teks).toContain("aW1n");
    await reader!.cancel();
    audit.close();
  });

  test("delete menutup browser", async () => {
    const { req, browser, audit } = setup();
    const res = await req("DELETE", "/api/browser", {});
    expect(res.status).toBe(200);
    expect(browser.dipanggil).toContain("close");
    audit.close();
  });
});
