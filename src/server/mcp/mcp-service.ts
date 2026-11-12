import {
  MCP_SERVERS_MAX,
  checkArgs,
  checkCommand,
  checkEnabled,
  checkEnv,
  checkHeaders,
  checkName,
  checkTransport,
  checkTransportFields,
  checkUrl,
  isMcpServerId,
  readMcpConfig,
  toView,
  validateServer,
  writeMcpConfig,
  type McpConfigFile,
  type McpProblem,
  type McpServerConfig,
  type McpServerView,
} from "./mcp-config";

export type McpErrorCode = "tidak-valid" | "tidak-ditemukan" | "konflik";

export class McpServerError extends Error {
  constructor(
    message: string,
    public readonly code: McpErrorCode,
  ) {
    super(message);
    this.name = "McpServerError";
  }
}

function invalid(message: string): McpServerError {
  return new McpServerError(message, "tidak-valid");
}

function notFound(id: string): McpServerError {
  return new McpServerError(`Server MCP "${id}" tidak ditemukan.`, "tidak-ditemukan");
}

function conflict(message: string): McpServerError {
  return new McpServerError(message, "konflik");
}

export interface ResolvedMcpServerStdio {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ResolvedMcpServerHttp {
  name: string;
  transport: "http";
  url: string;
  headers: Record<string, string>;
}

export type ResolvedMcpServer = ResolvedMcpServerStdio | ResolvedMcpServerHttp;

export interface CreateMcpServerInput {
  name?: unknown;
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
  enabled?: unknown;
}

export interface UpdateMcpServerInput extends CreateMcpServerInput {}

export interface McpServerListResult {
  items: McpServerView[];
  problems: McpProblem[];
}

export interface McpServerServiceOptions {
  path: string;
  now?: () => Date;
}

interface Mutex {
  tail: Promise<unknown>;
}

function createMutex(): Mutex {
  return { tail: Promise.resolve() };
}

async function withMutex<T>(mutex: Mutex, action: () => Promise<T>): Promise<T> {
  const previous = mutex.tail;
  let release: () => void = () => {};
  mutex.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

/** Field yang dikenal, dipakai agar field tak dikenal ditolak dengan jelas. */
const KNOWN_FIELDS = new Set([
  "name",
  "transport",
  "command",
  "args",
  "env",
  "url",
  "headers",
  "enabled",
]);

function rejectUnknownFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw invalid(`Field "${key}" tidak dikenal.`);
    }
  }
}

function value<T>(checked: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!checked.ok) {
    throw invalid(checked.reason);
  }
  return checked.value;
}

export class McpServerService {
  readonly path: string;
  private readonly now: () => Date;
  private readonly mutex: Mutex = createMutex();

  constructor(options: McpServerServiceOptions) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
  }

  private clock(): string {
    return this.now().toISOString();
  }

  private async read(): Promise<{ state: McpConfigFile; problems: McpProblem[] }> {
    const read = await readMcpConfig(this.path);
    return { state: read.config, problems: read.problems };
  }

  private async write(state: McpConfigFile): Promise<void> {
    await writeMcpConfig(this.path, state);
  }

  async list(): Promise<McpServerListResult> {
    const { state, problems } = await this.read();
    return {
      items: state.servers.map((server) => toView(server)),
      problems,
    };
  }

  async get(id: string): Promise<McpServerConfig | undefined> {
    if (!isMcpServerId(id)) {
      return undefined;
    }
    const { state } = await this.read();
    return state.servers.find((server) => server.id === id);
  }

  /**
   * Server aktif dengan nilai penuh untuk runner. Tidak pernah dikirim ke klien.
   */
  async resolved(): Promise<ResolvedMcpServer[]> {
    const { state } = await this.read();
    const result: ResolvedMcpServer[] = [];
    for (const server of state.servers) {
      if (!server.enabled) continue;
      if (server.transport === "stdio") {
        result.push({
          name: server.name,
          transport: "stdio",
          command: server.command ?? "",
          args: server.args ?? [],
          env: { ...(server.env ?? {}) },
        });
      } else {
        result.push({
          name: server.name,
          transport: "http",
          url: server.url ?? "",
          headers: { ...(server.headers ?? {}) },
        });
      }
    }
    return result;
  }

  async create(input: CreateMcpServerInput): Promise<McpServerView> {
    return withMutex(this.mutex, async () => {
      rejectUnknownFields(input as Record<string, unknown>);
      const name = value(checkName(input.name));
      const transport = value(checkTransport(input.transport));

      const draft: McpServerConfig = {
        id: crypto.randomUUID(),
        name,
        transport,
        enabled: input.enabled === undefined ? true : value(checkEnabled(input.enabled)),
        createdAt: this.clock(),
        updatedAt: this.clock(),
      };
      const cross = checkTransportFields({
        transport,
        command: input.command,
        args: input.args,
        env: input.env,
        url: input.url,
        headers: input.headers,
      });
      if (cross !== null) throw invalid(cross);

      if (transport === "stdio") {
        draft.command = value(checkCommand(input.command));
        if (input.args !== undefined) draft.args = value(checkArgs(input.args));
        if (input.env !== undefined) draft.env = value(checkEnv(input.env));
      } else {
        draft.url = value(checkUrl(input.url));
        if (input.headers !== undefined) draft.headers = value(checkHeaders(input.headers));
      }

      const reason = validateServer(draft);
      if (reason !== null) throw invalid(reason);

      const { state } = await this.read();
      if (state.servers.length >= MCP_SERVERS_MAX) {
        throw conflict(`Batas ${MCP_SERVERS_MAX} server MCP sudah tercapai.`);
      }
      if (state.servers.some((server) => server.name === name)) {
        throw conflict(`Nama server "${name}" sudah dipakai.`);
      }

      state.servers.push(draft);
      await this.write(state);
      return toView(draft);
    });
  }

  async update(id: string, input: UpdateMcpServerInput): Promise<McpServerView> {
    return withMutex(this.mutex, async () => {
      const { state } = await this.read();
      const index = state.servers.findIndex((server) => server.id === id);
      const current = state.servers[index];
      if (current === undefined) {
        throw notFound(id);
      }
      rejectUnknownFields(input as Record<string, unknown>);

      const transport =
        input.transport === undefined
          ? current.transport
          : value(checkTransport(input.transport));

      const name =
        input.name === undefined ? current.name : value(checkName(input.name));

      const changingTransport = transport !== current.transport;
      const next: McpServerConfig = {
        id: current.id,
        name,
        transport,
        enabled:
          input.enabled === undefined ? current.enabled : value(checkEnabled(input.enabled)),
        createdAt: current.createdAt,
        updatedAt: this.clock(),
      };

      if (changingTransport) {
        // Ganti transport hanya diizinkan bila semua field baru lengkap dan
        // field lama tidak dipertahankan diam-diam.
        const staleFields =
          transport === "stdio" ? ["url", "headers"] : ["command", "args", "env"];
        for (const key of staleFields) {
          if (input[key as keyof UpdateMcpServerInput] !== undefined) {
            throw invalid(`Field "${key}" bukan milik transport ${transport}.`);
          }
        }
        const cross = checkTransportFields({
          transport,
          command: input.command,
          args: input.args,
          env: input.env,
          url: input.url,
          headers: input.headers,
        });
        if (cross !== null) throw invalid(cross);
        if (transport === "stdio") {
          next.command = value(checkCommand(input.command));
          if (input.args !== undefined) next.args = value(checkArgs(input.args));
          if (input.env !== undefined) next.env = value(checkEnv(input.env));
        } else {
          next.url = value(checkUrl(input.url));
          if (input.headers !== undefined) next.headers = value(checkHeaders(input.headers));
        }
      } else if (transport === "stdio") {
        if (input.url !== undefined || input.headers !== undefined) {
          throw invalid("Field url/headers bukan milik transport stdio.");
        }
        next.command =
          input.command === undefined ? current.command : value(checkCommand(input.command));
        next.args = input.args === undefined ? current.args : value(checkArgs(input.args));
        next.env =
          input.env === undefined
            ? current.env
            : mergePartialEnv(current.env ?? {}, input.env);
      } else {
        if (input.command !== undefined || input.args !== undefined || input.env !== undefined) {
          throw invalid("Field command/args/env bukan milik transport http.");
        }
        next.url = input.url === undefined ? current.url : value(checkUrl(input.url));
        next.headers =
          input.headers === undefined
            ? current.headers
            : mergePartialHeaders(current.headers ?? {}, input.headers);
      }

      const reason = validateServer(next);
      if (reason !== null) throw invalid(reason);

      if (state.servers.some((server, position) => position !== index && server.name === name)) {
        throw conflict(`Nama server "${name}" sudah dipakai.`);
      }

      state.servers[index] = next;
      await this.write(state);
      return toView(next);
    });
  }

  async delete(id: string): Promise<void> {
    return withMutex(this.mutex, async () => {
      if (!isMcpServerId(id)) {
        throw notFound(id);
      }
      const { state } = await this.read();
      const index = state.servers.findIndex((server) => server.id === id);
      if (index === -1) {
        throw notFound(id);
      }
      state.servers.splice(index, 1);
      await this.write(state);
    });
  }
}

/**
 * PATCH env/headers: nilai teks = set/ganti, `null` = hapus kunci, kunci yang
 * tidak disebut dipertahankan.
 */
function mergePartialEnv(
  current: Record<string, string>,
  patch: unknown,
): Record<string, string> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw invalid("Field env harus berupa objek.");
  }
  const next: Record<string, string> = { ...current };
  for (const [key, raw] of Object.entries(patch as Record<string, unknown>)) {
    if (raw === null) {
      delete next[key];
      continue;
    }
    if (typeof raw !== "string") {
      throw invalid(`Nilai env "${key}" harus berupa teks atau null.`);
    }
    next[key] = raw;
  }
  return value(checkEnv(next));
}

function mergePartialHeaders(
  current: Record<string, string>,
  patch: unknown,
): Record<string, string> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw invalid("Field headers harus berupa objek.");
  }
  const next: Record<string, string> = { ...current };
  for (const [key, raw] of Object.entries(patch as Record<string, unknown>)) {
    if (raw === null) {
      delete next[key];
      continue;
    }
    if (typeof raw !== "string") {
      throw invalid(`Nilai header "${key}" harus berupa teks atau null.`);
    }
    next[key] = raw;
  }
  return value(checkHeaders(next));
}