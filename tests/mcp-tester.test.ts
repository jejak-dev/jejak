import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanSecrets,
  testMcpServer,
  type McpChildProcess,
  type McpSpawnOptions,
} from "../src/server/mcp/mcp-tester";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-mcp-tester-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FAKE_SERVER = String.raw`
const mode = process.argv[2] ?? "ok";
const tools = [
  { name: "echo", description: "x".repeat(400) },
  { name: "ping" },
];
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line.trim() === "") continue;
    const message = JSON.parse(line);
    if (mode === "hang") continue;
    if (mode === "flood") {
      process.stdout.write("x".repeat(1024 * 1024 + 10) + "\n");
      continue;
    }
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "tiruan", version: "1" } } }) + "\n",
      );
    } else if (message.method === "tools/list") {
      const items = mode === "errtool" ? [] : tools;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: items } }) + "\n");
    }
  }
});
if (mode === "hang") {
  setInterval(() => {}, 1000);
}
`;

async function writeServer(): Promise<string> {
  const path = join(dir, "server.js");
  await writeFile(path, FAKE_SERVER, { mode: 0o600 });
  return path;
}

function bunCommand(script: string, mode: string): string[] {
  return [process.execPath, script, mode];
}

function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const request = init ?? {};
    calls.push({ url, init: request });
    return handler(url, request);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

const INIT_OK = {
  jsonrpc: "2.0",
  id: 1,
  result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x" } },
};

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("cleanSecrets", () => {
  test("mengganti nilai panjang dan mengabaikan nilai pendek", () => {
    const cleaned = cleanSecrets("nilai rahasia-panjang dan abc", ["rahasia-panjang", "abc"]);
    expect(cleaned).toBe("nilai *** dan abc");
  });

  test("nilai kosong diabaikan", () => {
    expect(cleanSecrets("teks", [""])).toBe("teks");
  });
});

describe("stdio", () => {
  test("berhasil membaca tools dan memotong deskripsi", async () => {
    const script = await writeServer();
    const [command, ...args] = bunCommand(script, "ok");
    const result = await testMcpServer(
      { transport: "stdio", command: command!, args },
      { timeoutMs: 8000 },
    );

    expect(result.ok).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    const names = (result.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(["echo", "ping"]);
    expect(result.tools?.[0]?.description?.length).toBe(200);
    expect(result.tools?.[1]?.description).toBeUndefined();
  });

  test("proses dimatikan setelah selesai (tidak ada proses sisa)", async () => {
    const script = await writeServer();
    const pidFile = join(dir, "pid.txt");
    const echoScript = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${await readFile(script, "utf8")}`;
    const path = join(dir, "server-pid.js");
    await writeFile(path, echoScript, { mode: 0o600 });

    const [command, ...args] = bunCommand(path, "ok");
    const result = await testMcpServer({ transport: "stdio", command: command!, args });
    expect(result.ok).toBe(true);

    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isFinite(pid)).toBe(true);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  test("timeout mematikan proses yang menggantung", async () => {
    const script = await writeServer();
    const pidFile = join(dir, "pid-hang.txt");
    const hangScript = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${await readFile(script, "utf8")}`;
    const path = join(dir, "server-hang.js");
    await writeFile(path, hangScript, { mode: 0o600 });

    const [command, ...args] = bunCommand(path, "hang");
    const result = await testMcpServer(
      { transport: "stdio", command: command!, args },
      { timeoutMs: 700 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("batas waktu");

    const pid = Number((await readFile(pidFile, "utf8")).trim());
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  test("keluaran melebihi 1 MiB dipotong dan menjadi galat", async () => {
    const script = await writeServer();
    const [command, ...args] = bunCommand(script, "flood");
    const result = await testMcpServer(
      { transport: "stdio", command: command!, args },
      { timeoutMs: 8000 },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("1 MiB");
  });

  test("command tidak ada memberi galat bersih tanpa nilai env", async () => {
    const sentinel = "sentinel-env-rahasia-panjang";
    const result = await testMcpServer({
      transport: "stdio",
      command: join(dir, "tidak-ada", sentinel),
      env: { TOKEN: sentinel },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain(sentinel);
    expect(result.error).toContain("***");
  });

  test("spawn dipanggil tanpa shell dengan env minimal", async () => {
    let received: { command: string[]; options: McpSpawnOptions } | undefined;
    const calls: string[] = [];
    const result = await testMcpServer(
      {
        transport: "stdio",
        command: "tiruan",
        args: ["--flag"],
        env: { SERVER_TOKEN: "nilai-server-panjang" },
      },
      {
        timeoutMs: 2000,
        spawn: (command, options) => {
          received = { command, options };
          return createFakeChild(
            (line) => {
              calls.push(line);
              const message = JSON.parse(line) as { id?: number; method?: string };
              if (message.id === 1) {
                return { jsonrpc: "2.0", id: 1, result: {} };
              }
              if (message.id === 2) {
                return { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "satu" }] } };
              }
              return null;
            },
          );
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: "satu" }]);
    expect(received?.command).toEqual(["tiruan", "--flag"]);
    expect(received?.options.env.SERVER_TOKEN).toBe("nilai-server-panjang");
    expect(received?.options.env.PATH).toBe(process.env.PATH as string);
    expect(received?.options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls.some((line) => line.includes("initialize"))).toBe(true);
    expect(calls.some((line) => line.includes("notifications/initialized"))).toBe(true);
    expect(calls.some((line) => line.includes("tools/list"))).toBe(true);
  });

  test("proses palsu selalu dimatikan meski balasan galat", async () => {
    let killed = false;
    const result = await testMcpServer(
      { transport: "stdio", command: "tiruan" },
      {
        timeoutMs: 2000,
        spawn: () =>
          createFakeChild(
            () => ({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "gagal init" } }),
            () => {
              killed = true;
            },
          ),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("gagal init");
    expect(killed).toBe(true);
  });

  test("maksimal 100 tool dikembalikan", async () => {
    const tools = Array.from({ length: 150 }, (_, index) => ({ name: `t${index}` }));
    const result = await testMcpServer(
      { transport: "stdio", command: "tiruan" },
      {
        timeoutMs: 2000,
        spawn: () =>
          createFakeChild((line) => {
            const message = JSON.parse(line) as { id?: number };
            if (message.id === 1) return { jsonrpc: "2.0", id: 1, result: {} };
            if (message.id === 2) return { jsonrpc: "2.0", id: 2, result: { tools } };
            return null;
          }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.tools).toHaveLength(100);
  });
});

function createFakeChild(
  onLine: (line: string) => unknown | null,
  onKill?: () => void,
): McpChildProcess {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(inner) {
      controller = inner;
    },
  });
  const encoder = new TextEncoder();
  const emptyStream = new ReadableStream<Uint8Array>({
    start(inner) {
      inner.close();
    },
  });
  let settle: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });

  return {
    stdin: {
      write(chunk: string) {
        const buffer = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
        for (const line of buffer.split("\n")) {
          if (line.trim() === "") continue;
          const response = onLine(line);
          if (response !== null) {
            controller.enqueue(encoder.encode(`${JSON.stringify(response)}\n`));
          }
        }
        return chunk.length;
      },
      flush() {
        return undefined;
      },
    },
    stdout: stream,
    stderr: emptyStream,
    exited,
    kill() {
      onKill?.();
      controller.close();
      settle(0);
    },
  };
}

describe("http", () => {
  test("JSON biasa dengan mcp-session-id diteruskan pada permintaan berikutnya", async () => {
    const fake = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (body.method === "initialize") {
        return jsonResponse(INIT_OK, { "mcp-session-id": "sesi-1" });
      }
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "cari" }] } });
    });

    const result = await testMcpServer(
      {
        transport: "http",
        url: "https://mcp.test/sse",
        headers: { Authorization: "Bearer rahasia-header-panjang" },
      },
      { fetch: fake.fetch },
    );

    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: "cari" }]);
    expect(fake.calls).toHaveLength(3);

    const [initCall, initializedCall, toolsCall] = fake.calls;
    expect(initCall?.init.method).toBe("POST");
    expect(initCall?.init.redirect).toBe("manual");
    const initHeaders = initCall?.init.headers as Record<string, string>;
    expect(initHeaders["content-type"]).toBe("application/json");
    expect(initHeaders.accept).toContain("application/json");
    expect(initHeaders.accept).toContain("text/event-stream");
    expect(initHeaders.Authorization).toBe("Bearer rahasia-header-panjang");
    expect(initHeaders["mcp-session-id"]).toBeUndefined();

    const initializedHeaders = initializedCall?.init.headers as Record<string, string>;
    expect(initializedHeaders["mcp-session-id"]).toBe("sesi-1");
    const toolsHeaders = toolsCall?.init.headers as Record<string, string>;
    expect(toolsHeaders["mcp-session-id"]).toBe("sesi-1");
  });

  test("SSE mengambil event data pertama yang cocok id", async () => {
    const sse = (payload: unknown): Response =>
      new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} })}\n\n` +
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    const fake = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (body.method === "initialize") return sse(INIT_OK);
      if (body.method === "notifications/initialized") return new Response("", { status: 202 });
      return sse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "sse-tool" }] } });
    });

    const result = await testMcpServer(
      { transport: "http", url: "https://mcp.test/sse" },
      { fetch: fake.fetch },
    );
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: "sse-tool" }]);
  });

  test("redirect tidak diikuti dan menjadi galat", async () => {
    const fake = fakeFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://lain.test/sse" },
        }),
    );
    const result = await testMcpServer(
      { transport: "http", url: "https://mcp.test/sse" },
      { fetch: fake.fetch },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("redirect");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.init.redirect).toBe("manual");
  });

  test("galat HTTP dan galat JSON-RPC tidak memuat sentinel", async () => {
    const sentinel = "sentinel-header-rahasia";
    const fake = fakeFetch(() => jsonResponse({ error: { message: `gagal ${sentinel}` } }));
    const result = await testMcpServer(
      {
        transport: "http",
        url: "https://mcp.test/sse",
        headers: { Authorization: `Bearer ${sentinel}` },
      },
      { fetch: fake.fetch },
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(sentinel);
    expect(result.error).toContain("***");
  });

  test("galat jaringan dibersihkan dari nilai header", async () => {
    const sentinel = "token-jaringan-rahasia";
    const result = await testMcpServer(
      {
        transport: "http",
        url: "https://mcp.test/sse",
        headers: { "X-Token": sentinel },
      },
      {
        fetch: (async () => {
          throw new Error(`gagal menyambung dengan ${sentinel}`);
        }) as unknown as typeof fetch,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(sentinel);
  });

  test("timeout http menghasilkan galat batas waktu", async () => {
    const result = await testMcpServer(
      { transport: "http", url: "https://mcp.test/sse" },
      {
        timeoutMs: 300,
        fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("batas waktu");
  });

  test("balasan bukan JSON menjadi galat", async () => {
    const result = await testMcpServer(
      { transport: "http", url: "https://mcp.test/sse" },
      {
        fetch: (async () =>
          new Response("halo", {
            status: 200,
            headers: { "content-type": "text/plain" },
          })) as unknown as typeof fetch,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("JSON");
  });
});