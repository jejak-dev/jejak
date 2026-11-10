import { toSdkEnv, type ResolvedProvider } from "../provider";
import type {
  AgentEvent,
  AgentRunner,
  RunInput,
  PermissionRequest,
  ResolvedMcpServer,
} from "./events";
import { contextTokensOf, contextWindowOf, mapSdkMessage } from "./sdk-mapper";

const SDK_MODULE: string = "@anthropic-ai/claude-agent-sdk";

const SDK_NOT_INSTALLED =
  "Claude Agent SDK belum terpasang. Pasang paket @anthropic-ai/claude-agent-sdk sendiri " +
  "(lisensi Anthropic; tidak dibundel dengan Jejak) atau jalankan dengan MOCK=true.";

const PROFILE_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

const DELTA_FLUSH_MS = 50;

export interface SdkQuery extends AsyncIterable<unknown> {
  close?(): void;
}

export interface SdkModule {
  query(args: { prompt: string; options?: Record<string, unknown> }): SdkQuery;
}

export interface SdkRunnerOptions {
  load?: () => Promise<SdkModule>;
  baseEnv?: Record<string, string | undefined>;
}

async function defaultLoad(): Promise<SdkModule> {
  const imported: unknown = await import(SDK_MODULE);
  return imported as SdkModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSdkModule(value: unknown): SdkModule {
  if (!isRecord(value) || typeof value.query !== "function") {
    throw new Error("Modul SDK tidak valid: fungsi query tidak ditemukan.");
  }
  return value as unknown as SdkModule;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitize(
  text: string,
  apiKey: string | undefined,
  extraValues: readonly string[] = [],
): string {
  let cleaned = text;
  if (apiKey !== undefined && apiKey !== "") {
    cleaned = cleaned.split(apiKey).join("***");
  }
  const candidates: string[] = [];
  for (const value of extraValues) {
    candidates.push(value, ...value.split(/\s+/));
  }
  const secrets = Array.from(
    new Set(candidates.filter((value) => value.length >= 4)),
  ).sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    cleaned = cleaned.split(secret).join("***");
  }
  return cleaned;
}

/** Semua nilai env/header server eksternal; dipakai untuk membersihkan galat. */
function mcpSecretValues(servers: readonly ResolvedMcpServer[] | undefined): string[] {
  if (servers === undefined) return [];
  const values: string[] = [];
  for (const server of servers) {
    if (server.transport === "stdio") {
      values.push(...Object.values(server.env));
    } else {
      values.push(...Object.values(server.headers));
    }
  }
  return values;
}

const EXTERNAL_MCP_PREFIX = "ext-";

// alwaysLoad menghindari satu putaran ToolSearch per sesi; konsekuensinya skema semua tool server ikut di prompt dan startup menunggu koneksi server (maks ~5 dtk).
function externalMcpServers(
  servers: readonly ResolvedMcpServer[] | undefined,
): Record<string, unknown> | undefined {
  if (servers === undefined || servers.length === 0) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.transport === "stdio") {
      result[`${EXTERNAL_MCP_PREFIX}${server.name}`] = {
        type: "stdio",
        command: server.command,
        args: [...server.args],
        env: { ...server.env },
        alwaysLoad: true,
      };
    } else {
      result[`${EXTERNAL_MCP_PREFIX}${server.name}`] = {
        type: "http",
        url: server.url,
        headers: { ...server.headers },
        alwaysLoad: true,
      };
    }
  }
  return result;
}

function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

type SecretGuard = NonNullable<RunInput["secretGuard"]>;

/** Hook `PreToolUse` yang menolak tool bila kebijakan rahasia mengembalikan alasan. */
function preToolUseHook(guard: SecretGuard): (input: unknown) => Promise<unknown> {
  return async (input: unknown): Promise<unknown> => {
    try {
      if (!isRecord(input) || input.hook_event_name !== "PreToolUse") return {};
      const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
      const agentId =
        typeof input.agent_id === "string" && input.agent_id !== ""
          ? input.agent_id
          : undefined;
      const result = guard({ toolName, toolInput: input.tool_input, agentId });
      if (!isRecord(result) || typeof result.reason !== "string") return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
      };
    } catch {
      // Kebijakan tidak boleh membuat sesi macet.
      return {};
    }
  };
}

const MEMORY_TOOL_ALLOWLIST = [
  "mcp__jejak-memory__memory_search",
  "mcp__jejak-memory__memory_propose",
];

const WORKSPACE_TOOL_ALLOWLIST = [
  "mcp__jejak-memory__workspace_overview",
  "mcp__jejak-memory__workspace_service",
];

const MCP_SERVER_NAME = "mcp__jejak-memory__";

/** Daftar tool yang diizinkan dari nama tool mentah pada RunMemory. */
function allowedToolsFor(input: RunInput): string[] {
  const memory = input.memory;
  const hasWorkspace = input.workspace !== undefined;
  if (memory?.tools !== undefined) {
    const allowed: string[] = [];
    for (const tool of memory.tools) {
      if (tool === "memory_search" || tool === "memory_propose" || tool === "question_ask" || tool === "index_repos" || tool === "index_search" || tool === "index_file") {
        allowed.push(`${MCP_SERVER_NAME}${tool}`);
      } else if (hasWorkspace && (tool === "workspace_overview" || tool === "workspace_service")) {
        allowed.push(`${MCP_SERVER_NAME}${tool}`);
      }
    }
    return allowed;
  }
  const allowed = [...MEMORY_TOOL_ALLOWLIST];
  if (hasWorkspace) allowed.push(...WORKSPACE_TOOL_ALLOWLIST);
  return allowed;
}

export function buildSdkEnv(
  base: Record<string, string | undefined>,
  resolved: ResolvedProvider,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of PROFILE_ENV_KEYS) {
    delete env[key];
  }
  return { ...env, ...toSdkEnv(resolved) };
}

/** Menyetel batas retry SDK; nilai yang sudah diset pengguna di env tidak ditimpa. */
export function withMaxRetries(
  env: Record<string, string | undefined>,
  maxRetries: number | undefined,
): Record<string, string | undefined> {
  if (maxRetries === undefined) return env;
  if (env.CLAUDE_CODE_MAX_RETRIES !== undefined && env.CLAUDE_CODE_MAX_RETRIES !== "") return env;
  return { ...env, CLAUDE_CODE_MAX_RETRIES: String(maxRetries) };
}

export function createSdkRunner(options: SdkRunnerOptions = {}): AgentRunner {
  const load = options.load ?? defaultLoad;
  const baseEnv = options.baseEnv ?? process.env;

  return {
    async *run(input: RunInput) {
      let sdk: SdkModule;
      try {
        sdk = requireSdkModule(await load());
      } catch {
        yield { type: "error", message: SDK_NOT_INSTALLED };
        yield { type: "result", ok: false, error: SDK_NOT_INSTALLED };
        return;
      }

      const abortController = new AbortController();
      const forwardAbort = (): void => abortController.abort();
      const signal = input.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          abortController.abort();
        } else {
          signal.addEventListener("abort", forwardAbort, { once: true });
        }
      }

      const memory = input.memory;
      let append = `Folder kerja sesi ini adalah ${sanitizeCwd(input.cwd)}. Semua path relatif merujuk ke folder itu. Saat membaca atau mengubah berkas, pakai path relatif atau path absolut yang diawali folder tersebut; jangan menebak path lain seperti /home/... atau /Users/....`;
      if (memory !== undefined) {
        append = `${append} ${sanitizeCwd(memory.indexLine)}`;
      }
      const workspace = input.workspace;
      if (workspace !== undefined) {
        const repos = workspace.repos
          .map(
            (repo) =>
              `${sanitizeCwd(repo.name)} (${sanitizeCwd(repo.kind)}) di ${sanitizeCwd(repo.path)}`,
          )
          .join(", ");
        append = `${append} Sesi ini bagian dari workspace "${sanitizeCwd(workspace.name)}" dengan repo: ${repos}; folder kerja utama tetap ${sanitizeCwd(input.cwd)}. Kartu service tidak disertakan di sini.`;
      }

      const sdkOptions: Record<string, unknown> = {
        cwd: input.cwd,
        env: withMaxRetries(buildSdkEnv(baseEnv, input.provider), input.maxRetries),
        permissionMode: input.permissionMode ?? "default",
        abortController,
        includePartialMessages: true,
        settingSources: ["project"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append,
        },
      };

      // Tanpa `claude` perilaku lama persis; dengan `claude`, sumber pengguna
      // opt-in dan saklar global hooks diteruskan ke SDK.
      const claude = input.claude;
      if (claude !== undefined) {
        sdkOptions.settingSources = claude.userSettings
          ? ["project", "user"]
          : ["project"];
        if (claude.hooksEnabled === false) {
          const existingSettings = isRecord(sdkOptions.settings)
            ? sdkOptions.settings
            : {};
          sdkOptions.settings = { ...existingSettings, disableAllHooks: true };
        }
        if (claude.skills !== undefined) {
          sdkOptions.skills = [...claude.skills];
        }
      }
      const allowedTools = allowedToolsFor(input);
      const memoryServers: Record<string, unknown> = {};
      const hasMemoryServer =
        memory !== undefined &&
        memory.url !== undefined &&
        memory.token !== undefined &&
        allowedTools.length > 0;
      if (hasMemoryServer) {
        memoryServers["jejak-memory"] = {
          type: "http",
          url: memory.url,
          headers: { Authorization: `Bearer ${memory.token}` },
          alwaysLoad: true,
        };
      }
      const external = externalMcpServers(input.mcpServers);
      if (hasMemoryServer || external !== undefined) {
        sdkOptions.mcpServers = external === undefined
          ? memoryServers
          : { ...memoryServers, ...external };
      }
      if (hasMemoryServer) {
        sdkOptions.allowedTools = allowedTools;
      }
      if (input.provider.model !== undefined) {
        sdkOptions.model = input.provider.model;
      }
      if (input.resumeSessionId !== undefined) {
        sdkOptions.resume = input.resumeSessionId;
      }
      if (workspace !== undefined && workspace.additionalDirectories.length > 0) {
        sdkOptions.additionalDirectories = workspace.additionalDirectories;
      }
      if (input.permissionMode === "bypassPermissions") {
        sdkOptions.allowDangerouslySkipPermissions = true;
      }

      // Tanpa `sandbox` perilaku lama persis; dengan `sandbox` opsi diteruskan apa adanya.
      if (input.sandbox !== undefined) {
        sdkOptions.sandbox = input.sandbox;
      }

      const secretGuard = input.secretGuard;
      if (secretGuard !== undefined) {
        const existingHooks = isRecord(sdkOptions.hooks) ? sdkOptions.hooks : {};
        const existingPre = existingHooks.PreToolUse;
        const ours = { hooks: [preToolUseHook(secretGuard)] };
        sdkOptions.hooks = {
          ...existingHooks,
          PreToolUse: Array.isArray(existingPre) ? [...existingPre, ours] : [ours],
        };
      }

      // Add canUseTool handler if requestPermission is provided
      const requestPermission = input.requestPermission;
      if (requestPermission !== undefined) {
        sdkOptions.canUseTool = async (
          toolName: string,
          toolInput: unknown,
          ctx: { signal?: AbortSignal; toolUseID?: string } | undefined,
        ): Promise<
          { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string }
        > => {
          const request: PermissionRequest = {
            toolUseId: ctx?.toolUseID,
            name: toolName,
            input: toolInput,
          };

          try {
            const decision = await requestPermission(request, ctx?.signal ?? abortController.signal);

            if (decision.behavior === "allow") {
              return { behavior: "allow", updatedInput: decision.updatedInput ?? toolInput };
            } else {
              return { behavior: "deny", message: decision.message };
            }
          } catch {
            return { behavior: "deny", message: "izin gagal diproses" };
          }
        };
      }

      let query: SdkQuery | undefined;
      let sawResult = false;
      try {
        query = sdk.query({ prompt: input.prompt, options: sdkOptions });
        // Delta teks digabung ~50 ms agar tidak membanjiri SSE; event final menggantikannya.
        let pendingDelta = "";
        let pendingParent: string | undefined;
        let lastFlush = 0;
        let contextTokens: number | undefined;
        for await (const message of query) {
          contextTokens = contextTokensOf(message) ?? contextTokens;
          for (const event of mapSdkMessage(message)) {
            if (event.type === "text_delta") {
              if (pendingParent !== event.parentToolUseId && pendingDelta !== "") {
                pendingDelta = "";
              }
              pendingParent = event.parentToolUseId;
              pendingDelta += event.text;
              const now = Date.now();
              if (now - lastFlush >= DELTA_FLUSH_MS) {
                lastFlush = now;
                const text = pendingDelta;
                pendingDelta = "";
                yield pendingParent === undefined
                  ? { type: "text_delta", text }
                  : { type: "text_delta", text, parentToolUseId: pendingParent };
              }
              continue;
            }
            pendingDelta = "";
            if (event.type === "result") {
              sawResult = true;
              if (contextTokens !== undefined) event.contextTokens = contextTokens;
              const window = contextWindowOf(message);
              if (window !== undefined) event.contextWindow = window;
            }
            yield event;
          }
        }

        if (!sawResult) {
          if (abortController.signal.aborted) {
            yield { type: "result", ok: false, error: "dibatalkan" };
          } else {
            yield { type: "result", ok: false, error: "sesi berakhir tanpa hasil" };
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          yield { type: "error", message: "dibatalkan" };
          if (!sawResult) yield { type: "result", ok: false, error: "dibatalkan" };
          return;
        }
        let message = sanitize(
          errorMessage(error),
          input.provider.apiKey,
          mcpSecretValues(input.mcpServers),
        );
        if (input.memory?.token !== undefined && input.memory.token !== "") {
          message = message.split(input.memory.token).join("***");
        }
        yield { type: "error", message };
        if (!sawResult) yield { type: "result", ok: false, error: message };
      } finally {
        if (signal !== undefined) {
          signal.removeEventListener("abort", forwardAbort);
        }
        try {
          query?.close?.();
        } catch {
          // close milik SDK tidak boleh menggagalkan run.
        }
      }
    },
  };
}
