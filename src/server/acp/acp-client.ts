/**
 * Klien ACP (Agent Client Protocol) minimal: satu proses anak, JSON-RPC 2.0
 * satu pesan per baris lewat stdin/stdout. Klien ini tidak tahu agent apa pun;
 * perintah dijalankan apa adanya oleh pemanggil (mis. `agy acp`).
 *
 * Isi pesan tidak pernah dicatat ke log di sini; penyamaran teks adalah tugas
 * pemanggil.
 */
import { createLineParser } from "./line-reader";

export interface AcpTransport {
  /** Kirim satu baris; transport menambahkan `\n`. */
  write(line: string): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: unknown;
  options: { optionId: string; name: string; kind: string }[];
}

export type PermissionHandler = (
  params: PermissionRequest,
) => Promise<{ optionId: string } | "cancelled">;

export interface AcpUpdate {
  sessionId: string;
  /** `params.update.sessionUpdate`; string kosong bila tak ada. */
  kind: string;
  raw: unknown;
}

export interface AcpInitResult {
  protocolVersion: number;
  authMethods: { id: string; name: string }[];
  agentCapabilities: object;
}

/** Galat JSON-RPC dari agent. Kode -32000 berarti butuh autentikasi. */
export class AcpError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }

  get needsAuth(): boolean {
    return this.code === -32000;
  }
}

interface AcpClientOptions {
  requestTimeoutMs?: number;
  onPermission?: PermissionHandler;
  onUpdate?: (u: AcpUpdate) => void;
  onExit?: (code: number | null) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Transport sungguhan di atas `Bun.spawn`. Perintah yang tidak ditemukan tidak
 * melempar keluar: `onExit` dipanggil dengan kode non-nol (Bun melempar
 * sinkron saat executable tak ada, jadi ditangkap di sini).
 */
export function spawnTransport(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): AcpTransport {
  if (command.length === 0 || !command[0]) {
    throw new Error("Perintah ACP kosong");
  }

  const dataHandlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<(code: number | null) => void> = [];
  /** undefined = belum keluar; null = keluar tanpa kode. */
  let exitCode: number | null | undefined;
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  function emitData(chunk: string): void {
    for (const handler of dataHandlers) handler(chunk);
  }

  function notifyExit(code: number | null): void {
    if (exitCode !== undefined) return;
    exitCode = code;
    const handlers = exitHandlers.splice(0, exitHandlers.length);
    for (const handler of handlers) handler(code);
  }

  try {
    proc = Bun.spawn(command, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    // Perintah tak ditemukan / gagal dijalankan. Beri kode ala shell.
    notifyExit(127);
    return {
      write: () => {},
      onData: (cb) => {
        dataHandlers.push(cb);
      },
      onExit: (cb) => {
        if (exitCode !== undefined) {
          const code = exitCode;
          queueMicrotask(() => cb(code));
          return;
        }
        exitHandlers.push(cb);
      },
      kill: () => {},
    };
  }

  const spawned = proc;

  const decoder = new TextDecoder();
  void (async () => {
    const stream = typeof spawned.stdout === "number" ? null : spawned.stdout;
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) emitData(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) emitData(tail);
    } catch {
      // Stream putus karena proses berhenti; penanganan ada di exited.
    }
  })();

  void spawned.exited
    .then((code) => notifyExit(code))
    .catch(() => notifyExit(1));

  return {
    write(line: string): void {
      const sink = typeof spawned.stdin === "number" ? null : spawned.stdin;
      if (!sink) return;
      try {
        sink.write(`${line}\n`);
        sink.flush();
      } catch {
        // Pipe sudah tutup; exit akan dilaporkan lewat onExit.
      }
    },
    onData(cb: (chunk: string) => void): void {
      dataHandlers.push(cb);
    },
    onExit(cb: (code: number | null) => void): void {
      if (exitCode !== undefined) {
        const code = exitCode;
        queueMicrotask(() => cb(code));
        return;
      }
      exitHandlers.push(cb);
    },
    kill(): void {
      if (exitCode !== undefined) return;
      try {
        spawned.kill();
      } catch {
        // Sudah berhenti.
      }
    },
  };
}

function toPermissionRequest(params: unknown): PermissionRequest {
  const record = isRecord(params) ? params : {};
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
  const rawOptions = Array.isArray(record.options) ? record.options : [];
  const options: PermissionRequest["options"] = [];
  for (const item of rawOptions) {
    if (!isRecord(item) || typeof item.optionId !== "string") continue;
    options.push({
      optionId: item.optionId,
      name: typeof item.name === "string" ? item.name : item.optionId,
      kind: typeof item.kind === "string" ? item.kind : "",
    });
  }
  return { sessionId, toolCall: record.toolCall, options };
}

export class AcpClient {
  private readonly transport: AcpTransport;
  private readonly requestTimeoutMs: number;
  private readonly onPermission?: PermissionHandler;
  private readonly onUpdate?: (u: AcpUpdate) => void;
  private readonly onExit?: (code: number | null) => void;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private exitNotified = false;

  constructor(transport: AcpTransport, opts?: AcpClientOptions) {
    this.transport = transport;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onPermission = opts?.onPermission;
    this.onUpdate = opts?.onUpdate;
    this.onExit = opts?.onExit;

    this.transport.onData(createLineParser((msg) => this.handleMessage(msg)));
    this.transport.onExit((code) => this.handleTransportExit(code));
  }

  async initialize(): Promise<AcpInitResult> {
    const result = await this.request(
      "initialize",
      { protocolVersion: 1, clientCapabilities: {} },
      this.requestTimeoutMs,
    );
    const record = isRecord(result) ? result : {};
    const protocolVersion =
      typeof record.protocolVersion === "number" ? record.protocolVersion : 1;
    const rawAuth = Array.isArray(record.authMethods) ? record.authMethods : [];
    const authMethods: AcpInitResult["authMethods"] = [];
    for (const item of rawAuth) {
      if (!isRecord(item) || typeof item.id !== "string") continue;
      authMethods.push({
        id: item.id,
        name: typeof item.name === "string" ? item.name : item.id,
      });
    }
    const agentCapabilities = isRecord(record.agentCapabilities)
      ? record.agentCapabilities
      : {};
    return { protocolVersion, authMethods, agentCapabilities };
  }

  async newSession(cwd: string): Promise<{ sessionId: string; configOptions: unknown[] }> {
    const result = await this.request(
      "session/new",
      { cwd, mcpServers: [] },
      this.requestTimeoutMs,
    );
    const record = isRecord(result) ? result : {};
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
    if (sessionId === "") {
      throw new Error("agent ACP tidak mengembalikan sessionId");
    }
    const configOptions = Array.isArray(record.configOptions) ? record.configOptions : [];
    return { sessionId, configOptions };
  }

  /** Giliran agent bisa lama, jadi tanpa timeout. */
  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const result = await this.request(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      null,
    );
    const record = isRecord(result) ? result : {};
    return { stopReason: typeof record.stopReason === "string" ? record.stopReason : "" };
  }

  cancel(sessionId: string): void {
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const item of pending) {
      if (item.timer !== undefined) clearTimeout(item.timer);
      item.reject(new Error("koneksi ACP ditutup"));
    }
    try {
      this.transport.kill();
    } catch {
      // Sudah berhenti.
    }
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.transport.write(JSON.stringify(message));
    } catch {
      // Transport sudah tutup; request tertunda akan ditolak lewat onExit.
    }
  }

  private request(method: string, params: unknown, timeoutMs: number | null): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("koneksi ACP sudah ditutup"));
    }
    if (this.exitNotified) {
      return Promise.reject(new Error("agent ACP sudah keluar"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const item: PendingRequest = { resolve, reject };
      if (timeoutMs !== null) {
        item.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`batas waktu ${timeoutMs} ms terlampaui untuk ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, item);
      try {
        this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        if (item.timer !== undefined) clearTimeout(item.timer);
        reject(new Error(`gagal mengirim ${method}: ${errorMessage(error)}`));
      }
    });
  }

  private handleMessage(msg: unknown): void {
    if (!isRecord(msg)) return;
    const method = typeof msg.method === "string" ? msg.method : null;
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;

    if (method !== null && hasId) {
      // Request dari agent: wajib dibalas, jangan pernah diabaikan.
      void this.handleIncomingRequest(msg, method, msg.id);
      return;
    }
    if (method !== null) {
      this.handleNotification(method, msg.params);
      return;
    }
    this.handleResponse(msg);
  }

  private handleResponse(msg: Record<string, unknown>): void {
    if (typeof msg.id !== "number") return;
    const id = msg.id;
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    if (item.timer !== undefined) clearTimeout(item.timer);

    if ("error" in msg) {
      const error = isRecord(msg.error) ? msg.error : {};
      const code = typeof error.code === "number" ? error.code : -32603;
      const message =
        typeof error.message === "string" ? error.message : `galat JSON-RPC ${code}`;
      item.reject(new AcpError(code, message, error.data));
      return;
    }
    item.resolve("result" in msg ? msg.result : undefined);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update") return; // notifikasi tak dikenal diabaikan
    const record = isRecord(params) ? params : {};
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
    const update = record.update;
    let kind = "";
    if (isRecord(update) && typeof update.sessionUpdate === "string") {
      kind = update.sessionUpdate;
    }
    try {
      this.onUpdate?.({ sessionId, kind, raw: update ?? params });
    } catch {
      // Galat di callback pemanggil tidak boleh menghentikan pembacaan stdout.
    }
  }

  private async handleIncomingRequest(
    msg: Record<string, unknown>,
    method: string,
    id: unknown,
  ): Promise<void> {
    if (method === "session/request_permission") {
      let outcome: Record<string, unknown> = { outcome: "cancelled" };
      try {
        const answer = this.onPermission
          ? await this.onPermission(toPermissionRequest(msg.params))
          : "cancelled";
        if (answer !== "cancelled") {
          outcome = { outcome: "selected", optionId: answer.optionId };
        }
      } catch {
        // Handler gagal: tolak secara aman.
        outcome = { outcome: "cancelled" };
      }
      this.send({ jsonrpc: "2.0", id, result: { outcome } });
      return;
    }
    this.send({
      jsonrpc: "2.0",
      id,
      error: { code: JSON_RPC_METHOD_NOT_FOUND, message: "Method not found" },
    });
  }

  private handleTransportExit(code: number | null): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    const kode = code === null ? "tidak diketahui" : String(code);
    for (const item of pending) {
      if (item.timer !== undefined) clearTimeout(item.timer);
      item.reject(new Error(`agent ACP keluar (kode ${kode})`));
    }
    this.onExit?.(code);
  }
}
