import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent/events";
import type { BrowserManager, BrowserState, PageSnapshot } from "../src/server/browser/browser-manager";
import { createMemoryBridge, type MemoryBridge } from "../src/server/memory/memory-bridge";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import type { ProviderSelection, ResolvedProvider } from "../src/server/provider";
import { SessionManager } from "../src/server/sessions/session-manager";
import type { WorkspaceToolView } from "../src/server/workspaces/workspace-tools";

let dir: string;
let store: FileMemoryStore;
let service: MemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-memory-bridge-"));
  store = new FileMemoryStore({ dir: join(dir, "memory") });
  service = new MemoryService({ store, cwd: dir });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function provider(selection: ProviderSelection): ResolvedProvider {
  return { profileId: selection.profileId ?? "lokal", apiKey: "sk-uji" };
}

function manager(runner: AgentRunner, memoryBridge?: MemoryBridge): SessionManager {
  const options = {
    runner,
    resolveProvider: async (selection: ProviderSelection) => provider(selection),
  };
  return new SessionManager(
    memoryBridge === undefined ? options : { ...options, memoryBridge },
  );
}

function captureRunner(events: AgentEvent[] = [{ type: "result", ok: true }]): {
  runner: AgentRunner;
  inputs: RunInput[];
} {
  const inputs: RunInput[] = [];
  return {
    inputs,
    runner: {
      async *run(input) {
        inputs.push(input);
        for (const event of events) yield event;
      },
    },
  };
}

function abortingRunner(inputs: RunInput[]): AgentRunner {
  return {
    async *run(input) {
      inputs.push(input);
      yield { type: "text", text: "menunggu" };
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted === true) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "result", ok: false, error: "dibatalkan" };
    },
  };
}

describe("createMemoryBridge", () => {
  test("token berbeda per giliran dan token lama dicabut", async () => {
    const { bridge, routes } = createMemoryBridge({ service, mcpUrl: "http://127.0.0.1:1/mcp" });
    expect(routes).toBeDefined();

    const first = await bridge.open({ sessionId: "s_1", cwd: dir });
    const second = await bridge.open({ sessionId: "s_1", cwd: dir });
    expect(first.memory.token).not.toBe(second.memory.token);
    expect(first.memory.url).toBe("http://127.0.0.1:1/mcp");
    expect(typeof first.memory.indexLine).toBe("string");
    expect(typeof first.memory.call).toBe("function");

    first.close();
    // Setelah dicabut, token tidak lagi valid: panggilan lewat rute 401.
    const call = async (token: string) =>
      routes.handle(
        new Request("http://127.0.0.1:1/mcp", {
          method: "POST",
          headers: {
            host: "127.0.0.1:1",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
      );
    expect((await call(first.memory.token!)).status).toBe(401);
    expect((await call(second.memory.token!)).status).toBe(200);

    second.close();
  });

  test("tanpa mcpUrl RunMemory tidak punya url", async () => {
    const { bridge } = createMemoryBridge({ service });
    const opened = await bridge.open({ sessionId: "s_2", cwd: dir });
    expect(opened.memory.url).toBeUndefined();
    expect(opened.memory.token).toBeTruthy();
    opened.close();
  });
});

describe("SessionManager + memoryBridge", () => {
  test("sesi berjalan memberi runner input.memory", async () => {
    const { bridge } = createMemoryBridge({ service, mcpUrl: "http://127.0.0.1:1/mcp" });
    const capture = captureRunner();
    const mgr = manager(capture.runner, bridge);

    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);

    expect(capture.inputs).toHaveLength(1);
    const memory = capture.inputs[0]?.memory;
    expect(memory).toBeDefined();
    expect(typeof memory?.indexLine).toBe("string");
    expect(typeof memory?.token).toBe("string");
  });

  test("tanpa bridge input.memory undefined", async () => {
    const capture = captureRunner();
    const mgr = manager(capture.runner);
    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);

    expect(capture.inputs[0]?.memory).toBeUndefined();
  });

  test("token dicabut setelah selesai, gagal, dan interrupt", async () => {
    const { bridge, routes } = createMemoryBridge({ service });
    const tokens: string[] = [];

    const ping = async (token: string): Promise<number> => {
      const res = await routes.handle(
        new Request("http://127.0.0.1:1/mcp", {
          method: "POST",
          headers: {
            host: "127.0.0.1:1",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
      );
      return res.status;
    };

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const startInputs: RunInput[] = [];
    const gatedRunner: AgentRunner = {
      async *run(input) {
        startInputs.push(input);
        started = true;
        await gate;
        yield { type: "result", ok: true };
      },
    };
    const ok = manager(gatedRunner, bridge);
    const okInfo = await ok.create({ prompt: "halo", cwd: dir });
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
    tokens.push(startInputs[0]?.memory?.token ?? "");
    expect(await ping(tokens[0]!)).toBe(200);
    release();
    await ok.done(okInfo.id);

    const failing = captureRunner([{ type: "result", ok: false, error: "meledak" }]);
    const fail = manager(failing.runner, bridge);
    const failInfo = await fail.create({ prompt: "halo", cwd: dir });
    await fail.done(failInfo.id);
    tokens.push(failing.inputs[0]?.memory?.token ?? "");

    const inputs: RunInput[] = [];
    const interrupted = manager(abortingRunner(inputs), bridge);
    const intInfo = await interrupted.create({ prompt: "tunggu", cwd: dir });
    while (inputs.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    tokens.push(inputs[0]?.memory?.token ?? "");
    interrupted.interrupt(intInfo.id);
    await interrupted.done(intInfo.id);

    expect(tokens.every((token) => token !== "")).toBe(true);
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens) {
      expect(await ping(token)).toBe(401);
    }
  });

  test("open yang melempar tidak menggagalkan sesi dan console.warn paling banyak sekali", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const broken: MemoryBridge = {
      open: async () => {
        throw new Error("indeks memory rusak");
      },
    };
    const capture = captureRunner();
    const mgr = manager(capture.runner, broken);

    const first = await mgr.create({ prompt: "satu", cwd: dir });
    await mgr.done(first.id);
    const second = await mgr.create({ prompt: "dua", cwd: dir });
    await mgr.done(second.id);

    expect(mgr.get(first.id)?.status).toBe("selesai");
    expect(mgr.get(second.id)?.status).toBe("selesai");
    expect(capture.inputs.every((input) => input.memory === undefined)).toBe(true);
    expect(warn.mock.calls.length).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("indeks memory rusak");
    warn.mockRestore();
  });
});

describe("createMemoryBridge + workspace", () => {
  const WORKSPACE_LINE =
    "Sesi ini punya workspace: gunakan workspace_overview untuk melihat repo dan workspace_service untuk kartu satu repo (hanya baca).";

  function workspaceSource(): {
    source: { get: (id: string) => Promise<WorkspaceToolView | undefined> };
    view: WorkspaceToolView;
    calls: string[];
  } {
    const calls: string[] = [];
    const view: WorkspaceToolView = {
      id: "ws-1",
      name: "Kantor",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      repos: [
        {
          name: "api",
          path: "/tmp/kantor/api",
          card: {
            description: "Layanan pesanan.",
            kind: "backend",
            tables: ["pesanan"],
            queues: [],
            calls: [],
            updatedAt: null,
          },
        },
      ],
    };
    return {
      view,
      calls,
      source: {
        get: async (id: string) => {
          calls.push(id);
          return id === view.id ? view : undefined;
        },
      },
    };
  }

  test("open menerima workspaceId dan indexLine memuat kalimat workspace", async () => {
    const { source } = workspaceSource();
    const { bridge } = createMemoryBridge({ service, workspaces: source });
    const opened = await bridge.open({ sessionId: "s_ws", cwd: dir, workspaceId: "ws-1" });
    try {
      expect(opened.memory.indexLine).toContain("Jejak menyimpan memory lintas sesi.");
      expect(opened.memory.indexLine).toContain(WORKSPACE_LINE);
      expect(opened.memory.tools).toEqual([
        "memory_search",
        "memory_propose",
        "workspace_overview",
        "workspace_service",
      ]);

      const overview = await opened.memory.call("workspace_overview", {});
      expect(overview.isError).toBe(false);
      expect(overview.text).toContain("- api (backend): Layanan pesanan.");

      const card = await opened.memory.call("workspace_service", { name: "api" });
      expect(card.isError).toBe(false);
      expect(card.text).toContain("Tabel:\n- pesanan");

      const unknown = await opened.memory.call("workspace_hapus", {});
      expect(unknown.isError).toBe(true);
    } finally {
      opened.close();
    }
  });

  test("tanpa workspaceId indexLine tetap seperti sebelumnya", async () => {
    const { source, calls } = workspaceSource();
    const { bridge } = createMemoryBridge({ service, workspaces: source });
    const opened = await bridge.open({ sessionId: "s_no_ws", cwd: dir });
    try {
      expect(opened.memory.indexLine).not.toContain("punya workspace");
      expect(opened.memory.tools).toEqual(["memory_search", "memory_propose"]);
      const overview = await opened.memory.call("workspace_overview", {});
      expect(overview.isError).toBe(true);
      expect(overview.text).toBe("Sesi ini tidak punya workspace.");
      expect(calls).toEqual([]);
    } finally {
      opened.close();
    }
  });

  test("hanya workspace (tanpa service) tetap membuka bridge dengan tool workspace", async () => {
    const { source } = workspaceSource();
    const { bridge, routes } = createMemoryBridge({ workspaces: source });
    expect(routes).toBeDefined();
    const opened = await bridge.open({ sessionId: "s_only", cwd: dir, workspaceId: "ws-1" });
    try {
      expect(opened.memory.indexLine).toContain(WORKSPACE_LINE);
      expect(opened.memory.indexLine.startsWith(" Sesi ini")).toBe(false);
      expect(opened.memory.tools).toEqual(["workspace_overview", "workspace_service"]);
      const overview = await opened.memory.call("workspace_overview", {});
      expect(overview.isError).toBe(false);
      expect(overview.text).toContain('Workspace "Kantor"');
    } finally {
      opened.close();
    }
  });

  test("manager meneruskan workspaceId sesi ke bridge", async () => {
    const { source } = workspaceSource();
    const { bridge } = createMemoryBridge({ service, workspaces: source });
    const opened: Array<{ sessionId: string; cwd: string; workspaceId?: string }> = [];
    const spyBridge: MemoryBridge = {
      open: async (input) => {
        opened.push(input);
        return bridge.open(input);
      },
    };
    const capture = captureRunner();
    const wsManager = new SessionManager({
      runner: capture.runner,
      resolveProvider: async (selection: ProviderSelection) => provider(selection),
      memoryBridge: spyBridge,
      workspaces: {
        get: async (id: string) => ({
          id,
          name: "Kantor",
          repos: [{ name: "api", path: dir, kind: "backend", missing: false }],
        }),
      },
    });

    const info = await wsManager.create({ prompt: "halo", cwd: dir, workspaceId: "ws-1" });
    await wsManager.done(info.id);

    expect(opened).toHaveLength(1);
    expect(opened[0]?.workspaceId).toBe("ws-1");
    expect(capture.inputs[0]?.memory?.tools).toContain("workspace_overview");
    expect(capture.inputs[0]?.memory?.indexLine).toContain(WORKSPACE_LINE);
  });

  test("sesi tanpa workspace tetap seperti sebelumnya di manager", async () => {
    const { source, calls } = workspaceSource();
    const { bridge } = createMemoryBridge({ service, workspaces: source });
    const capture = captureRunner();
    const mgr = manager(capture.runner, bridge);

    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);

    expect(capture.inputs[0]?.memory?.indexLine).not.toContain("punya workspace");
    expect(capture.inputs[0]?.memory?.tools).toEqual(["memory_search", "memory_propose"]);
    expect(calls).toEqual([]);
  });
});

describe("createMemoryBridge + browser", () => {
  /** Manajer browser palsu: hanya snapshot dan daftar tab yang dipakai. */
  function managerPalsu(): BrowserManager {
    const state = (): BrowserState => ({
      status: "menyala",
      tabs: [],
      url: "https://contoh.test/",
      title: "Judul",
      canGoBack: false,
      canGoForward: false,
      loading: false,
      viewport: { width: 1280, height: 800 },
    });
    const snapshot = (): PageSnapshot => ({
      url: "https://contoh.test/",
      title: "Judul",
      text: "isi halaman",
      elements: [],
    });
    const palsu = {
      tabs: () => [],
      snapshot: async () => snapshot(),
      state: () => state(),
      navigate: async () => state(),
      newTab: async () => state(),
      activateTab: async () => state(),
      closeTab: async () => state(),
      back: async () => state(),
      clickRef: async () => state(),
      typeRef: async () => state(),
      pressKey: async () => state(),
      scroll: async () => state(),
    };
    return palsu as unknown as BrowserManager;
  }

  /** Panggil /mcp dengan token sesi dan kembalikan hasil JSON-RPC. */
  async function mcp(
    routes: ReturnType<typeof createMemoryBridge>["routes"],
    token: string,
    method: string,
    params?: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await routes.handle(
      new Request("http://127.0.0.1:1/mcp", {
        method: "POST",
        headers: {
          host: "127.0.0.1:1",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
      }),
    );
    return (await res.json()) as Record<string, unknown>;
  }

  /** Nama tool pada hasil tools/list. */
  function namaTool(hasil: Record<string, unknown>): string[] {
    const result = hasil.result as { tools?: Array<{ name?: string }> } | undefined;
    return (result?.tools ?? []).map((tool) => tool.name ?? "");
  }

  test("tool browser muncul di tools/list hanya saat fitur menyala", async () => {
    let menyala = false;
    const manager = managerPalsu();
    const { bridge, routes } = createMemoryBridge({
      service,
      browser: { resolve: () => (menyala ? manager : undefined) },
    });
    const opened = await bridge.open({ sessionId: "s_browser", cwd: dir });
    try {
      const token = opened.memory.token ?? "";

      const sebelum = await mcp(routes, token, "tools/list");
      expect(namaTool(sebelum)).not.toContain("browser_snapshot");
      expect(namaTool(sebelum)).not.toContain("browser_navigate");

      menyala = true;
      const sesudah = await mcp(routes, token, "tools/list");
      expect(namaTool(sesudah)).toContain("browser_tabs");
      expect(namaTool(sesudah)).toContain("browser_snapshot");
      expect(namaTool(sesudah)).toContain("browser_navigate");

      // Saklar dimatikan lagi tanpa membuat ulang bridge.
      menyala = false;
      const mati = await mcp(routes, token, "tools/list");
      expect(namaTool(mati)).not.toContain("browser_snapshot");
      expect(namaTool(mati)).toContain("memory_search");
    } finally {
      opened.close();
    }
  });

  test("call saat fitur mati ditolak", async () => {
    const { bridge } = createMemoryBridge({
      service,
      browser: { resolve: () => undefined },
    });
    const opened = await bridge.open({ sessionId: "s_browser_mati", cwd: dir });
    try {
      const hasil = await opened.memory.call("browser_snapshot", {});
      expect(hasil.isError).toBe(true);
      expect(hasil.text).toContain("Browser dimatikan");
    } finally {
      opened.close();
    }
  });

  test("call lewat /mcp saat fitur mati ditolak", async () => {
    const { bridge, routes } = createMemoryBridge({
      service,
      browser: { resolve: () => undefined },
    });
    const opened = await bridge.open({ sessionId: "s_browser_rute", cwd: dir });
    try {
      const hasil = await mcp(routes, opened.memory.token ?? "", "tools/call", {
        name: "browser_snapshot",
        arguments: {},
      });
      const result = hasil.result as { content?: Array<{ text?: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toBe("Tool tidak tersedia.");
    } finally {
      opened.close();
    }
  });

  test("indexLine dan daftar tool menyebut browser saat fitur menyala", async () => {
    const manager = managerPalsu();
    const { bridge } = createMemoryBridge({
      service,
      browser: { resolve: () => manager },
    });
    const opened = await bridge.open({ sessionId: "s_browser_aktif", cwd: dir });
    try {
      expect(opened.memory.indexLine).toContain("browser yang sama dengan panel");
      expect(opened.memory.tools).toContain("browser_tabs");
      expect(opened.memory.tools).toContain("browser_snapshot");
      expect(opened.memory.tools).toContain("browser_navigate");
    } finally {
      opened.close();
    }
  });

  test("bridge tetap dibuat bila hanya browser yang ada", async () => {
    const manager = managerPalsu();
    const { bridge, routes } = createMemoryBridge({
      browser: { resolve: () => manager },
    });
    expect(routes).toBeDefined();
    const opened = await bridge.open({ sessionId: "s_hanya_browser", cwd: dir });
    try {
      expect(opened.memory.tools).toEqual([
        "browser_tabs",
        "browser_snapshot",
        "browser_navigate",
        "browser_new_tab",
        "browser_switch_tab",
        "browser_close_tab",
        "browser_back",
        "browser_click",
        "browser_type",
        "browser_press",
        "browser_scroll",
      ]);
      const hasil = await opened.memory.call("browser_snapshot", {});
      expect(hasil.isError).toBe(false);
      expect(hasil.text).toContain("isi halaman");
    } finally {
      opened.close();
    }
  });
});
