import { agentsMdNote } from "../claude-config/agents-md";
import { toSdkEnv, type ResolvedProvider } from "../provider";
import {
  cachedClaude,
  locateClaude as defaultLocateClaude,
  nextClaudeCacheKey,
  type ClaudeLocation,
} from "../sdk/claude-locator";
import {
  defaultSdkLoader,
  detectCompiled,
  SDK_NOT_INSTALLED_MESSAGE,
  SdkBrokenInstallError,
  SdkNotInstalledError,
  type SdkModule,
  type SdkQuery,
  type SdkSlashCommand,
} from "../sdk/sdk-loader";
import type {
  AgentRunner,
  CommandInfo,
  ListCommandsInput,
  RunClaudeConfig,
  RunInput,
  PermissionRequest,
  ResolvedMcpServer,
} from "./events";
import {
  assistantUuidOf,
  contextTokensOf,
  contextWindowOf,
  mapSdkMessage,
  reconcileContextTokens,
} from "./sdk-mapper";
import {
  createSteerInput,
  queuedTurnCountOf,
  type SteerInput,
  type SteerUserMessage,
} from "./steer-input";

export type { SdkModule, SdkQuery } from "../sdk/sdk-loader";

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

export interface SdkRunnerOptions {
  load?: () => Promise<SdkModule>;
  baseEnv?: Record<string, string | undefined>;
  /** Pencari CLI `claude` milik pengguna; bawaan `locateClaude`. */
  locateClaude?: () => Promise<ClaudeLocation | null>;
  /** Deteksi binary terkompilasi; bawaan `detectCompiled`. */
  isCompiled?: () => boolean;
  /** Jam untuk cache pencarian; bawaan `Date.now`. */
  now?: () => number;
  /** Batas waktu membaca daftar perintah; bawaan 20 detik. */
  commandTimeoutMs?: number;
}

const defaultLoad = defaultSdkLoader;

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

/**
 * Pesan galat saat SDK gagal dimuat.
 *
 * SDK terkelola yang rusak punya pesan sendiri (menyebut versi aktif);
 * galat lain tetap memakai pesan "belum terpasang" dengan detail aslinya.
 */
function loadFailureMessage(error: unknown): string {
  if (error instanceof SdkNotInstalledError) return SDK_NOT_INSTALLED_MESSAGE;
  if (error instanceof SdkBrokenInstallError) return error.message;
  return `${SDK_NOT_INSTALLED_MESSAGE} (${errorMessage(error)})`;
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

function sanitizeText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function sanitizeCwd(cwd: string): string {
  return sanitizeText(cwd);
}

/** Pengingat system prompt saat Bash berjalan di dalam sandbox. */
export const SANDBOX_APPEND_NOTE =
  "Bash sesi ini berjalan di dalam sandbox: tulis hanya di folder kerja, jaringan memakai allowlist, dan socket Unix serta localhost mungkin diblokir. Galat seperti 'operation not permitted', 'cannot connect to the Docker daemon', atau 'connection refused' bisa berarti DIBLOKIR sandbox, bukan layanan yang mati. Jangan mencoba menyalakan ulang daemon atau layanan; laporkan ke pengguna dan sarankan mengubah sandbox sesi di bar balasan atau menambah izin di Pengaturan > Sandbox.";

/** Catatan system prompt untuk giliran pertanyaan sampingan (`/btw`). */
export const ASIDE_APPEND_NOTE =
  "Pertanyaan ini adalah pertanyaan sampingan: jawab singkat berdasarkan percakapan yang ada, tanpa memakai tool.";

/**
 * Catatan system prompt untuk mode plan.
 *
 * Dokumen rencana/PRD ditulis penuh di parameter plan ExitPlanMode; chat
 * hanya menampilkan ringkasan singkat supaya riwayat tetap ringkas.
 */
export const PLAN_MODE_APPEND_NOTE =
  "Mode plan: fokus menyusun rancangan dan PRD, bukan menulis kode. Tuliskan seluruh dokumen rancangan/PRD lengkap (markdown, berjudul) di berkas plan yang ditentukan sistem, lalu ajukan lewat ExitPlanMode. Jangan menempelkan dokumen panjang di chat; di chat cukup ringkasan singkat (maks 3 kalimat) tentang apa yang sudah disusun dan keputusan yang perlu ditinjau.";

/**
 * Catatan identitas model untuk provider non-Claude lewat baseUrl kustom.
 *
 * Preset `claude_code` menyisipkan daftar model Claude terbaru ke system
 * prompt; model lain bisa salah mengira itu model yang sedang dipakai dan
 * mengaku sebagai Opus/Sonnet/Haiku. Catatan ini tegas soal identitas model.
 */
export function modelIdentityNote(model: string): string {
  return `Kamu berjalan di model "${sanitizeText(model)}" lewat provider kustom. Daftar model Claude di konteks ini hanyalah informasi umum, bukan model yang sedang kamu pakai; jangan mengaku sebagai model Claude dan jangan menyebut dirimu Opus, Sonnet, atau Haiku. Bila ditanya model apa yang kamu pakai, jawab dengan nama model di atas.`;
}

/**
 * Catatan identitas model hanya perlu untuk provider kustom non-Claude.
 *
 * Sesi Claude asli (tanpa baseUrl kustom, atau model bernama `claude-*`)
 * tidak berubah sama sekali.
 */
function modelIdentityModel(provider: ResolvedProvider): string | undefined {
  const model = provider.model;
  if (model === undefined || model === "") return undefined;
  if (provider.baseUrl === undefined || provider.baseUrl === "") return undefined;
  if (model.toLowerCase().startsWith("claude")) return undefined;
  return model;
}

type SecretGuard = NonNullable<RunInput["secretGuard"]>;
type CommandEnv = NonNullable<RunInput["commandEnv"]>;

/**
 * Nama env yang tidak boleh disuntik dari berkas env perintah (dibandingkan
 * tanpa beda huruf besar-kecil). Mencegah berkas env menimpa PATH, memuat kode
 * lewat `LD_PRELOAD`/`BASH_ENV`, atau mengubah konfigurasi SDK.
 */
const COMMAND_ENV_DENIED_EXACT = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "PWD",
  "IFS",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

const COMMAND_ENV_DENIED_PREFIXES = ["LD_", "DYLD_", "ANTHROPIC_", "CLAUDE_", "JEJAK_"];

/**
 * Saring env perintah sebelum digabung ke env SDK: buang nama terlarang agar
 * berkas env pengguna tidak bisa menimpa/menyuntik variabel penting.
 */
export function filterCommandEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (env === undefined) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (COMMAND_ENV_DENIED_EXACT.has(upper)) continue;
    if (COMMAND_ENV_DENIED_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    result[name] = value;
  }
  return result;
}

/** Gabungkan env perintah yang lolos saringan ke env dasar (env dasar dulu). */
export function mergeCommandEnv(
  base: Record<string, string | undefined>,
  commandEnv: CommandEnv | undefined,
): Record<string, string | undefined> {
  const extra = filterCommandEnv(commandEnv?.env);
  if (Object.keys(extra).length === 0) return base;
  return { ...base, ...extra };
}

/**
 * Hook `PreToolUse`: menolak tool bila kebijakan rahasia mengembalikan alasan.
 */
function preToolUseHook(
  guard: SecretGuard | undefined,
): (input: unknown) => Promise<unknown> {
  return async (input: unknown): Promise<unknown> => {
    try {
      if (!isRecord(input) || input.hook_event_name !== "PreToolUse") return {};
      const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
      if (guard !== undefined) {
        const agentId =
          typeof input.agent_id === "string" && input.agent_id !== ""
            ? input.agent_id
            : undefined;
        const result = guard({ toolName, toolInput: input.tool_input, agentId });
        if (isRecord(result) && typeof result.reason === "string") {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: result.reason,
            },
          };
        }
      }
      return {};
    } catch {
      // Kebijakan tidak boleh membuat sesi macet.
      return {};
    }
  };
}

/** Ganti semua kemunculan nilai rahasia pada string; `undefined` bila tak berubah. */
function redactCommandEnvString(text: string, values: readonly string[]): string | undefined {
  let output = text;
  for (const value of values) {
    if (value === "") continue;
    if (!output.includes(value)) continue;
    output = output.split(value).join("[disembunyikan:env]");
  }
  return output === text ? undefined : output;
}

/** Telusuri `tool_response` rekursif; `undefined` bila tak ada yang berubah. */
function redactCommandEnvValue(
  value: unknown,
  values: readonly string[],
): { changed: boolean; value: unknown } {
  if (typeof value === "string") {
    const redacted = redactCommandEnvString(value, values);
    return redacted === undefined
      ? { changed: false, value }
      : { changed: true, value: redacted };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      const result = redactCommandEnvValue(item, values);
      if (result.changed) changed = true;
      return result.value;
    });
    return { changed, value: changed ? output : value };
  }
  if (isRecord(value)) {
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = redactCommandEnvValue(item, values);
      if (result.changed) changed = true;
      output[key] = result.value;
    }
    return { changed, value: changed ? output : value };
  }
  return { changed: false, value };
}

/**
 * Hook `PostToolUse`: menyamarkan nilai env perintah pada output tool sebelum
 * dikirim ke model. Hanya mengembalikan rewrite bila ada yang berubah.
 */
function postToolUseHook(
  commandEnv: CommandEnv,
): (input: unknown) => Promise<unknown> {
  const values = [...new Set(commandEnv.values)]
    .filter((value) => value !== "")
    .sort((left, right) => right.length - left.length);
  return async (input: unknown): Promise<unknown> => {
    try {
      if (!isRecord(input) || input.hook_event_name !== "PostToolUse") return {};
      if (values.length === 0) return {};
      const result = redactCommandEnvValue(input.tool_response, values);
      if (!result.changed) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: result.value,
        },
      };
    } catch {
      // Penyamaran gagal tidak boleh membuat sesi macet.
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

/**
 * Tool browser yang hanya membaca; otomatis diizinkan.
 *
 * Tool aksi browser (klik, ketik, navigasi, dan sejenisnya) sengaja tak ada
 * di sini: semuanya lewat modal izin yang sudah ada.
 */
const BROWSER_READ_TOOLS = new Set(["browser_tabs", "browser_snapshot", "browser_screenshot"]);

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
      } else if (BROWSER_READ_TOOLS.has(tool)) {
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

/**
 * Saran prompt berikutnya dari SDK.
 *
 * Mati lewat env `JEJAK_PROMPT_SUGGESTION=0`; nilai lain (termasuk kosong)
 * membiarkannya nyala.
 */
export function promptSuggestionsEnabled(env: Record<string, string | undefined>): boolean {
  return env.JEJAK_PROMPT_SUGGESTION?.trim() !== "0";
}

/**
 * Galat SDK karena opsi query tak dikenal (SDK lama tak kenal
 * `promptSuggestions`). Saran dilewati tanpa menggagalkan giliran.
 */
function isUnknownOptionError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  if (!message.includes("promptsuggestions")) return false;
  return (
    message.includes("unknown") ||
    message.includes("unrecognized") ||
    message.includes("invalid") ||
    message.includes("not supported")
  );
}

/**
 * Opsi sumber Claude untuk SDK.
 *
 * Dipakai bersama oleh giliran dan pembacaan daftar perintah supaya
 * keduanya melihat skill dan pengaturan yang sama.
 */
function applyClaudeOptions(
  sdkOptions: Record<string, unknown>,
  claude: RunClaudeConfig | undefined,
): void {
  if (claude === undefined) return;
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
  if (claude.plugins !== undefined && claude.plugins.length > 0) {
    sdkOptions.plugins = claude.plugins.map((path) => ({ type: "local", path }));
  }
}

/**
 * Teruskan CLI `claude` milik pengguna ke SDK bila sumbernya eksplisit
 * (env, pengaturan Jejak, atau CLI bawaan SDK yang terkelola) atau Jejak
 * berjalan sebagai binary terkompilasi. Di mode dev dengan auto-deteksi,
 * perilaku SDK dibiarkan.
 */
async function applyClaudeExecutable(
  sdkOptions: Record<string, unknown>,
  locate: () => Promise<ClaudeLocation | null>,
  now: () => number,
  cacheKey: string,
  isCompiled: () => boolean,
): Promise<void> {
  let location: ClaudeLocation | null = null;
  try {
    location = await cachedClaude(cacheKey, locate, now);
  } catch {
    location = null;
  }
  if (
    location !== null &&
    (location.source === "env" ||
      location.source === "setting" ||
      location.source === "managed" ||
      isCompiled())
  ) {
    sdkOptions.pathToClaudeCodeExecutable = location.path;
  }
}

/**
 * Prompt yang tak pernah menghasilkan apa pun.
 *
 * Dipakai saat membaca daftar perintah: model tak dipanggil, dan iterable
 * ini hanya menahan sesi tetap hidup sampai `close()` dipanggil.
 */
async function* promptDiam(): AsyncGenerator<never> {
  await new Promise<void>(() => {
    // Menunggu selamanya; sesi ditutup pemanggil.
  });
}

/** Batas waktu membaca daftar perintah; lewat itu sesi ditutup. */
const COMMAND_TIMEOUT_MS = 20_000;

/** Tolak proses yang tak selesai dalam batas waktu. */
async function denganBatasWaktu<T>(
  kerja: Promise<T>,
  ms: number,
  pesan: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      kerja,
      new Promise<never>((_, tolak) => {
        timer = setTimeout(() => tolak(new Error(pesan)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Petakan perintah SDK ke bentuk yang dipakai Jejak. */
function keCommandInfo(raw: SdkSlashCommand): CommandInfo {
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
  return {
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : "",
    argumentHint: typeof raw.argumentHint === "string" ? raw.argumentHint : "",
    ...(aliases.length > 0 ? { aliases } : {}),
  };
}

export function createSdkRunner(options: SdkRunnerOptions = {}): AgentRunner {
  const load = options.load ?? defaultLoad;
  const baseEnv = options.baseEnv ?? process.env;
  const locate =
    options.locateClaude ?? ((): Promise<ClaudeLocation | null> => defaultLocateClaude());
  const isCompiled = options.isCompiled ?? detectCompiled;
  const now = options.now ?? Date.now;
  const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  // Kunci cache unik per runner supaya dua runner di proses yang sama tidak saling menimpa.
  const cacheKey = nextClaudeCacheKey("runner");

  return {
    async *run(input: RunInput) {
      let sdk: SdkModule;
      try {
        sdk = requireSdkModule(await load());
      } catch (error) {
        const message = loadFailureMessage(error);
        yield { type: "error", message };
        yield { type: "result", ok: false, error: message };
        return;
      }

      // Jalur "Arahkan": prompt streaming supaya pesan susulan bisa masuk ke
      // giliran yang sedang berjalan. Tanpa `registerSteer`, perilaku lama
      // persis (prompt string).
      const registerSteer = input.registerSteer;
      const steerInput: SteerInput | undefined =
        registerSteer !== undefined ? createSteerInput(input.prompt) : undefined;
      const promptValue: string | AsyncIterable<SteerUserMessage> =
        steerInput !== undefined ? steerInput.iterable : input.prompt;

      const abortController = new AbortController();
      if (steerInput !== undefined) {
        // Sinyal batal menutup input supaya iterasi prompt selesai.
        abortController.signal.addEventListener(
          "abort",
          () => {
            steerInput.close();
          },
          { once: true },
        );
      }
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
      if (input.sandbox !== undefined) {
        append = `${append} ${SANDBOX_APPEND_NOTE}`;
      }
      // Tanpa `noTools` perilaku lama persis; dengan `noTools`, giliran ini
      // adalah pertanyaan sampingan yang tidak boleh memakai tool.
      const noTools = input.noTools === true;
      if (noTools) {
        append = `${append} ${ASIDE_APPEND_NOTE}`;
      }
      // Model non-Claude lewat provider kustom: tegaskan identitas model
      // supaya tidak salah mengaku sebagai Opus/Sonnet/Haiku.
      const identityModel = modelIdentityModel(input.provider);
      if (identityModel !== undefined) {
        append = `${append} ${modelIdentityNote(identityModel)}`;
      }
      // Mode plan: dokumen rencana ditulis penuh di ExitPlanMode, chat ringkas.
      if (input.permissionMode === "plan") {
        append = `${append} ${PLAN_MODE_APPEND_NOTE}`;
      }

      // SDK hanya memuat CLAUDE.md; AGENTS.md ditambahkan di sini bila perlu.
      const agentsNote = agentsMdNote(input.cwd);
      if (agentsNote !== undefined) {
        append = `${append}\n\n${agentsNote}`;
      }

      const sdkOptions: Record<string, unknown> = {
        cwd: input.cwd,
        env: withMaxRetries(
          mergeCommandEnv(buildSdkEnv(baseEnv, input.provider), input.commandEnv),
          input.maxRetries,
        ),
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

      // Saran prompt berikutnya: dikirim SDK setelah pesan `result`.
      const wantSuggestions = promptSuggestionsEnabled(baseEnv);
      if (wantSuggestions) {
        sdkOptions.promptSuggestions = true;
      }

      // Tanpa `claude` perilaku lama persis; dengan `claude`, sumber pengguna
      // opt-in dan saklar global hooks diteruskan ke SDK.
      applyClaudeOptions(sdkOptions, input.claude);
      const allowedTools = allowedToolsFor(input);
      const memoryServers: Record<string, unknown> = {};
      const hasMemoryServer =
        !noTools &&
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
      // Tanpa tool, server MCP memory maupun eksternal tidak dipasang.
      const external = noTools ? undefined : externalMcpServers(input.mcpServers);
      if (hasMemoryServer || external !== undefined) {
        sdkOptions.mcpServers = external === undefined
          ? memoryServers
          : { ...memoryServers, ...external };
      }
      if (hasMemoryServer) {
        sdkOptions.allowedTools = allowedTools;
      }
      if (noTools) {
        // Daftar kosong mematikan semua tool bawaan SDK.
        sdkOptions.tools = [];
      }
      if (input.provider.model !== undefined) {
        sdkOptions.model = input.provider.model;
      }
      if (input.resumeSessionId !== undefined) {
        sdkOptions.resume = input.resumeSessionId;
      }
      if (input.fork === true) {
        // Percakapan dicabang: sesi SDK baru, riwayat sesi asal tak berubah.
        sdkOptions.forkSession = true;
      }
      if (input.resumeAt !== undefined) {
        // Lanjutkan hanya sampai jangkar (uuid pesan assistant terakhir giliran itu).
        sdkOptions.resumeSessionAt = input.resumeAt;
      }
      const directories = [
        ...(workspace?.additionalDirectories ?? []),
        ...(input.extraDirectories ?? []),
      ];
      if (directories.length > 0) {
        sdkOptions.additionalDirectories = directories;
      }
      if (input.permissionMode === "bypassPermissions") {
        sdkOptions.allowDangerouslySkipPermissions = true;
      }

      // Tanpa `sandbox` perilaku lama persis; dengan `sandbox` opsi diteruskan apa adanya.
      if (input.sandbox !== undefined) {
        sdkOptions.sandbox = input.sandbox;
      }

      const secretGuard = input.secretGuard;
      const commandEnv = input.commandEnv;
      if (secretGuard !== undefined || commandEnv !== undefined) {
        const existingHooks = isRecord(sdkOptions.hooks) ? sdkOptions.hooks : {};
        const existingPre = existingHooks.PreToolUse;
        const ours = { hooks: [preToolUseHook(secretGuard)] };
        sdkOptions.hooks = {
          ...existingHooks,
          PreToolUse: Array.isArray(existingPre) ? [...existingPre, ours] : [ours],
        };
      }
      if (commandEnv !== undefined) {
        const existingHooks = isRecord(sdkOptions.hooks) ? sdkOptions.hooks : {};
        const existingPost = existingHooks.PostToolUse;
        const ours = { hooks: [postToolUseHook(commandEnv)] };
        sdkOptions.hooks = {
          ...existingHooks,
          PostToolUse: Array.isArray(existingPost) ? [...existingPost, ours] : [ours],
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

      // CLI `claude` milik pengguna diteruskan ke SDK bila sumbernya eksplisit
      // (env, pengaturan Jejak, atau CLI bawaan SDK yang terkelola) atau
      // Jejak berjalan sebagai binary terkompilasi. Di mode dev dengan
      // auto-deteksi, perilaku SDK dibiarkan.
      await applyClaudeExecutable(sdkOptions, locate, now, cacheKey, isCompiled);

      let query: SdkQuery | undefined;
      let sawResult = false;
      try {
        if (steerInput !== undefined) {
          // Fungsi steer didaftarkan sebelum iterasi: giliran yang sedang
          // berjalan menerima pesan susulan lewat sini.
          registerSteer?.(steerInput.steer);
        }
        try {
          query = sdk.query({ prompt: promptValue, options: sdkOptions });
        } catch (error) {
          // SDK lama tak mengenal opsi `promptSuggestions`: ulangi tanpa opsi itu.
          if (!wantSuggestions || !isUnknownOptionError(error)) throw error;
          delete sdkOptions.promptSuggestions;
          query = sdk.query({ prompt: promptValue, options: sdkOptions });
        }
        // Delta teks digabung ~50 ms agar tidak membanjiri SSE; event final menggantikannya.
        let pendingDelta = "";
        let pendingParent: string | undefined;
        let lastFlush = 0;
        let contextTokens: number | undefined;
        // Jangkar percakapan: uuid pesan assistant terakhir giliran ini.
        let anchorUuid: string | undefined;
        for await (const message of query) {
          const callContext = contextTokensOf(message);
          contextTokens = callContext ?? contextTokens;
          const messageUuid = assistantUuidOf(message);
          if (messageUuid !== undefined) anchorUuid = messageUuid;
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
              if (steerInput !== undefined) {
                const queued = queuedTurnCountOf(message);
                const pending = steerInput.pendingCount();
                if (queued > 0 || pending > 0) {
                  // Hasil perantara: giliran lanjutan masih jalan. Tak
                  // diteruskan supaya hasil giliran terakhir tak hilang.
                  continue;
                }
                // Hasil akhir: tutup input supaya iterasi prompt selesai.
                steerInput.close();
              }
              sawResult = true;
              // Jendela dari profil menang atas tebakan SDK (SDK memakai 200 rb untuk model non-Claude).
              const window = input.provider.contextWindow ?? contextWindowOf(message);
              if (window !== undefined) event.contextWindow = window;
              const reconciled = reconcileContextTokens(contextTokens, event, window);
              if (reconciled.tokens !== undefined) event.contextTokens = reconciled.tokens;
              if (reconciled.estimated) event.contextEstimated = true;
              // Jangkar hanya diisi bila runner memberi uuid (pesan assistant terakhir).
              if (anchorUuid !== undefined) event.anchorUuid = anchorUuid;
            }
            yield event;
          }
          if (callContext !== undefined) {
            // Angka per panggilan yang melewati jendela tak masuk akal; cincin
            // konteks lebih baik menunggu angka terkoreksi di hasil giliran.
            const window = input.provider.contextWindow;
            if (window === undefined || callContext <= window) {
              yield window === undefined
                ? { type: "context", tokens: callContext }
                : { type: "context", tokens: callContext, window };
            }
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
        if (steerInput !== undefined) {
          try {
            registerSteer?.(undefined);
          } catch {
            // Pembersihan tidak boleh menggagalkan giliran.
          }
          steerInput.close();
        }
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
    /**
     * Daftar perintah slash yang tersedia untuk satu folder kerja.
     *
     * Model tak dipanggil: SDK hanya diminta daftar perintahnya, lalu sesi
     * ditutup. Galat (SDK lama, timeout, kegagalan) dilempar ke pemanggil.
     */
    async listCommands(input: ListCommandsInput): Promise<CommandInfo[]> {
      const sdk = requireSdkModule(await load());
      const provider = input.provider ?? { profileId: "bawaan" };
      // Sinyal batal dipakai untuk menghentikan sesi SDK setelah daftar
      // perintah terbaca (prompt memang tak pernah menghasilkan apa pun).
      const abortController = new AbortController();
      const sdkOptions: Record<string, unknown> = {
        cwd: input.cwd,
        env: buildSdkEnv(baseEnv, provider),
        permissionMode: "default",
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        abortController,
      };
      applyClaudeOptions(sdkOptions, input.claude);
      if (provider.model !== undefined) sdkOptions.model = provider.model;
      await applyClaudeExecutable(sdkOptions, locate, now, cacheKey, isCompiled);

      const query = sdk.query({ prompt: promptDiam(), options: sdkOptions });
      try {
        const supported = query.supportedCommands;
        if (typeof supported !== "function") {
          throw new Error("SDK tak mendukung pembacaan daftar perintah.");
        }
        const raw = await denganBatasWaktu(
          Promise.resolve(supported.call(query)),
          commandTimeoutMs,
          "baca daftar perintah lewat batas waktu",
        );
        return raw.map(keCommandInfo);
      } finally {
        try {
          abortController.abort();
        } catch {
          // pembatalan tak boleh menggagalkan pembacaan perintah.
        }
        try {
          query.close?.();
        } catch {
          // close milik SDK tidak boleh menggagalkan pembacaan perintah.
        }
      }
    },
  };
}
