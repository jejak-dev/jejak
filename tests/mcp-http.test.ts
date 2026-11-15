import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner, type AgentRunner } from "../src/server/agent";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import type { MemoryBridge } from "../src/server/memory/memory-bridge";
import { WorkspaceService } from "../src/server/workspaces/workspace-service";

let dir: string;
let store: FileMemoryStore;
let service: MemoryService;
let app: ReturnType<typeof createApp>;
let bridge: MemoryBridge;
let token: string;
let revoke: () => void;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-mcp-http-"));
  providersFile = join(dir, "providers.json");
  store = new FileMemoryStore({ dir: join(dir, "memory") });
  service = new MemoryService({ store, cwd: dir });

  app = createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    memory: service,
  });
  bridge = (app as unknown as { memoryBridge: MemoryBridge }).memoryBridge;
  const opened = await bridge.open({ sessionId: "s_mcp", cwd: dir });
  token = opened.memory.token!;
  revoke = opened.close;
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    host: "127.0.0.1:3000",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    ...overrides,
  };
}

function post(
  target: App,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return target.handle(
    new Request("http://127.0.0.1:3000/mcp", {
      method: "POST",
      headers: headers(extra),
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) payload.params = params;
  return payload;
}

describe("pemeriksaan awal /mcp", () => {
  test("tanpa token, token salah, dan token dicabut 401", async () => {
    const missing = await post(app, rpc(1, "ping"), { authorization: "" });
    expect(missing.status).toBe(401);

    const wrong = await post(app, rpc(1, "ping"), { authorization: "Bearer salah" });
    expect(wrong.status).toBe(401);

    const other = await bridge.open({ sessionId: "s_lain", cwd: dir });
    revoke();
    const revoked = await post(app, rpc(1, "ping"), {
      authorization: `Bearer ${token}`,
    });
    expect(revoked.status).toBe(401);
    expect(other.memory.token).not.toBe(token);
    other.close();
  });

  test("Origin ada 403 dan Host non-lokal 403", async () => {
    const origin = await post(app, rpc(1, "ping"), { origin: "http://127.0.0.1:3000" });
    expect(origin.status).toBe(403);

    const host = await post(app, rpc(1, "ping"), { host: "evil.test" });
    expect(host.status).toBe(403);
  });

  test("content-type bukan JSON 415 dan body > 64 KiB 413", async () => {
    const wrongType = await post(app, rpc(1, "ping"), { "content-type": "text/plain" });
    expect(wrongType.status).toBe(415);

    const big = await post(app, rpc(1, "ping", { padding: "a".repeat(70 * 1024) }));
    expect(big.status).toBe(413);
  });

  test("JSON rusak -32700 dan batch -32600", async () => {
    const broken = await post(app, "{bukan json");
    expect(broken.status).toBe(200);
    expect(((await broken.json()) as { error: { code: number } }).error.code).toBe(-32700);

    const batch = await post(app, [rpc(1, "ping")]);
    expect(((await batch.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  test("metode tak dikenal -32601 dan GET/DELETE 405", async () => {
    const unknown = await post(app, rpc(7, "tools/hapus"));
    const body = (await unknown.json()) as { id: number; error: { code: number } };
    expect(body.error.code).toBe(-32601);
    expect(body.id).toBe(7);

    for (const method of ["GET", "DELETE"]) {
      const res = await app.handle(
        new Request("http://127.0.0.1:3000/mcp", { method, headers: headers() }),
      );
      expect(res.status).toBe(405);
    }
  });
});

describe("alur JSON-RPC", () => {
  test("initialize, notifications/initialized, tools/list, tools/call", async () => {
    const init = await post(app, rpc(1, "initialize", { protocolVersion: "2025-03-26" }));
    const initBody = (await init.json()) as {
      result: {
        protocolVersion: string;
        capabilities: { tools: unknown };
        serverInfo: { name: string; version: string };
      };
    };
    expect(initBody.result.protocolVersion).toBe("2025-03-26");
    expect(initBody.result.capabilities).toEqual({ tools: {} });
    expect(initBody.result.serverInfo.name).toBe("jejak-memory");
    expect(typeof initBody.result.serverInfo.version).toBe("string");

    const notified = await post(app, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe("");

    const listed = await post(app, rpc(2, "tools/list"));
    const tools = ((await listed.json()) as {
      result: { tools: { name: string; inputSchema: Record<string, unknown> }[] };
    }).result.tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(["memory_propose", "memory_search"]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }

    const call = await post(
      app,
      rpc(3, "tools/call", {
        name: "memory_propose",
        arguments: { layer: "profile", title: "Usul MCP", body: "Dari endpoint." },
      }),
    );
    const callBody = (await call.json()) as {
      result: { content: { type: string; text: string }[]; isError: boolean };
    };
    expect(callBody.result.isError).toBe(false);
    expect(callBody.result.content[0]?.text).toBe(
      "Usulan dicatat dan menunggu persetujuan pengguna.",
    );

    const proposed = await service.list({ status: "proposed" });
    expect(proposed.items.map((item) => item.title)).toEqual(["Usul MCP"]);
    expect(proposed.items[0]?.origin.sessionId).toBe("s_mcp");
  });

  test("negosiasi versi protokol", async () => {
    const cases: Array<[string | undefined, string]> = [
      ["2025-06-18", "2025-06-18"],
      ["2024-11-05", "2024-11-05"],
      ["1999-01-01", "2025-06-18"],
      [undefined, "2025-06-18"],
    ];
    for (const [requested, expected] of cases) {
      const params = requested === undefined ? {} : { protocolVersion: requested };
      const res = await post(app, rpc(9, "initialize", params));
      const body = (await res.json()) as { result: { protocolVersion: string } };
      expect(body.result.protocolVersion).toBe(expected);
    }
  });

  test("tools/call dengan args salah menjadi isError, bukan galat HTTP", async () => {
    const res = await post(
      app,
      rpc(4, "tools/call", { name: "memory_search", arguments: { query: 5 } }),
    );
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("query");
  });

  test("tanpa opsi memory dan workspace rute /mcp tetap ada tanpa tool", async () => {
    const noMemory = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    });
    const res = await noMemory.handle(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: JSON.stringify(rpc(1, "ping")),
      }),
    );
    // Jembatan selalu ada (tool browser bisa dinyalakan sewaktu-waktu),
    // jadi rute tak lagi 404; tanpa token tetap ditolak.
    expect(res.status).toBe(401);

    const noMemoryBridge = (noMemory as unknown as { memoryBridge: MemoryBridge }).memoryBridge;
    const openedNoMemory = await noMemoryBridge.open({ sessionId: "s_kosong", cwd: dir });
    try {
      const tools = await listTools(noMemory, openedNoMemory.memory.token ?? "");
      expect(tools).toEqual([]);
    } finally {
      openedNoMemory.close();
    }
  });
});

interface McpBody {
  result: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] };
  error?: { code: number };
}

async function listTools(
  target: App,
  bearer: string,
): Promise<string[]> {
  const res = await target.handle(
    new Request("http://127.0.0.1:3000/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(rpc(10, "tools/list")),
    }),
  );
  const body = (await res.json()) as McpBody;
  return (body.result.tools ?? []).map((tool) => tool.name).sort();
}

async function callTool(
  target: App,
  bearer: string,
  name: string,
  args: unknown,
): Promise<{ isError: boolean; text: string }> {
  const res = await target.handle(
    new Request("http://127.0.0.1:3000/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(rpc(11, "tools/call", { name, arguments: args })),
    }),
  );
  const body = (await res.json()) as McpBody;
  return {
    isError: body.result.isError === true,
    text: body.result.content?.[0]?.text ?? "",
  };
}

describe("/mcp dengan workspace", () => {
  let workspaces: WorkspaceService;
  let wsId: string;
  let wsToken: string;
  let revokeWs: () => void;
  let wsApp: App;

  beforeEach(async () => {
    const api = join(dir, "api");
    const web = join(dir, "web");
    await mkdir(api, { recursive: true });
    await mkdir(web, { recursive: true });
    workspaces = new WorkspaceService({ dir: join(dir, "workspaces") });
    const created = await workspaces.create({
      name: "Kantor",
      repos: [
        { name: "api", path: api },
        { name: "web", path: web },
      ],
    });
    wsId = created.id;
    await workspaces.setCard(wsId, "api", {
      description: "Layanan pesanan.",
      kind: "backend",
      tables: ["pesanan"],
    });

    wsApp = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      memory: service,
      workspaces,
    });
    const wsBridge = (wsApp as unknown as { memoryBridge: MemoryBridge }).memoryBridge;
    const opened = await wsBridge.open({ sessionId: "s_ws", cwd: dir, workspaceId: wsId });
    wsToken = opened.memory.token!;
    revokeWs = opened.close;
  });

  test("sesi tanpa workspace tidak melihat tool workspace dan panggilannya isError", async () => {
    const noWs = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      memory: service,
      workspaces,
    });
    const noWsBridge = (noWs as unknown as { memoryBridge: MemoryBridge }).memoryBridge;
    const opened = await noWsBridge.open({ sessionId: "s_no_ws", cwd: dir });
    const noWsToken = opened.memory.token!;
    try {
      expect(await listTools(noWs, noWsToken)).toEqual(["memory_propose", "memory_search"]);

      const result = await callTool(noWs, noWsToken, "workspace_overview", {});
      expect(result.isError).toBe(true);
      expect(result.text).toBe("Tool tidak tersedia.");
    } finally {
      opened.close();
    }
  });

  test("sesi ber-workspace melihat tool memory dan workspace", async () => {
    expect(await listTools(wsApp, wsToken)).toEqual([
      "memory_propose",
      "memory_search",
      "workspace_overview",
      "workspace_service",
    ]);

    const overview = await callTool(wsApp, wsToken, "workspace_overview", {});
    expect(overview.isError).toBe(false);
    expect(overview.text).toContain('Workspace "Kantor"');
    expect(overview.text).toContain("- api (backend): Layanan pesanan.");

    const card = await callTool(wsApp, wsToken, "workspace_service", { name: "api" });
    expect(card.isError).toBe(false);
    expect(card.text).toContain("Tabel:\n- pesanan");
  });

  test("token sesi ber-workspace dicabut tetap 401", async () => {
    revokeWs();
    const res = await wsApp.handle(
      new Request("http://127.0.0.1:3000/mcp", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          "content-type": "application/json",
          authorization: `Bearer ${wsToken}`,
        },
        body: JSON.stringify(rpc(1, "ping")),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("tanpa layanan memory hanya tool workspace yang tampil", async () => {
    const onlyWs = createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      workspaces,
    });
    const bridgeOnlyWs = (onlyWs as unknown as { memoryBridge: MemoryBridge }).memoryBridge;
    const opened = await bridgeOnlyWs.open({ sessionId: "s_only", cwd: dir, workspaceId: wsId });
    const onlyToken = opened.memory.token!;
    try {
      expect(await listTools(onlyWs, onlyToken)).toEqual([
        "workspace_overview",
        "workspace_service",
      ]);
      const memoryCall = await callTool(onlyWs, onlyToken, "memory_search", { query: "x" });
      expect(memoryCall.isError).toBe(true);
      expect(memoryCall.text).toBe("Tool tidak tersedia.");
      const overview = await callTool(onlyWs, onlyToken, "workspace_overview", {});
      expect(overview.isError).toBe(false);
      expect(overview.text).toContain('Workspace "Kantor"');
    } finally {
      opened.close();
    }
  });
});

describe("end-to-end sesi [ws] lewat createApp", () => {
  interface Frame {
    event?: string;
    data?: string;
  }

  function parseFrames(raw: string): Frame[] {
    return raw
      .split("\n\n")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk !== "" && !chunk.startsWith(":"))
      .map((chunk) => {
        const frame: Frame = {};
        for (const line of chunk.split("\n")) {
          if (line === "event: end") frame.event = "end";
          else if (line.startsWith("data: ")) frame.data = line.slice(6);
        }
        return frame;
      });
  }

  async function readEvents(target: App, id: string): Promise<unknown[]> {
    const res = await target.handle(
      new Request(`http://127.0.0.1:3000/api/sessions/${id}/events`, {
        method: "GET",
        headers: { host: "127.0.0.1:3000" },
      }),
    );
    const raw = await res.text();
    return parseFrames(raw)
      .filter((frame) => frame.data !== undefined)
      .map((frame) => JSON.parse(frame.data ?? "{}") as unknown);
  }

  function e2eApp(workspaces: WorkspaceService, runner: AgentRunner) {
    return createApp({
      providersPath: providersFile,
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      runner,
      memory: service,
      workspaces,
    });
  }

  let e2eWorkspaces: WorkspaceService;
  let repoDir: string;

  beforeEach(async () => {
    repoDir = join(dir, "api");
    await mkdir(repoDir, { recursive: true });
    e2eWorkspaces = new WorkspaceService({ dir: join(dir, "e2e-workspaces") });
  });

  test("sesi [ws] ber-workspace menampilkan isi kartu di timeline", async () => {
    const created = await e2eWorkspaces.create({
      name: "Kantor",
      repos: [{ name: "api", path: repoDir }],
    });
    await e2eWorkspaces.setCard(created.id, "api", {
      description: "Layanan pesanan.",
      kind: "backend",
      tables: ["pesanan"],
      calls: ["web"],
    });

    const target = e2eApp(e2eWorkspaces, createMockRunner());
    const res = await target.handle(
      new Request("http://127.0.0.1:3000/api/sessions", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "[ws] lihat repo",
          workspaceId: created.id,
          cwd: repoDir,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { id: string } };

    const events = await readEvents(target, body.session.id);
    const toolResults = events.filter(
      (event): event is { type: string; output: string; isError: boolean } =>
        typeof event === "object" && event !== null && (event as { type?: string }).type === "tool_result",
    );
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]?.output).toContain("Layanan pesanan.");
    expect(toolResults[1]?.output).toContain("Tabel:\n- pesanan");
    expect(toolResults[1]?.isError).toBe(false);
    expect(events.some((event) => (event as { type?: string }).type === "result")).toBe(true);
  });

  test("sesi [ws] tanpa workspace tidak menampilkan data workspace", async () => {
    const target = e2eApp(e2eWorkspaces, createMockRunner());
    const res = await target.handle(
      new Request("http://127.0.0.1:3000/api/sessions", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: JSON.stringify({ prompt: "[ws] lihat repo", cwd: repoDir }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { session: { id: string } };

    const events = await readEvents(target, body.session.id);
    const toolResults = events.filter(
      (event): event is { type: string; output: string; isError: boolean } =>
        typeof event === "object" && event !== null && (event as { type?: string }).type === "tool_result",
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.isError).toBe(true);
    expect(toolResults[0]?.output).toBe("Sesi ini tidak punya workspace.");
    const outputs = toolResults.map((item) => item.output).join("\n");
    expect(outputs).not.toContain("Data workspace");
    expect(outputs).not.toContain("Layanan pesanan.");
  });
});
