import { VERSION } from "../../shared/version";
import type { McpServerConfig, McpTransport } from "./mcp-config";

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpTestResult {
  ok: boolean;
  tools?: McpToolInfo[];
  error?: string;
  ms: number;
}

export interface McpTestTarget {
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpChildProcess {
  stdin: { write(chunk: string): unknown; flush?: () => unknown } | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: number | string): void;
}

export interface McpSpawnOptions {
  env: Record<string, string>;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
}

export type McpSpawn = (command: string[], options: McpSpawnOptions) => McpChildProcess;

export interface McpTestOptions {
  timeoutMs?: number;
  spawn?: McpSpawn;
  fetch?: typeof fetch;
}

export const MCP_TEST_TIMEOUT_MS = 10_000;
export const MCP_TEST_OUTPUT_LIMIT = 1024 * 1024;
export const MCP_TEST_TOOLS_MAX = 100;
export const MCP_TEST_DESCRIPTION_MAX = 200;
export const MCP_TEST_STDERR_MAX = 300;
export const MCP_PROTOCOL_VERSION = "2025-06-18";

function defaultSpawn(command: string[], options: McpSpawnOptions): McpChildProcess {
  return Bun.spawn(command, {
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as McpChildProcess;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mengganti semua nilai env/header pada teks. Nilai pendek (< 4 karakter)
 * diabaikan agar pesan tidak rusak; nilai diurutkan terpanjang dulu.
 */
export function cleanSecrets(text: string, values: string[]): string {
  const candidates: string[] = [...values];
  // Nilai berbentuk "Bearer <token>" juga dibersihkan per bagian, agar galat
  // yang hanya mengutip tokennya ikut tersaring.
  for (const value of values) {
    candidates.push(...value.split(/\s+/));
  }
  const secrets = Array.from(new Set(candidates.filter((value) => value.length >= 4))).sort(
    (left, right) => right.length - left.length,
  );
  let cleaned = text;
  for (const secret of secrets) {
    cleaned = cleaned.split(secret).join("***");
  }
  return cleaned;
}

function secretValues(config: McpTestTarget): string[] {
  return [...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})];
}

function shortText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

class McpTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`batas waktu ${timeoutMs} ms terlampaui`);
    this.name = "McpTimeoutError";
  }
}

interface LineSource {
  next(): Promise<string | null>;
}

/** Pembaca baris dengan batas total byte; melempar galat bila batas lewat. */
function createLineSource(stream: ReadableStream<Uint8Array>, limit: number): LineSource {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const queue: string[] = [];
  const waiters: Array<{
    resolve: (value: string | null) => void;
    reject: (error: Error) => void;
  }> = [];
  let buffer = "";
  let total = 0;
  let done = false;
  let failure: Error | null = null;

  const drain = (): void => {
    while (waiters.length > 0) {
      const waiter = waiters[0]!;
      if (queue.length > 0) {
        waiters.shift();
        waiter.resolve(queue.shift()!);
        continue;
      }
      if (failure !== null) {
        waiters.shift();
        waiter.reject(failure);
        continue;
      }
      if (done) {
        waiters.shift();
        waiter.resolve(null);
        continue;
      }
      return;
    }
  };

  const pump = async (): Promise<void> => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          done = true;
          if (buffer !== "") {
            queue.push(buffer);
            buffer = "";
          }
          drain();
          return;
        }
        total += chunk.value.byteLength;
        if (total > limit) {
          failure = new Error("keluaran server MCP melebihi batas 1 MiB");
          queue.length = 0;
          drain();
          return;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (line.trim() !== "") queue.push(line);
          index = buffer.indexOf("\n");
        }
        drain();
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      drain();
    }
  };
  void pump();

  return {
    next(): Promise<string | null> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (failure !== null) return Promise.reject(failure);
      if (done) return Promise.resolve(null);
      return new Promise<string | null>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

function jsonRpcError(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (error === undefined) return null;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return "galat JSON-RPC";
}

async function readJsonRpc(
  source: LineSource,
  id: number,
): Promise<Record<string, unknown>> {
  while (true) {
    const line = await source.next();
    if (line === null) {
      throw new Error("server MCP menutup keluaran sebelum membalas");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof payload !== "object" || payload === null) continue;
    if ((payload as { id?: unknown }).id !== id) continue;
    const rpcError = jsonRpcError(payload);
    if (rpcError !== null) {
      throw new Error(`server MCP membalas galat: ${rpcError}`);
    }
    return payload as Record<string, unknown>;
  }
}

function parseTools(payload: Record<string, unknown>): McpToolInfo[] {
  const result = payload.result;
  const tools =
    typeof result === "object" && result !== null
      ? (result as { tools?: unknown }).tools
      : undefined;
  if (!Array.isArray(tools)) {
    throw new Error("balasan tools/list tidak memuat daftar tool");
  }
  const items: McpToolInfo[] = [];
  for (const raw of tools) {
    if (items.length >= MCP_TEST_TOOLS_MAX) break;
    if (typeof raw !== "object" || raw === null) continue;
    const name = (raw as { name?: unknown }).name;
    if (typeof name !== "string" || name === "") continue;
    const description = (raw as { description?: unknown }).description;
    if (typeof description === "string") {
      items.push({
        name,
        description: shortText(description, MCP_TEST_DESCRIPTION_MAX),
      });
    } else {
      items.push({ name });
    }
  }
  return items;
}

async function writeLine(child: McpChildProcess, line: string): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null) {
    throw new Error("stdin server MCP tidak tersedia");
  }
  stdin.write(line);
  if (typeof stdin.flush === "function") {
    await stdin.flush();
  }
}

async function stopChild(child: McpChildProcess): Promise<void> {
  try {
    child.kill(9);
  } catch {
    // Proses mungkin sudah berhenti.
  }
  try {
    await Promise.race([
      child.exited,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2_000);
      }),
    ]);
  } catch {
    // Kegagalan menunggu proses tidak boleh menutupi hasil tes.
  }
}

async function collectStderr(
  child: McpChildProcess,
  max: number,
  into: { text: string },
): Promise<void> {
  const stream = child.stderr;
  if (stream === undefined || stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (into.text.length < max) {
      const chunk = await reader.read();
      if (chunk.done) break;
      into.text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    // stderr hanya dipakai untuk petunjuk singkat.
  } finally {
    into.text = shortText(into.text.trim(), max);
    try {
      reader.releaseLock();
    } catch {
      // Tidak apa-apa bila reader sudah selesai.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stdioEnv(config: McpTestTarget): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG"] as const) {
    const value = process.env[key];
    if (value !== undefined && value !== "") base[key] = value;
  }
  return { ...base, ...(config.env ?? {}) };
}

async function runStdio(config: McpTestTarget, options: McpTestOptions): Promise<McpToolInfo[]> {
  const spawn = options.spawn ?? defaultSpawn;
  const timeoutMs = options.timeoutMs ?? MCP_TEST_TIMEOUT_MS;
  const command = config.command;
  if (command === undefined || command === "") {
    throw new Error("command server stdio kosong");
  }

  let child: McpChildProcess;
  try {
    child = spawn([command, ...(config.args ?? [])], {
      env: stdioEnv(config),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(`gagal menjalankan command server MCP: ${errorMessage(error)}`);
  }

  const stdout = child.stdout;
  if (stdout === null) {
    await stopChild(child);
    throw new Error("stdout server MCP tidak tersedia");
  }
  const source = createLineSource(stdout, MCP_TEST_OUTPUT_LIMIT);
  const stderrBuffer = { text: "" };
  void collectStderr(child, MCP_TEST_STDERR_MAX, stderrBuffer);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<McpToolInfo[]> => {
    await writeLine(
      child,
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "jejak", version: VERSION },
        },
      })}\n`,
    );
    await readJsonRpc(source, 1);
    await writeLine(
      child,
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    await writeLine(
      child,
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );
    const response = await readJsonRpc(source, 2);
    return parseTools(response);
  })();
  // Saat timeout, `work` masih menunggu; jangan sampai menjadi unhandled rejection.
  void work.catch(() => {});

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof McpTimeoutError) {
      await delay(50);
      const stderr = stderrBuffer.text;
      if (stderr !== "") {
        throw new Error(`${error.message}; stderr: ${stderr}`);
      }
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await stopChild(child);
  }
}

function httpHeaders(
  config: McpTestTarget,
  sessionId: string | undefined,
  withBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    ...(withBody ? { "content-type": "application/json" } : {}),
    ...(config.headers ?? {}),
  };
  if (sessionId !== undefined && sessionId !== "") {
    headers["mcp-session-id"] = sessionId;
  }
  return headers;
}

async function readHttpPayload(
  response: Response,
  id: number,
): Promise<Record<string, unknown>> {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`server MCP mengalihkan permintaan (HTTP ${response.status}); redirect tidak diikuti`);
  }
  if (!response.ok) {
    throw new Error(`server MCP membalas HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (text.length > MCP_TEST_OUTPUT_LIMIT) {
    throw new Error("keluaran server MCP melebihi 1024 KiB");
  }

  if (contentType.toLowerCase().includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());
      if (dataLines.length === 0) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(dataLines.join("\n"));
      } catch {
        continue;
      }
      if (typeof payload !== "object" || payload === null) continue;
      if ((payload as { id?: unknown }).id !== id) continue;
      const rpcError = jsonRpcError(payload);
      if (rpcError !== null) throw new Error(`server MCP membalas galat: ${rpcError}`);
      return payload as Record<string, unknown>;
    }
    throw new Error("balasan SSE tidak memuat respons yang cocok");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("balasan server MCP bukan JSON yang valid");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("balasan server MCP bukan objek JSON-RPC");
  }
  const rpcError = jsonRpcError(payload);
  if (rpcError !== null) throw new Error(`server MCP membalas galat: ${rpcError}`);
  if ((payload as { id?: unknown }).id !== id) {
    throw new Error("balasan server MCP tidak cocok dengan permintaan");
  }
  return payload as Record<string, unknown>;
}

async function runHttp(config: McpTestTarget, options: McpTestOptions): Promise<McpToolInfo[]> {
  const timeoutMs = options.timeoutMs ?? MCP_TEST_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;
  const url = config.url;
  if (url === undefined || url === "") {
    throw new Error("url server http kosong");
  }

  const post = async (
    body: unknown,
    sessionId: string | undefined,
    withBody: boolean,
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: httpHeaders(config, sessionId, withBody),
        body: JSON.stringify(body),
        redirect: "manual",
      });
    } catch (error) {
      throw new Error(`gagal menghubungi server MCP: ${errorMessage(error)}`);
    }
    return response;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async (): Promise<McpToolInfo[]> => {
    const initResponse = await post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "jejak", version: VERSION },
        },
      },
      undefined,
      true,
    );
    const sessionId = initResponse.headers.get("mcp-session-id") ?? undefined;
    await readHttpPayload(initResponse, 1);

    const initializedResponse = await post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
      true,
    );
    if (
      !initializedResponse.ok &&
      !(initializedResponse.status >= 200 && initializedResponse.status < 300)
    ) {
      throw new Error(`server MCP membalas HTTP ${initializedResponse.status} untuk notifications/initialized`);
    }

    const toolsResponse = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      sessionId,
      true,
    );
    return parseTools(await readHttpPayload(toolsResponse, 2));
  })();

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function testMcpServer(
  config: McpTestTarget,
  options: McpTestOptions = {},
): Promise<McpTestResult> {
  const started = performance.now();
  const secrets = secretValues(config);
  try {
    const tools = config.transport === "stdio" ? await runStdio(config, options) : await runHttp(config, options);
    return {
      ok: true,
      tools,
      ms: Math.max(0, Math.round(performance.now() - started)),
    };
  } catch (error) {
    return {
      ok: false,
      error: cleanSecrets(errorMessage(error), secrets),
      ms: Math.max(0, Math.round(performance.now() - started)),
    };
  }
}

/** Dipakai rute agar konfigurasi lengkap bisa langsung diuji. */
export function testTargetOf(config: McpServerConfig): McpTestTarget {
  return {
    transport: config.transport,
    ...(config.command === undefined ? {} : { command: config.command }),
    ...(config.args === undefined ? {} : { args: config.args }),
    ...(config.env === undefined ? {} : { env: config.env }),
    ...(config.url === undefined ? {} : { url: config.url }),
    ...(config.headers === undefined ? {} : { headers: config.headers }),
  };
}