import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import type { BrowserFrame, BrowserState } from "../src/server/browser/browser-manager";
import { validateInputEvents } from "../src/server/browser/browser-manager";
import type { BrowserManager } from "../src/server/browser/browser-manager";

/** Manajer browser palsu: tanpa Chrome, tapi bisa disuruh mengalir frame. */
class BrowserPalsu {
  readonly dipanggil: string[] = [];
  private readonly pendengar = new Set<(frame: BrowserFrame) => void>();
  private readonly pendengarState = new Set<(state: BrowserState) => void>();
  keadaan: BrowserState = {
    status: "mati",
    tabs: [],
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
    viewport: { width: 1280, height: 800 },
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

  subscribeState(listener: (state: BrowserState) => void): () => void {
    this.pendengarState.add(listener);
    listener(this.keadaan);
    return () => this.pendengarState.delete(listener);
  }

  async close(): Promise<void> {
    this.dipanggil.push("close");
    this.keadaan = { ...this.keadaan, status: "mati" };
  }

  tabs(): BrowserState["tabs"] {
    return this.keadaan.tabs;
  }

  async newTab(url?: unknown): Promise<BrowserState> {
    this.dipanggil.push(`newTab:${String(url)}`);
    const id = `T${this.keadaan.tabs.length + 1}`;
    const tabs = [
      ...this.keadaan.tabs.map((tab) => ({ ...tab, active: false })),
      {
        id,
        title: "",
        url: url === undefined ? "about:blank" : String(url),
        active: true,
        loading: false,
      },
    ];
    this.keadaan = {
      ...this.keadaan,
      status: "menyala",
      tabs,
      activeId: id,
      url: url === undefined ? "about:blank" : String(url),
    };
    return this.keadaan;
  }

  async activateTab(id: string): Promise<BrowserState> {
    this.dipanggil.push(`activateTab:${id}`);
    const tabs = this.keadaan.tabs.map((tab) => ({ ...tab, active: tab.id === id }));
    this.keadaan = { ...this.keadaan, tabs, activeId: id };
    return this.keadaan;
  }

  async closeTab(id: string): Promise<BrowserState> {
    this.dipanggil.push(`closeTab:${id}`);
    const tabs = this.keadaan.tabs.filter((tab) => tab.id !== id);
    this.keadaan = { ...this.keadaan, tabs, activeId: tabs[0]?.id };
    return this.keadaan;
  }

  async back(): Promise<BrowserState> {
    this.dipanggil.push("back");
    return this.keadaan;
  }

  async forward(): Promise<BrowserState> {
    this.dipanggil.push("forward");
    return this.keadaan;
  }

  async reload(): Promise<BrowserState> {
    this.dipanggil.push("reload");
    return this.keadaan;
  }

  async stop(): Promise<BrowserState> {
    this.dipanggil.push("stop");
    return this.keadaan;
  }

  async setViewport(width: unknown, height: unknown): Promise<BrowserState> {
    this.dipanggil.push(`setViewport:${String(width)}x${String(height)}`);
    this.keadaan = {
      ...this.keadaan,
      viewport: { width: Number(width), height: Number(height) },
    };
    return this.keadaan;
  }

  async dispatchInput(events: unknown): Promise<BrowserState> {
    // Validasi memakai fungsi yang sama dengan manajer sungguhan.
    validateInputEvents(events, this.keadaan.viewport);
    // Isi input hanya disimpan di memori; tak pernah masuk log atau audit.
    this.dipanggil.push(`dispatchInput:${Array.isArray(events) ? events.length : 0}`);
    return this.keadaan;
  }

  async copySelection(): Promise<string> {
    this.dipanggil.push("copySelection");
    return "teks terpilih";
  }

  /** Kirim satu frame ke pelanggan yang sedang listening. */
  kirimFrame(frame: BrowserFrame): void {
    for (const listener of this.pendengar) listener(frame);
  }

  /** Kirim state baru ke pelanggan SSE. */
  kirimState(state: BrowserState): void {
    this.keadaan = state;
    for (const listener of this.pendengarState) listener(state);
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

const SEMUA_RUTE: Array<[string, string]> = [
  ["GET", "/api/browser"],
  ["POST", "/api/browser/navigate"],
  ["POST", "/api/browser/tabs"],
  ["POST", "/api/browser/tabs/T1/activate"],
  ["DELETE", "/api/browser/tabs/T1"],
  ["POST", "/api/browser/back"],
  ["POST", "/api/browser/forward"],
  ["POST", "/api/browser/reload"],
  ["POST", "/api/browser/stop"],
  ["POST", "/api/browser/viewport"],
  ["POST", "/api/browser/input"],
  ["POST", "/api/browser/copy"],
  ["GET", "/api/browser/stream"],
  ["DELETE", "/api/browser"],
];

describe("rute browser", () => {
  test("tanpa manajer semua rute menjawab 503", async () => {
    const { req, audit } = setup({ aktif: false });
    for (const [method, path] of SEMUA_RUTE) {
      const res = await req(
        method,
        path,
        method === "GET" ? undefined : method === "DELETE" ? {} : { url: "https://a.test" },
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
    expect(payload.tabs).toEqual([]);
    expect(payload.viewport).toEqual({ width: 1280, height: 800 });
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

  test("aliran SSE mengirim state lagi saat state berubah", async () => {
    const { req, browser, audit } = setup();
    const res = await req("GET", "/api/browser/stream");
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let teks = "";
    while (teks.indexOf("event: state") < 0) {
      const bagian = await reader!.read();
      if (bagian.done) break;
      teks += decoder.decode(bagian.value, { stream: true });
    }
    expect(teks).toContain("event: state");
    browser.kirimState({
      status: "menyala",
      tabs: [],
      url: "https://baru.test",
      title: "baru",
      canGoBack: false,
      canGoForward: false,
      loading: false,
      viewport: { width: 1280, height: 800 },
    });
    let lanjut = "";
    while (lanjut.indexOf("baru.test") < 0) {
      const bagian = await reader!.read();
      if (bagian.done) break;
      lanjut += decoder.decode(bagian.value, { stream: true });
    }
    expect(lanjut).toContain("event: state");
    expect(lanjut).toContain("baru.test");
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

describe("rute tab browser", () => {
  test("membuat tab baru dan mencatat audit URL", async () => {
    const { req, browser, audit } = setup();
    const res = await req("POST", "/api/browser/tabs", { url: "https://tab.test" });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as BrowserState;
    expect(payload.tabs.length).toBe(1);
    expect(payload.tabs[0]?.url).toBe("https://tab.test");
    expect(browser.dipanggil).toEqual(["newTab:https://tab.test"]);
    const catatan = audit.list().find((entry) => entry.meta.aksi === "browser-tab-dibuat");
    expect(catatan?.meta.url).toBe("https://tab.test");
    audit.close();
  });

  test("tab tanpa URL memakai about:blank", async () => {
    const { req, browser, audit } = setup();
    const res = await req("POST", "/api/browser/tabs", {});
    expect(res.status).toBe(200);
    expect(browser.dipanggil).toEqual(["newTab:undefined"]);
    audit.close();
  });

  test("field tak dikenal pada body tab ditolak", async () => {
    const { req, audit } = setup();
    const res = await req("POST", "/api/browser/tabs", { url: "https://a.test", buka: true });
    expect(res.status).toBe(400);
    audit.close();
  });

  test("aktivasi dan penutupan tab memakai id di jalur", async () => {
    const { req, browser, audit } = setup();
    const aktif = await req("POST", "/api/browser/tabs/T1/activate", {});
    expect(aktif.status).toBe(200);
    expect(browser.dipanggil).toContain("activateTab:T1");
    const tutup = await req("DELETE", "/api/browser/tabs/T1", {});
    expect(tutup.status).toBe(200);
    expect(browser.dipanggil).toContain("closeTab:T1");
    const catatan = audit.list().find((entry) => entry.meta.aksi === "browser-tab-ditutup");
    expect(catatan).toBeDefined();
    audit.close();
  });
});

describe("rute navigasi, tampilan, input, dan salin", () => {
  test("riwayat, muat ulang, dan henti dijawab", async () => {
    const { req, browser, audit } = setup();
    for (const aksi of ["back", "forward", "reload", "stop"]) {
      const res = await req(`POST`, `/api/browser/${aksi}`, {});
      expect(res.status).toBe(200);
      expect(browser.dipanggil).toContain(aksi);
    }
    audit.close();
  });

  test("viewport divalidasi dan diteruskan", async () => {
    const { req, browser, audit } = setup();
    const res = await req("POST", "/api/browser/viewport", { width: 800, height: 600 });
    expect(res.status).toBe(200);
    expect(browser.dipanggil).toContain("setViewport:800x600");
    const kurang = await req("POST", "/api/browser/viewport", { width: 800 });
    expect(kurang.status).toBe(400);
    const asing = await req("POST", "/api/browser/viewport", { width: 800, height: 600, zoom: 2 });
    expect(asing.status).toBe(400);
    audit.close();
  });

  test("input divalidasi dan tak pernah masuk audit", async () => {
    const { req, browser, audit } = setup();
    const rahasia = "kata-sandi-rahasia";
    const res = await req("POST", "/api/browser/input", {
      events: [{ kind: "text", text: rahasia }],
    });
    expect(res.status).toBe(200);
    expect(browser.dipanggil).toContain("dispatchInput:1");
    const isi = JSON.stringify(audit.list());
    expect(isi).not.toContain(rahasia);
    expect(isi).not.toContain("browser-input");
    audit.close();
  });

  test("field tak dikenal pada body input ditolak", async () => {
    const { req, audit } = setup();
    const res = await req("POST", "/api/browser/input", {
      events: [{ kind: "text", text: "halo", warna: "merah" }],
    });
    expect(res.status).toBe(400);
    const luar = await req("POST", "/api/browser/input", { events: [], cmd: "ls" });
    expect(luar.status).toBe(400);
    audit.close();
  });

  test("body input yang terlalu besar ditolak dengan 429", async () => {
    const { req, audit } = setup();
    const besar = JSON.stringify({
      events: [{ kind: "text", text: "x".repeat(300 * 1024) }],
    });
    const res = await req("POST", "/api/browser/input", besar);
    expect(res.status).toBe(429);
    audit.close();
  });

  test("salin mengembalikan teks pilihan", async () => {
    const { req, browser, audit } = setup();
    const res = await req("POST", "/api/browser/copy", {});
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { text?: string };
    expect(payload.text).toBe("teks terpilih");
    expect(browser.dipanggil).toContain("copySelection");
    audit.close();
  });
});
