import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { McpServerService } from "../src/server/mcp/mcp-service";
import { defaultMcpServerService } from "../src/server/routes/mcp-servers";

const ENV_SENTINEL = "rahasia-env-jangan-bocor";
const HEADER_SENTINEL = "rahasia-header-jangan-bocor";

let root: string;
let home: string;
let providersFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-mcp-api-"));
  home = join(root, "home");
  providersFile = join(root, "providers.json");
  await Bun.write(
    providersFile,
    JSON.stringify({
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://lokal.test",
          apiKey: "sk-rahasia",
          models: [{ id: "mock-model" }],
          defaultModel: "mock-model",
        },
      ],
      activeProfileId: "lokal",
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeApp(options: Partial<CreateAppOptions> = {}) {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: home },
    runner: createMockRunner(),
    ...options,
  });
}

function makeMcpApp(options: Partial<CreateAppOptions> = {}) {
  const service = new McpServerService({ path: join(home, "mcp-servers.json") });
  return makeApp({ mcpServers: service, ...options });
}

type App = ReturnType<typeof createApp>;

function req(
  app: App,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const headersOut: Record<string, string> = {
    host: "127.0.0.1:3000",
    "content-type": "application/json",
    ...headers,
  };
  const bodyOut = body === undefined ? undefined : JSON.stringify(body);
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: headersOut,
      body: bodyOut,
    }),
  );
}

interface ItemBody {
  item: {
    id: string;
    name: string;
    transport: string;
    enabled: boolean;
    envKeys?: string[];
    headerNames?: string[];
    createdAt: string;
    updatedAt: string;
  };
}

const MISSING = "00000000-0000-4000-8000-000000000000";

const STDIO_BODY = {
  name: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "server"],
  env: { TOKEN: ENV_SENTINEL },
};

const HTTP_BODY = {
  name: "remote",
  transport: "http",
  url: "https://mcp.test/sse",
  headers: { Authorization: `Bearer ${HEADER_SENTINEL}` },
};

describe("rute server MCP aktif", () => {
  test("POST membuat server 201 tanpa nilai rahasia di respons", async () => {
    const app = makeMcpApp();
    const res = await req(app, "POST", "/api/mcp-servers", STDIO_BODY);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(ENV_SENTINEL);
    const body = JSON.parse(text) as ItemBody;
    expect(body.item.name).toBe("github");
    expect(body.item.envKeys).toEqual(["TOKEN"]);
    expect(body.item.enabled).toBe(true);
  });

  test("GET daftar tidak pernah memuat nilai env/header", async () => {
    const app = makeMcpApp();
    await req(app, "POST", "/api/mcp-servers", STDIO_BODY);
    await req(app, "POST", "/api/mcp-servers", HTTP_BODY);

    const res = await req(app, "GET", "/api/mcp-servers");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(ENV_SENTINEL);
    expect(text).not.toContain(HEADER_SENTINEL);
    const body = JSON.parse(text) as { items: ItemBody["item"][]; problems: unknown[] };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]!.envKeys).toEqual(["TOKEN"]);
    expect(body.items[1]!.headerNames).toEqual(["Authorization"]);
    expect(body.problems).toEqual([]);
  });

  test("PATCH parsial mengubah env tanpa membocorkan nilai", async () => {
    const app = makeMcpApp();
    const created = (await (await req(app, "POST", "/api/mcp-servers", STDIO_BODY)).json()) as ItemBody;

    const res = await req(app, "PATCH", `/api/mcp-servers/${created.item.id}`, {
      env: { TOKEN: null, BARU: ENV_SENTINEL },
      enabled: false,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(ENV_SENTINEL);
    const body = JSON.parse(text) as ItemBody;
    expect(body.item.envKeys).toEqual(["BARU"]);
    expect(body.item.enabled).toBe(false);
  });

  test("PATCH ganti transport lengkap berhasil", async () => {
    const app = makeMcpApp();
    const created = (await (await req(app, "POST", "/api/mcp-servers", STDIO_BODY)).json()) as ItemBody;
    const res = await req(app, "PATCH", `/api/mcp-servers/${created.item.id}`, {
      transport: "http",
      url: "https://baru.test/sse",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemBody;
    expect(body.item.transport).toBe("http");
    expect(body.item.envKeys).toEqual([]);
    expect(body.item.headerNames).toEqual([]);
  });

  test("DELETE menghapus dan 404 setelahnya", async () => {
    const app = makeMcpApp();
    const created = (await (await req(app, "POST", "/api/mcp-servers", STDIO_BODY)).json()) as ItemBody;
    const removed = await req(app, "DELETE", `/api/mcp-servers/${created.item.id}`, {});
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });

    const again = await req(app, "DELETE", `/api/mcp-servers/${created.item.id}`, {});
    expect(again.status).toBe(404);
  });

  test("POST test memakai layanan dan tidak bocor ke respons", async () => {
    const app = makeMcpApp();
    const fetched: Array<{ url: string; init: RequestInit }> = [];
    const testApp = makeApp({
      mcpServers: new McpServerService({ path: join(home, "mcp-servers.json") }),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        fetched.push({ url, init: init ?? {} });
        const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (body.method === "notifications/initialized") {
          return new Response("", { status: 202 });
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "cari" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    void app;

    const created = (await (await req(testApp, "POST", "/api/mcp-servers", HTTP_BODY)).json()) as ItemBody;
    const res = await req(testApp, "POST", `/api/mcp-servers/${created.item.id}/test`, {});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(HEADER_SENTINEL);
    const body = JSON.parse(text) as { ok: boolean; tools?: { name: string }[]; ms: number };
    expect(body.ok).toBe(true);
    expect(body.tools).toEqual([{ name: "cari" }]);
    expect(typeof body.ms).toBe("number");
    expect(fetched.length).toBe(3);
  });

  test("test server stdio dengan command tak ada tidak memuat nilai env", async () => {
    const app = makeMcpApp();
    const created = (await (await req(app, "POST", "/api/mcp-servers", {
      ...STDIO_BODY,
      command: "perintah-yang-tidak-ada",
    })).json()) as ItemBody;
    const res = await req(app, "POST", `/api/mcp-servers/${created.item.id}/test`, {});
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
    expect(text).not.toContain(ENV_SENTINEL);
  });
});

describe("kode status dan galat", () => {
  test("id bukan UUID dan id tak ada menjawab 404", async () => {
    const app = makeMcpApp();
    for (const [method, path] of [
      ["PATCH", "/api/mcp-servers/bukan-uuid"],
      ["DELETE", "/api/mcp-servers/bukan-uuid"],
      ["POST", "/api/mcp-servers/bukan-uuid/test"],
      ["PATCH", `/api/mcp-servers/${MISSING}`],
      ["DELETE", `/api/mcp-servers/${MISSING}`],
      ["POST", `/api/mcp-servers/${MISSING}/test`],
    ] as const) {
      const res = await req(app, method, path, method === "DELETE" ? undefined : {});
      expect(res.status).toBe(404);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  test("validasi 400 untuk body salah", async () => {
    const app = makeMcpApp();
    const created = (await (await req(app, "POST", "/api/mcp-servers", STDIO_BODY)).json()) as ItemBody;
    const cases: Array<[string, string, unknown]> = [
      ["POST", "/api/mcp-servers", { ...STDIO_BODY, name: "" }],
      ["POST", "/api/mcp-servers", { ...STDIO_BODY, name: "Jejak" }],
      ["POST", "/api/mcp-servers", { ...STDIO_BODY, takdikenal: true }],
      ["POST", "/api/mcp-servers", "bukan objek"],
      ["POST", "/api/mcp-servers", { name: "x", transport: "stdio", command: "npx -y" }],
      ["POST", "/api/mcp-servers", { name: "x", transport: "http", url: "https://u:p@x.test" }],
      ["PATCH", `/api/mcp-servers/${created.item.id}`, { nama: "x" }],
      ["PATCH", `/api/mcp-servers/${created.item.id}`, { transport: "http" }],
    ];
    for (const [method, path, body] of cases) {
      const res = await req(app, method, path, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  test("body bukan JSON valid menjawab 400", async () => {
    const app = makeMcpApp();
    const res = await app.handle(
      new Request("http://127.0.0.1:3000/api/mcp-servers", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: "{rusak",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
  });

  test("duplikat nama menjawab 409", async () => {
    const app = makeMcpApp();
    await req(app, "POST", "/api/mcp-servers", STDIO_BODY);
    const res = await req(app, "POST", "/api/mcp-servers", STDIO_BODY);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("sudah dipakai");
  });

  test("rahasia di args ditolak 400 tanpa mengulang teks", async () => {
    const app = makeMcpApp();
    const secret = "ghp_abcdefghijklmnopqrst";
    const res = await req(app, "POST", "/api/mcp-servers", {
      name: "x",
      transport: "stdio",
      command: "npx",
      args: [secret],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("rahasia");
    expect(body.error).not.toContain(secret);
  });

  test("mutasi tanpa content-type json ditolak 415", async () => {
    const app = makeMcpApp();
    const res = await app.handle(
      new Request("http://127.0.0.1:3000/api/mcp-servers", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "text/plain" },
        body: JSON.stringify(STDIO_BODY),
      }),
    );
    expect(res.status).toBe(415);
  });

  test("guard Host dan Origin tetap berlaku", async () => {
    const app = makeMcpApp();
    const badHost = await req(app, "GET", "/api/mcp-servers", undefined, { host: "evil.test" });
    expect(badHost.status).toBe(403);

    const badOrigin = await req(app, "GET", "/api/mcp-servers", undefined, {
      origin: "http://evil.test",
    });
    expect(badOrigin.status).toBe(403);
  });
});

describe("server MCP dimatikan", () => {
  test("defaultMcpServerService mengikuti JEJAK_MCP_SERVERS=0", () => {
    expect(defaultMcpServerService({ JEJAK_HOME: home })).toBeInstanceOf(McpServerService);
    expect(
      defaultMcpServerService({ JEJAK_HOME: home, JEJAK_MCP_SERVERS: "0" }),
    ).toBeUndefined();
  });

  test("semua rute menjawab 503 dan createApp tanpa opsi tidak menyentuh disk", async () => {
    const app = makeApp();
    for (const [method, path] of [
      ["GET", "/api/mcp-servers"],
      ["POST", "/api/mcp-servers"],
      ["PATCH", "/api/mcp-servers/x"],
      ["DELETE", "/api/mcp-servers/x"],
      ["POST", "/api/mcp-servers/x/test"],
    ] as const) {
      const res = await req(app, method, path, method === "GET" || method === "DELETE" ? undefined : {});
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Server MCP dimatikan." });
    }
    expect(await Bun.file(join(home, "mcp-servers.json")).exists()).toBe(false);
  });
});