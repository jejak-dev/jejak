import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import type { MemoryBridge } from "../src/server/memory/memory-bridge";

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

  test("tanpa opsi memory rute /mcp 404", async () => {
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
    expect(res.status).toBe(404);
  });
});
