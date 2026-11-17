import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  PERMISSION_EXPIRED_MESSAGE,
  PERMISSION_INTERRUPTED_MESSAGE,
  PERMISSION_STOPPED_MESSAGE,
  type AgentEvent,
  type AgentRunner,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type ResolvedMcpServer,
  type RunClaudeConfig,
  type RunWorkspace,
} from "../agent";
import type { ModelPrice, ProviderSelection, ResolvedProvider } from "../provider";
import {
  classifyProviderError,
  describeFallbackReason,
} from "../agent/provider-error";
import type { AuditKind, AuditMeta, AuditStore } from "../audit/audit-store";
import type { ClaudeConfigStore } from "../claude-config/config-store";
import { enabledPluginPaths } from "../claude-config/plugins";
import { listSkills } from "../claude-config/skills";
import {
  evaluateBudget,
  formatUsd,
  localDayStartIso,
  type BudgetLevel,
} from "../budget/budget";
import type { BudgetStore } from "../budget/budget-store";
import type { UsageLedger } from "../budget/usage-ledger";
import {
  createGoal,
  decideNext,
  goalView,
  nextIdleTurns,
  parseGoalInput,
  parseStoredGoal,
  GoalInputError,
  type Goal,
  type GoalEndReason,
  type GoalInput,
  type GoalOutcome,
  type GoalReport,
  type GoalReportResult,
  type GoalReportedStatus,
  type GoalStatus,
  type GoalView,
} from "../goals/goal";
import { continuationPrompt, firstGoalPrompt } from "../goals/goal-prompts";
import type { MemoryBridge } from "../memory/memory-bridge";
import { estimateCostUsd } from "../pricing";
import { jejakHome as defaultJejakHome } from "../provider-store";
import {
  buildSandboxOptions,
  describeSandboxFailure,
  extractSandboxViolations,
  providerHostsFrom,
} from "../sandbox/build-options";
import type { SandboxMode, SandboxStore } from "../sandbox/sandbox-config";
import { redactSecrets } from "../security/redact";
import { redactEvent } from "../security/redact-event";
import { SECRET_BLOCK_REASON, checkSecretAccess, resolveSecretReadPath } from "../security/secret-paths";
import { redactEnvFileText } from "../security/env-redact";
import type { SecretAllowStore } from "../security/secret-allow-store";
import { readCommandEnv, type CommandEnvStore } from "../security/command-env-store";
import { WorktreeError, type WorktreeInfo, type WorktreeService } from "../git/worktree-service";
import type { SessionStore, StoredSession } from "./session-store";

export type SessionStatus = "berjalan" | "selesai" | "gagal" | "dibatalkan";

export type SessionPermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface SessionInfo {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  profileId: string;
  model?: string;
  permissionMode: SessionPermissionMode;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  pendingPermissions: number;
  queued: number;
  /**
   * Isi antrean pesan saat sesi berjalan; hanya ada bila antrean tak kosong.
   * Teks penuh (klien yang memotong tampilan). Pesan sistem tak ikut.
   */
  queuedMessages?: { id: string; text: string }[];
  workspaceId?: string;
  workspaceName?: string;
  /** Waktu sesi diarsipkan (ISO); tidak ada berarti tidak diarsipkan. */
  archivedAt?: string;
  /** Hanya dihitung saat `GET /api/sessions/:id`; tidak disimpan di store. */
  workspaceRepos?: Array<{ name: string; primary: boolean; missing: boolean }>;
  /** Worktree terisolasi sesi; `missing` dihitung saat dibaca, tidak disimpan. */
  worktree?: WorktreeInfo;
  /** Mode sandbox Bash sesi; disimpan saat pembuatan agar lencana konsisten. */
  sandbox?: SandboxMode;
  /** Hanya pada respons pembuatan sesi (bila worktree dibuat); tidak disimpan. */
  dirtyInSource?: boolean;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCostUsd?: number; sdkCostUsd?: number };
  /** Tingkat anggaran terakhir; tidak ada bila tidak ada batas yang berlaku. */
  budget?: { session?: BudgetLevel; day?: BudgetLevel };
  /** Jumlah event yang mengandung rahasia; tidak ada bila 0. */
  redactedEvents?: number;
  /**
   * Target mundur percakapan yang masih menunggu giliran berikutnya:
   * jangkar (uuid pesan assistant) dan sesi SDK asal. Disimpan di baris sesi
   * agar restart server tidak melanjutkan riwayat penuh.
   */
  rewindTo?: { uuid: string; sdkSessionId: string };
  /**
   * Tujuan mode Goal; bentuk ringkas (tujuan dipotong 200 karakter, tanpa
   * field internal seperti `startCostUsd`).
   */
  goal?: GoalView;
  /**
   * Sesi bisa dilanjutkan setelah aplikasi berhenti mendadak: sesi tak
   * berjalan dan punya riwayat SDK. Dihitung saat dibaca, tidak disimpan.
   */
  canContinue?: boolean;
}

export interface SequencedEvent {
  seq: number;
  event: AgentEvent;
}

/**
 * Satu entri antrean pesan. Id dipakai agar pesan bisa dihapus atau
 * dikirim sekarang tanpa ikut terhapus pesan lain (indeks bergeser).
 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Pesan sistem (mis. lanjutan ganti sandbox); tak tampil di daftar klien. */
  hidden?: boolean;
}

export interface CreateSessionInput {
  prompt: string;
  /** Wajib kecuali `workspaceId` diberikan; saat itu default-nya repo utama. */
  cwd?: string;
  title?: string;
  selection?: ProviderSelection;
  permissionMode?: string;
  /** Wajib `true` untuk `permissionMode: "bypassPermissions"`; tidak disimpan di info. */
  confirmBypass?: boolean;
  workspaceId?: string;
  /** `true` -> sesi memakai worktree terisolasi pada cabang baru. */
  worktree?: boolean;
  /** Mode sandbox per sesi; default dari pengaturan global saat pembuatan. */
  sandbox?: SandboxMode;
}

export interface WorkspaceResolverRepo {
  name: string;
  path: string;
  kind: string;
  missing: boolean;
}

export interface WorkspaceResolverView {
  id: string;
  name: string;
  repos: WorkspaceResolverRepo[];
}

/** Antarmuka sempit ke layanan workspace; implementasi boleh adaptor di `index.ts`. */
export interface WorkspaceResolver {
  get(id: string): Promise<WorkspaceResolverView | undefined>;
}

export interface SessionManagerCheckpoints {
  create(
    sessionId: string,
    cwd: string,
    input: { kind: "turn"; turn: number },
  ): Promise<unknown>;
  remove(sessionId: string): Promise<void> | void;
}

/** Antarmuka sempit ke layanan server MCP; `McpServerService` memenuhinya. */
export interface McpServerResolver {
  resolved(): Promise<ResolvedMcpServer[]>;
}

export interface SessionManagerOptions {
  runner: AgentRunner;
  resolveProvider: (selection: ProviderSelection) => Promise<ResolvedProvider>;
  /**
   * Profil cadangan untuk satu kali percobaan ulang bila giliran gagal oleh
   * galat provider sebelum output substantif; `undefined` berarti tak ada.
   */
  fallback?: (profileId: string) => Promise<ResolvedProvider | undefined>;
  maxConcurrent?: number;
  maxSessions?: number;
  maxEventsPerSession?: number;
  maxPromptLength?: number;
  now?: () => Date;
  permissionTimeoutMs?: number;
  /**
   * Batas menunggu saran prompt setelah pesan `result` (ms); bawaan 15 detik.
   * Lewat batas giliran selesai dan stream dihentikan.
   */
  suggestionWaitMs?: number;
  store?: SessionStore;
  memoryBridge?: MemoryBridge;
  /**
   * Dipanggil setelah giliran selesai dengan sukses (mis. ringkasan memory otomatis).
   * Galat ditelan; tidak pernah menahan sesi.
   */
  onTurnEnd?: (input: {
    sessionId: string;
    title: string;
    cwd: string;
    events: AgentEvent[];
  }) => Promise<void>;
  checkpoints?: SessionManagerCheckpoints;
  workspaces?: WorkspaceResolver;
  /** Server MCP eksternal; dibaca ulang tiap giliran. */
  mcpServers?: McpServerResolver;
  /** Layanan worktree; tanpa opsi ini `worktree: true` ditolak. */
  worktrees?: WorktreeService;
  /** Default `true`; `false` menolak semua sesi bermode bypass. */
  allowBypass?: boolean;
  /** Folder tambahan untuk dibaca agent di setiap giliran (mis. lampiran). */
  extraDirectories?: string[];
  /** Dipanggil setelah sesi dibuang (hapus manual maupun eviksi). Galatnya ditelan. */
  onSessionDeleted?: (id: string) => void | Promise<void>;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan audit. */
  audit?: AuditStore;
  /** Pengaturan sumber Claude; tanpa store `input.claude` tidak diisi. */
  claude?: ClaudeConfigStore;
  /** Sandbox Bash; tanpa store `input.sandbox` tidak diisi. */
  sandbox?: { store: SandboxStore; home?: string };
  /** Berkas `.env` per proyek untuk env perintah Bash; tanpa store fitur mati. */
  commandEnv?: CommandEnvStore;
  /** Direktori home pengguna untuk skills `~/.claude`; default `os.homedir()`. */
  home?: string;
  /** Anggaran peringatan; tanpa store fitur dimatikan. */
  budget?: { ledger?: UsageLedger; store: BudgetStore };
  /** Kebijakan penyamaran rahasia pada event sesi. */
  secrets?: {
    mode?: "off" | "warn" | "redact";
    /** Nilai literal rahasia untuk cwd sesi (mis. isi .env); dipanggil sekali per sesi. */
    loadEnvValues?: (cwd: string) => readonly string[];
    /** Tolak akses tool ke berkas rahasia; default `true` kecuali mode `off`. */
    blockPaths?: boolean;
    /** Daftar izin eksplisit per proyek; tanpa opsi ini semua jalur rahasia diblokir. */
    allow?: SecretAllowStore;
  };
}

export class SessionError extends Error {
  /** Angka pendukung penolakan worktree (dipakai rute DELETE). */
  readonly dirtyFiles?: number;
  readonly commitsAhead?: number;

  constructor(
    message: string,
    public readonly code: "tidak-valid" | "tidak-ditemukan" | "penuh" | "konflik",
    numbers: { dirtyFiles?: number; commitsAhead?: number } = {},
  ) {
    super(message);
    this.name = "SessionError";
    if (numbers.dirtyFiles !== undefined) this.dirtyFiles = numbers.dirtyFiles;
    if (numbers.commitsAhead !== undefined) this.commitsAhead = numbers.commitsAhead;
  }
}

interface Pending {
  resolve: (value: PermissionDecision) => void;
  name: string;
  input?: unknown;
}

interface SessionRecord {
  info: SessionInfo;
  apiKey?: string;
  controller: AbortController;
  buffer: SequencedEvent[];
  nextSeq: number;
  version: number;
  listeners: Set<() => void>;
  done: Promise<void>;
  settle: () => void;
  pending: Map<string, Pending>;
  permissionTimeoutMs: number;
  price?: ModelPrice;
  resolved?: ResolvedProvider;
  sdkSessionId?: string;
  /**
   * Jangkar mundur percakapan yang menunggu giliran berikutnya; hilang setelah
   * giliran itu memakai jangkar tersebut.
   */
  rewindTo?: { uuid: string; sdkSessionId: string };
  queue: QueuedMessage[];
  /**
   * Giliran yang berjalan harus dihentikan lalu dilanjutkan dengan pesan
   * antrean teratas (dikirim lewat "Kirim sekarang" atau ganti sandbox).
   */
  sendNowPending?: boolean;
  /**
   * Fungsi "Arahkan" untuk giliran yang sedang berjalan: menerima pesan
   * antrean lalu menyusunkannya ke giliran itu tanpa membatalkannya.
   * Hilang saat giliran berakhir.
   */
  steer?: (text: string) => boolean;
  /** Jumlah giliran yang sudah dimulai; giliran pertama = 1. */
  turns: number;
  /**
   * Giliran masih berjalan di sisi runner.
   *
   * Status sesi berubah ke "selesai" begitu pesan `result` masuk, tetapi
   * stream SDK masih membuka jalan untuk saran prompt. Selama flag ini aktif,
   * aliran SSE tetap dibuka dan pesan baru masuk antrean (tak memulai giliran
   * kedua).
   */
  turnActive?: boolean;
  /**
   * Penantian saran dipotong oleh pesan yang masuk: giliran selesai tapi
   * stream masih menunggu saran, lalu pengguna mengirim pesan baru.
   */
  suggestionCut?: boolean;
  /**
   * Tujuan sesi (isi penuh; yang dikirim ke klien adalah bentuk ringkas).
   * Disimpan di kolom data JSON baris sesi, seperti `rewindTo`.
   */
  goal?: Goal;
  /** Status giliran yang sedang berjalan (dilewati bila tidak ada giliran). */
  turn?: SessionTurn;
  /** Peringatan workspace tak tersedia hanya sekali per sesi. */
  workspaceWarned?: boolean;
  /** Nilai rahasia dari `.env` sesi; dimuat malas dan tidak dipersist. */
  envValues?: readonly string[];
  /** Nilai env perintah giliran berjalan; ikut disamarkan di riwayat. */
  commandEnvValues?: readonly string[];
  /** Penyalur event yang tertahan sebelum output substantif (mode fallback). */
  flushPending?: () => void;
  /** Kunci tambahan yang ikut disanitasi dari event (kunci profil asal saat fallback). */
  extraApiKeys?: readonly string[];
}

/** Status giliran yang sedang berjalan; dipakai loop Goal. */
interface SessionTurn {
  /** Giliran otomatis (loop Goal), bukan pesan pengguna. */
  auto: boolean;
  /** Jumlah tool call pada giliran ini. */
  toolCalls: number;
  /** Status terakhir yang dilaporkan agent lewat `goal_update`. */
  reportedStatus?: GoalReportedStatus;
  /** Ringkasan terakhir yang dilaporkan agent. */
  summary?: string;
}

/** Kegagalan satu percobaan giliran; event tertahan dipakai bila tanpa fallback. */
interface AttemptFailure {
  message: string;
  /** Event yang tertahan sebelum output substantif (termasuk `result` gagal). */
  events: AgentEvent[];
  /** Apakah `events` sudah memuat `result` gagal. */
  hasResult: boolean;
  /** Kegagalan karena stream habis/exception, bukan event `result` lengkap. */
  synthetic: boolean;
  /** Sudah ada output substantif? Bila ya, fallback tidak berlaku. */
  substantive: boolean;
}

type AttemptOutcome =
  | { kind: "selesai" }
  | { kind: "gagal"; failure: AttemptFailure };

/** Retry API di SDK bila ada profil cadangan (bawaan SDK sampai 10 dengan backoff). */
const FALLBACK_SDK_RETRIES = 2;

const CHECKPOINT_TIMEOUT_MS = 30_000;

/** Batas waktu satu pertanyaan sampingan (`/btw`). */
const ASIDE_TIMEOUT_MS = 120_000;

const MAX_QUEUED_MESSAGES = 5;

/**
 * Batas menunggu saran prompt setelah pesan `result`. Lewat batas giliran
 * dianggap selesai: stream dihentikan agar tak menahan sesi.
 */
const SUGGESTION_WAIT_MS = 15_000;

/** Tool penyunting berkas yang disetujui otomatis pada mode acceptEdits. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Galat yang ditambahkan saat pemulihan sesi yang masih berjalan. */
const RECOVERY_ERROR_MESSAGE = "server dimulai ulang saat sesi berjalan";

/** Pesan lanjutan untuk sesi yang terputus karena aplikasi berhenti. */
const CONTINUE_MESSAGE =
  "Sesi sempat terputus karena aplikasi berhenti. Lanjutkan pekerjaan terakhirmu dari titik tadi dan minta izin lagi bila perlu.";

/**
 * Pesan lanjutan otomatis setelah mode sandbox diganti saat giliran
 * berjalan: giliran yang berjalan dihentikan, lalu pekerjaan dilanjutkan
 * dengan mode baru.
 */
function sandboxContinueMessage(mode: SandboxMode): string {
  return `Mode sandbox diganti pengguna menjadi ${mode}. Lanjutkan pekerjaan terakhirmu dari titik tadi; ulangi perintah yang tadi terhenti bila perlu.`;
}

/** Label Bahasa Indonesia untuk alasan berakhir/berjeda tujuan. */
const GOAL_REASON_LABEL: Record<GoalEndReason, string> = {
  selesai: "tujuan tercapai",
  buntu: "tujuan buntu",
  "plafon-giliran": "batas giliran otomatis tercapai",
  "plafon-biaya": "plafon biaya tercapai",
  "anggaran-sesi": "anggaran sesi terlampaui",
  "tanpa-kemajuan": "tidak ada kemajuan",
  gagal: "giliran gagal",
  dihentikan: "dihentikan",
};

const PERMISSION_MODES: readonly SessionPermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

const DEFAULTS = {
  maxConcurrent: 4,
  maxSessions: 100,
  maxEventsPerSession: 5000,
  maxPromptLength: 20000,
  permissionTimeoutMs: 600_000,
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeText(text: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === "") {
    return text;
  }
  return text.split(apiKey).join("***");
}

function sanitizeValue(value: unknown, apiKey: string | undefined): unknown {
  if (typeof value === "string") {
    return sanitizeText(value, apiKey);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, apiKey));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sanitizeValue(item, apiKey);
    }
    return result;
  }
  return value;
}

function sanitizeEvent(event: AgentEvent, apiKey: string | undefined): AgentEvent {
  return sanitizeValue(event, apiKey) as AgentEvent;
}

/** Satu event melewati daftar kunci (dipakai saat fallback: kunci asal + cadangan). */
function sanitizeEventKeys(event: AgentEvent, apiKeys: readonly (string | undefined)[]): AgentEvent {
  let result = event;
  for (const key of apiKeys) {
    if (key !== undefined && key !== "") result = sanitizeEvent(result, key);
  }
  return result;
}

function sanitizeTextKeys(text: string, apiKeys: readonly (string | undefined)[]): string {
  let result = text;
  for (const key of apiKeys) {
    if (key !== undefined && key !== "") result = sanitizeText(result, key);
  }
  return result;
}

/** Teks galat sintetis dari SDK (mis. koneksi ditolak), bukan keluaran model. */
function isSdkApiErrorText(text: string): boolean {
  return /^\s*API Error\b/i.test(text);
}

function isSubstantiveEvent(event: AgentEvent): boolean {
  return (
    event.type === "text" ||
    event.type === "text_delta" ||
    event.type === "thinking" ||
    event.type === "tool_call" ||
    event.type === "permission_request"
  );
}

/**
 * Event transien: disiarkan ke pelanggan, tapi tidak disimpan ke DB dan tidak
 * dihitung sebagai event percakapan (tak bisa dimundurkan).
 *
 * `text_delta` digantikan teks final; `suggestion` (saran prompt berikutnya)
 * hanya relevan di layar terakhir.
 */
function isTransientEvent(event: AgentEvent): boolean {
  return event.type === "text_delta" || event.type === "suggestion";
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export type SessionSecretsMode = "off" | "warn" | "redact";

const SECRETS_MODES: readonly SessionSecretsMode[] = ["off", "warn", "redact"];

/** Ringkasan input tool untuk audit: nilai string pertama dari kunci yang dikenal. */
const TOOL_SUMMARY_KEYS = [
  "file_path",
  "path",
  "notebook_path",
  "pattern",
  "command",
  "url",
  "query",
  "description",
] as const;

function toolSummary(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  for (const key of TOOL_SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string") {
      return collapseWhitespace(value).slice(0, 200);
    }
  }
  return "";
}

function describeHits(hits: ReadonlyArray<{ kind: string; count: number }>): string {
  return hits.map((hit) => `${hit.kind}×${hit.count}`).join(", ");
}

const BUDGET_RANK: Record<BudgetLevel, number> = { ok: 0, warn: 1, over: 2 };

/** Kenaikan tingkat: ok→warn, ok/warn→over. Tingkat sebelumnya kosong = ok. */
function isBudgetRise(previous: BudgetLevel | undefined, next: BudgetLevel): boolean {
  return BUDGET_RANK[next] > BUDGET_RANK[previous ?? "ok"];
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function waitForChange(
  record: SessionRecord,
  version: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (record.version !== version || isAborted(signal)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      record.listeners.delete(finish);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    record.listeners.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export class SessionManager {
  private readonly runner: AgentRunner;
  private readonly resolveProvider: (selection: ProviderSelection) => Promise<ResolvedProvider>;
  private readonly fallback: ((profileId: string) => Promise<ResolvedProvider | undefined>) | undefined;
  private readonly maxConcurrent: number;
  private readonly maxSessions: number;
  private readonly maxEventsPerSession: number;
  private readonly maxPromptLength: number;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly permissionTimeoutMs: number;
  private readonly suggestionWaitMs: number;
  private readonly store: SessionStore | undefined;
  private readonly memoryBridge: MemoryBridge | undefined;
  private readonly onTurnEnd: SessionManagerOptions["onTurnEnd"];
  private readonly checkpoints: SessionManagerCheckpoints | undefined;
  private readonly workspaces: WorkspaceResolver | undefined;
  private readonly mcpServers: McpServerResolver | undefined;
  private readonly worktrees: WorktreeService | undefined;
  private readonly allowBypass: boolean;
  private readonly extraDirectories: string[];
  private readonly onSessionDeleted: ((id: string) => void | Promise<void>) | undefined;
  private readonly auditStore: AuditStore | undefined;
  private readonly claudeConfig: ClaudeConfigStore | undefined;
  private readonly sandboxStore: SandboxStore | undefined;
  private readonly sandboxHome: string | undefined;
  private readonly home: string | undefined;
  private readonly budgetLedger: UsageLedger | undefined;
  private readonly budgetStore: BudgetStore | undefined;
  /**
   * Tingkat harian di memori, direset saat hari lokal berganti. Setelah restart
   * server, state ini kosong sehingga satu peringatan harian boleh muncul ulang.
   */
  private budgetDay: { key: string; level?: BudgetLevel } | undefined;
  private readonly secretsMode: SessionSecretsMode;
  private readonly loadEnvValues: ((cwd: string) => readonly string[]) | undefined;
  private readonly blockSecretPaths: boolean;
  private readonly secretAllow: SecretAllowStore | undefined;
  private readonly commandEnvStore: CommandEnvStore | undefined;
  private commandEnvWarned = false;
  private storeWarned = false;
  private memoryWarned = false;
  private checkpointWarned = false;
  private mcpServersWarned = false;
  private deleteHookWarned = false;

  constructor(options: SessionManagerOptions) {
    this.runner = options.runner;
    this.resolveProvider = options.resolveProvider;
    this.fallback = options.fallback;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrent;
    this.maxSessions = options.maxSessions ?? DEFAULTS.maxSessions;
    this.maxEventsPerSession = options.maxEventsPerSession ?? DEFAULTS.maxEventsPerSession;
    this.maxPromptLength = options.maxPromptLength ?? DEFAULTS.maxPromptLength;
    this.now = options.now ?? (() => new Date());
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULTS.permissionTimeoutMs;
    this.suggestionWaitMs = options.suggestionWaitMs ?? SUGGESTION_WAIT_MS;
    this.store = options.store;
    this.memoryBridge = options.memoryBridge;
    this.onTurnEnd = options.onTurnEnd;
    this.checkpoints = options.checkpoints;
    this.workspaces = options.workspaces;
    this.mcpServers = options.mcpServers;
    this.worktrees = options.worktrees;
    this.allowBypass = options.allowBypass ?? true;
    this.extraDirectories = options.extraDirectories ?? [];
    this.onSessionDeleted = options.onSessionDeleted;
    this.auditStore = options.audit;
    this.claudeConfig = options.claude;
    this.sandboxStore = options.sandbox?.store;
    this.sandboxHome = options.sandbox?.home;
    this.home = options.home;
    this.budgetLedger = options.budget?.ledger;
    this.budgetStore = options.budget?.store;
    const requestedMode = options.secrets?.mode;
    this.secretsMode =
      requestedMode !== undefined && SECRETS_MODES.includes(requestedMode)
        ? requestedMode
        : "redact";
    this.loadEnvValues = options.secrets?.loadEnvValues;
    this.blockSecretPaths =
      this.secretsMode !== "off" && options.secrets?.blockPaths !== false;
    this.secretAllow = options.secrets?.allow;
    this.commandEnvStore = options.commandEnv;
    if (this.store !== undefined) {
      this.restore();
    }
  }

  private storeGuard(action: () => void): void {
    if (this.store === undefined) return;
    try {
      action();
    } catch (error) {
      if (!this.storeWarned) {
        this.storeWarned = true;
        console.warn(`Penyimpanan sesi gagal: ${errorMessage(error)}`);
      }
    }
  }

  private persistSession(record: SessionRecord): void {
    const info = { ...record.info };
    // Target mundur ikut tersimpan di baris sesi (kolom data), seperti field
    // opsional lain; restart server tidak boleh melanjutkan riwayat penuh.
    if (record.rewindTo === undefined) delete info.rewindTo;
    else info.rewindTo = record.rewindTo;
    // Tujuan ikut tersimpan penuh di kolom data; yang dikirim ke klien tetap
    // bentuk ringkas lewat `viewInfo`. Tujuan disamarkan seperti prompt sesi
    // agar rahasia tidak masuk penyimpanan.
    if (record.goal === undefined) delete info.goal;
    else info.goal = { ...record.goal, objective: this.redactText(record.goal.objective) };
    const sdkSessionId = record.sdkSessionId;
    this.storeGuard(() => this.store?.saveSession(info, sdkSessionId));
  }

  /** Satu-satunya pintu catatan audit; tidak pernah melempar dan no-op tanpa store. */
  private audit(
    kind: AuditKind,
    summary: string,
    sessionId: string,
    meta?: AuditMeta,
  ): void {
    const store = this.auditStore;
    if (store === undefined) return;
    try {
      store.append({ kind, summary, sessionId, meta });
    } catch {
      // Audit tidak boleh merusak sesi.
    }
  }

  /**
   * Baca isi `.env` untuk ditampilkan tersamar; `undefined` bila tak ada,
   * gagal dibaca, atau lebih dari 64 KB.
   */
  private readEnvForDisplay(absPath: string): string | undefined {
    try {
      const info = statSync(absPath);
      if (!info.isFile() || info.size > 64 * 1024) return undefined;
      return readFileSync(absPath, "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * Evaluasi anggaran setelah satu `result`. Tidak pernah menghentikan sesi;
   * seluruh galat ditelan agar anggaran tidak menggagalkan giliran.
   */
  private applyBudget(
    record: SessionRecord,
    event: Extract<AgentEvent, { type: "result" }>,
  ): void {
    const store = this.budgetStore;
    if (store === undefined) return;
    try {
      const ledger = this.budgetLedger;
      const cost = event.estimatedCostUsd;
      if (
        ledger !== undefined &&
        typeof cost === "number" &&
        Number.isFinite(cost) &&
        cost > 0
      ) {
        ledger.record({
          ts: this.now().toISOString(),
          sessionId: record.info.id,
          profileId: record.info.profileId,
          ...(record.info.model === undefined ? {} : { model: record.info.model }),
          costUsd: cost,
          ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
          ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
        });
      }

      const config = store.get();
      const sessionUsd =
        ledger !== undefined
          ? ledger.sumForSession(record.info.id)
          : (record.info.usage?.estimatedCostUsd ?? 0);
      const dayStart = localDayStartIso(this.now());
      const dayUsd = ledger !== undefined ? ledger.sumSince(dayStart) : 0;
      const levels = evaluateBudget({ config, sessionUsd, dayUsd });

      const previousSession = record.info.budget?.session;
      const previousDay =
        this.budgetDay?.key === dayStart ? this.budgetDay.level : undefined;

      if (levels.session === undefined && levels.day === undefined) {
        delete record.info.budget;
      } else {
        record.info.budget = levels;
      }
      this.budgetDay = { key: dayStart, level: levels.day };

      this.maybeBudgetNotice(
        record,
        "sesi",
        previousSession,
        levels.session,
        config.sessionUsd,
        config.warnAt,
        sessionUsd,
      );
      this.maybeBudgetNotice(
        record,
        "hari",
        previousDay,
        levels.day,
        config.dailyUsd,
        config.warnAt,
        dayUsd,
      );
    } catch {
      // Galat anggaran tidak boleh menggagalkan sesi.
    }
  }

  /** Satu notice + satu audit per kenaikan tingkat untuk satu cakupan. */
  private maybeBudgetNotice(
    record: SessionRecord,
    scope: "sesi" | "hari",
    previous: BudgetLevel | undefined,
    next: BudgetLevel | undefined,
    limit: number | undefined,
    warnAt: number,
    spent: number,
  ): void {
    if (next === undefined || limit === undefined || !isBudgetRise(previous, next)) return;
    const percent = Math.round(warnAt * 100);
    const text =
      next === "warn"
        ? `Anggaran ${scope} ${percent}% terpakai (${formatUsd(spent)} dari ${formatUsd(limit)}).`
        : `Anggaran ${scope} terlewati (${formatUsd(spent)} dari ${formatUsd(limit)}). Sesi tidak dihentikan.`;
    this.append(record, { type: "notice", text, level: "warn" });
    const summary =
      next === "warn"
        ? `Anggaran ${scope} ${percent}% terpakai`
        : `Anggaran ${scope} terlewati. Sesi tidak dihentikan.`;
    this.audit("anggaran", summary, record.info.id, {
      cakupan: scope,
      tingkat: next,
      batas: limit,
    });
  }

  /** cwd yang sama dengan pembukaan memory: repo asli + subdir untuk sesi worktree. */
  private cwdForMemory(record: SessionRecord): string {
    const worktree = record.info.worktree;
    return worktree === undefined
      ? record.info.cwd
      : join(worktree.repoRoot, worktree.subdir ?? "");
  }

  /**
   * Pengaturan sumber Claude per giliran. Galat apa pun ditelan agar sesi
   * berjalan tanpa konfigurasi tambahan; `input.claude` hanya diisi bila ada store.
   */
  private claudeForRun(record: SessionRecord): RunClaudeConfig | undefined {
    return this.claudeForCwd(this.cwdForMemory(record));
  }

  /**
   * Pengaturan sumber Claude untuk satu folder kerja.
   *
   * Dipakai juga di luar giliran (mis. daftar perintah) supaya hasilnya
   * sama: sumber pengguna dan skill aktif dibaca dengan cara yang sama.
   */
  private claudeForCwd(cwd: string): RunClaudeConfig | undefined {
    const store = this.claudeConfig;
    if (store === undefined) return undefined;
    try {
      const config = store.get();
      const disabled = store.disabledFor(cwd);
      const result: RunClaudeConfig = {
        userSettings: config.userSettings,
        hooksEnabled: config.hooksEnabled,
      };
      const pluginPaths = enabledPluginPaths(this.home, config.enabledPlugins).map(
        (plugin) => plugin.path,
      );
      if (pluginPaths.length > 0) result.plugins = pluginPaths;
      if (disabled.length > 0) {
        const found = listSkills(cwd, this.home, disabled);
        const names = new Set<string>();
        for (const skill of found) {
          if (skill.scope === "user" && !config.userSettings) continue;
          if (!skill.enabled) continue;
          names.add(skill.name);
        }
        result.skills = Array.from(names).sort();
      }
      return result;
    } catch {
      return undefined;
    }
  }

  /**
   * Konteks perintah untuk satu folder kerja.
   *
   * Mengembalikan pengaturan Claude yang sama dengan saat giliran
   * dijalankan, tanpa membuat sesi.
   */
  commandContext(cwd: string): { claude?: RunClaudeConfig } {
    const claude = this.claudeForCwd(cwd);
    return claude === undefined ? {} : { claude };
  }

  /**
   * Opsi sandbox untuk satu giliran. Mode efektif: pilihan sesi, lalu default
   * global. Galat TIDAK ditelan: pemanggil menggagalkan giliran secara tertutup
   * kecuali mode `mati`.
   */
  private sandboxForRun(
    record: SessionRecord,
    provider: ResolvedProvider,
    workspace: RunWorkspace | undefined,
    fallbackProvider?: ResolvedProvider,
  ): Record<string, unknown> | undefined {
    const store = this.sandboxStore;
    if (store === undefined) return undefined;

    const config = store.get();
    const mode: SandboxMode = record.info.sandbox ?? config.mode;
    const home = this.sandboxHome ?? homedir();

    const projectRoots: string[] = [];
    const worktree = record.info.worktree;
    if (worktree === undefined) {
      projectRoots.push(record.info.cwd);
    } else {
      projectRoots.push(worktree.path);
      projectRoots.push(worktree.repoRoot);
    }

    const extraWriteDirs: string[] = [];
    if (worktree !== undefined) {
      extraWriteDirs.push(worktree.repoRoot);
    }
    if (workspace !== undefined) {
      for (const repo of workspace.repos) {
        extraWriteDirs.push(repo.path);
      }
      for (const dir of workspace.additionalDirectories) {
        extraWriteDirs.push(dir);
      }
    }

    return buildSandboxOptions({
      mode,
      config,
      home,
      jejakHome: defaultJejakHome(),
      projectRoots,
      extraWriteDirs,
      providerHosts: [
        ...providerHostsFrom(provider.baseUrl),
        ...providerHostsFrom(fallbackProvider?.baseUrl),
      ],
    });
  }

  /** Nilai rahasia untuk sesi; dimuat malas sekali dan tidak pernah melempar. */
  private envValuesFor(record: SessionRecord): readonly string[] {
    if (record.envValues !== undefined) return record.envValues;
    let values: readonly string[] = [];
    const loader = this.loadEnvValues;
    if (loader !== undefined) {
      try {
        values = loader(this.cwdForMemory(record));
      } catch {
        values = [];
      }
    }
    record.envValues = values;
    return values;
  }

  /**
   * Env perintah untuk satu giliran: berkas `.env` yang ditunjuk pengguna untuk
   * akar proyek sesi. Galat baca tidak menggagalkan giliran; peringatan dicatat
   * sekali per sesi.
   */
  private commandEnvForRun(
    record: SessionRecord,
  ): { file: string; values: string[]; keys: string[] } | undefined {
    const store = this.commandEnvStore;
    if (store === undefined) return undefined;
    let file: string | undefined;
    try {
      file = store.get(this.cwdForMemory(record));
    } catch {
      return undefined;
    }
    if (file === undefined) return undefined;
    try {
      const parsed = readCommandEnv(file);
      record.commandEnvValues = parsed.values;
      return { file, values: parsed.values, keys: parsed.keys };
    } catch {
      if (!this.commandEnvWarned) {
        this.commandEnvWarned = true;
        this.append(record, {
          type: "error",
          message: "Berkas env perintah tidak bisa dibaca; giliran berjalan tanpa env tersebut.",
        });
      }
      return undefined;
    }
  }

  /** Samarkan teks untuk tampilan (`info`); mode warn/off tidak mengubah apa pun. */
  private redactText(text: string): string {
    if (this.secretsMode !== "redact") return text;
    try {
      return redactSecrets(text).text;
    } catch {
      return text;
    }
  }

  private restore(): void {
    const store = this.store;
    if (store === undefined) return;

    let stored: StoredSession[];
    try {
      stored = store.loadSessions();
    } catch (error) {
      this.storeWarned = true;
      console.warn(`Penyimpanan sesi gagal dimuat: ${errorMessage(error)}`);
      return;
    }

    for (const item of stored) {
      let buffer: SequencedEvent[] = [];
      let loaded: SequencedEvent[] = [];
      try {
        loaded = store.loadEvents(item.info.id);
        buffer = loaded.slice(-this.maxEventsPerSession);
      } catch (error) {
        if (!this.storeWarned) {
          this.storeWarned = true;
          console.warn(`Penyimpanan sesi gagal: ${errorMessage(error)}`);
        }
      }

      const lastSeq = buffer.reduce((max, event) => Math.max(max, event.seq), 0);
      const nextSeq = Math.max(item.nextSeq, lastSeq + 1);

      let settle: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });

      const record: SessionRecord = {
        info: { ...item.info, queued: 0, pendingPermissions: 0 },
        controller: new AbortController(),
        buffer,
        nextSeq,
        version: 0,
        listeners: new Set(),
        done,
        settle,
        pending: new Map(),
        permissionTimeoutMs: this.permissionTimeoutMs,
        queue: [],
        turns: this.countTurns(buffer),
      };
      if (item.sdkSessionId !== undefined) {
        record.sdkSessionId = item.sdkSessionId;
      }
      // Target mundur yang masih menunggu tetap berlaku setelah restart.
      if (item.info.rewindTo !== undefined) {
        record.rewindTo = { ...item.info.rewindTo };
      }
      // Tujuan aktif tidak pernah dilanjutkan otomatis setelah restart:
      // dipulihkan sebagai `paused` supaya pengguna menekan Lanjut sendiri.
      const storedGoal = parseStoredGoal(item.info.goal);
      if (storedGoal !== undefined) {
        record.goal = storedGoal;
        if (storedGoal.status === "active") {
          storedGoal.status = "paused";
          storedGoal.endedReason = "dihentikan";
          storedGoal.updatedAt = this.now().toISOString();
          this.persistSession(record);
        }
      }
      this.sessions.set(record.info.id, record);

      // Izin yang menggantung ditutup lebih dulu supaya UI tak menampilkan
      // hitung mundur untuk sesi yang sudah mati. Penutupan ini berlaku untuk
      // semua sesi hasil muat ulang, bukan hanya yang berstatus berjalan.
      this.closePendingPermissionsOnRecovery(record, loaded);

      if (record.info.status === "berjalan") {
        record.info.status = "gagal";
        this.append(record, { type: "error", message: RECOVERY_ERROR_MESSAGE });
        this.append(record, {
          type: "result",
          ok: false,
          error: RECOVERY_ERROR_MESSAGE,
        });
        record.info.updatedAt = this.now().toISOString();
        this.persistSession(record);
      }
    }

    // Urutkan agar eviksi (paling lama) bekerja seperti urutan createdAt.
    const ordered = Array.from(this.sessions.values()).sort((a, b) =>
      a.info.createdAt.localeCompare(b.info.createdAt),
    );
    this.sessions.clear();
    for (const record of ordered) {
      this.sessions.set(record.info.id, record);
    }

    while (this.sessions.size > this.maxSessions) {
      const victim = this.sessions.values().next().value as SessionRecord | undefined;
      if (victim === undefined) break;
      this.dropSession(victim);
    }
  }

  /**
   * Menutup izin yang menggantung saat pemulihan sesi: setiap
   * `permission_request` yang belum punya `permission_resolved` dengan id sama
   * ditutup dengan penolakan "sesi terputus". Penutupan ini berlaku untuk semua
   * sesi hasil muat ulang, bukan hanya yang berstatus berjalan.
   *
   * Idempoten: izin yang sudah diputuskan (event lama) tidak disentuh dan
   * pemulihan ulang tidak menambah event ganda. Izin berstatus "terputus"
   * masih bisa diputuskan lewat jalur lanjutan (`resolvePermission`).
   */
  private closePendingPermissionsOnRecovery(record: SessionRecord, events: SequencedEvent[]): void {
    const decided = new Set<string>();
    for (const item of events) {
      if (item.event.type === "permission_resolved") decided.add(item.event.id);
    }

    let closed = 0;
    for (const item of events) {
      const event = item.event;
      if (event.type !== "permission_request") continue;
      if (decided.has(event.id)) continue;
      decided.add(event.id);
      closed += 1;
      this.append(record, {
        type: "permission_resolved",
        id: event.id,
        decision: "deny",
        message: PERMISSION_INTERRUPTED_MESSAGE,
      });
    }

    if (closed === 0) return;
    record.info.pendingPermissions = 0;
    record.info.updatedAt = this.now().toISOString();
    this.persistSession(record);
  }

  /**
   * Satu jalur pembuangan untuk eviksi (restore/ensureCapacity) dan hapus manual.
   * Sesi yang berjalan tidak boleh lewat sini; pemanggil memeriksanya lebih dulu.
   */
  private dropSession(record: SessionRecord): void {
    const id = record.info.id;
    this.sessions.delete(id);

    record.queue.length = 0;
    record.info.queued = 0;
    for (const pending of record.pending.values()) {
      pending.resolve({ behavior: "deny", message: PERMISSION_STOPPED_MESSAGE });
    }
    record.pending.clear();
    record.info.pendingPermissions = 0;

    this.removeCheckpoints(id);
    this.storeGuard(() => this.store?.deleteSession(id));

    // Pelanggan SSE yang menunggu dibangunkan agar loop-nya berakhir seperti biasa.
    this.notify(record);

    this.runDeleteHook(id);
  }

  private runDeleteHook(id: string): void {
    const hook = this.onSessionDeleted;
    if (hook === undefined) return;
    const warn = (): void => {
      if (this.deleteHookWarned) return;
      this.deleteHookWarned = true;
      console.warn("Pembersihan setelah hapus sesi gagal; sisa berkas dibiarkan.");
    };
    try {
      const result = hook(id);
      if (result !== undefined && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch(warn);
      }
    } catch {
      warn();
    }
  }

  private removeCheckpoints(id: string): void {
    const checkpoints = this.checkpoints;
    if (checkpoints === undefined) return;
    try {
      void Promise.resolve(checkpoints.remove(id)).catch(() => undefined);
    } catch {
      // Pembersihan checkpoint tidak boleh menggagalkan siklus sesi.
    }
  }

  async create(input: CreateSessionInput): Promise<SessionInfo> {
    const validated = await this.validate(input);
    this.ensureCapacity();

    let resolved: ResolvedProvider;
    try {
      resolved = await this.resolveProvider(input.selection ?? {});
    } catch (error) {
      throw new SessionError(errorMessage(error), "tidak-valid");
    }

    // Periksa lagi setelah await agar pembuatan serentak tidak melewati batas.
    this.ensureCapacity();

    const timestamp = this.now().toISOString();
    const id = `s_${crypto.randomUUID().slice(0, 8)}`;

    let created: { info: WorktreeInfo; dirtyInSource: boolean } | undefined;
    if (validated.worktree === true) {
      const worktrees = this.worktrees!;
      try {
        created = await worktrees.create({
          sessionId: id,
          title: validated.title,
          cwd: validated.cwd,
        });
      } catch (error) {
        if (error instanceof WorktreeError) {
          throw new SessionError(error.message, "tidak-valid");
        }
        throw error;
      }
    }

    try {
      // Batas bisa berubah setelah worktree dibuat; bila gagal, worktree dibuang.
      this.ensureCapacity();

      const info: SessionInfo = {
        id,
        // `info` dipakai untuk tampilan/persistensi; prompt asli tetap dikirim ke agent.
        title: this.redactText(validated.title),
        prompt: this.redactText(validated.prompt),
        cwd:
          created === undefined
            ? validated.cwd
            : created.info.subdir === undefined
              ? created.info.path
              : join(created.info.path, created.info.subdir),
        profileId: resolved.profileId,
        permissionMode: validated.permissionMode,
        status: "berjalan",
        createdAt: timestamp,
        updatedAt: timestamp,
        eventCount: 0,
        pendingPermissions: 0,
        queued: 0,
      };
      if (resolved.model !== undefined) {
        info.model = resolved.model;
      }
      if (validated.workspaceId !== undefined) {
        info.workspaceId = validated.workspaceId;
        info.workspaceName = validated.workspaceName;
      }
      if (created !== undefined) {
        info.worktree = { ...created.info };
      }
      if (validated.sandbox !== undefined) {
        info.sandbox = validated.sandbox;
      }

      let settle: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });

      const record: SessionRecord = {
        info,
        apiKey: resolved.apiKey,
        controller: new AbortController(),
        buffer: [],
        nextSeq: 1,
        version: 0,
        listeners: new Set(),
        done,
        settle,
        pending: new Map(),
        permissionTimeoutMs: this.permissionTimeoutMs,
        price: resolved.price,
        resolved,
        queue: [],
        turns: 0,
      };
      this.sessions.set(info.id, record);
      this.persistSession(record);
      this.audit("sesi-mulai", "Sesi dimulai", info.id, {
        permissionMode: info.permissionMode,
        worktree: info.worktree !== undefined,
        workspace: info.workspaceId !== undefined,
        model: info.model ?? null,
      });
      if (info.sandbox === "mati") {
        this.audit("pengaturan", "Sesi dibuat tanpa sandbox", info.id, {
          aksi: "sandbox-mati",
        });
      }

      this.startTurn(record, validated.prompt, false);

      // `dirtyInSource` hanya untuk respons pembuatan, tidak disimpan.
      const result: SessionInfo = { ...info };
      if (created !== undefined) result.dirtyInSource = created.dirtyInSource;
      return result;
    } catch (error) {
      if (created !== undefined) {
        await this.worktrees!.remove(created.info, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Periksa input pembuatan sesi tanpa membuat sesi. Aturan izin, bypass,
   * cwd, dan workspace diperiksa persis seperti saat sesi dibuat; dipakai
   * rute prompt tertahan yang menunda pembuatan sesi.
   */
  async checkCreateInput(input: CreateSessionInput): Promise<void> {
    await this.validate(input);
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .reverse()
      .map((record) => this.viewInfo(record));
  }

  get(id: string): SessionInfo | undefined {
    const record = this.sessions.get(id);
    return record === undefined ? undefined : this.viewInfo(record);
  }

  /**
   * Akar proyek untuk daftar izin rahasia: repo asli + subdir untuk sesi
   * worktree, cwd untuk sesi biasa; di-realpath bila ada.
   */
  secretProjectRoot(id: string): string {
    const record = this.requireRecord(id);
    const root = this.cwdForMemory(record);
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  }

  /** Salinan info untuk tampilan; `worktree.missing` dihitung di sini. */
  private viewInfo(record: SessionRecord): SessionInfo {
    const info = record.info;
    const copy: SessionInfo = { ...info };
    // Target mundur bersifat internal; tidak dikirim ke klien.
    delete copy.rewindTo;
    // Bentuk goal untuk klien: tujuan dipotong 200 karakter, tanpa field internal.
    if (record.goal !== undefined) {
      copy.goal = goalView(record.goal);
    }
    if (info.worktree !== undefined) {
      copy.worktree = {
        ...info.worktree,
        missing: !existsSync(info.worktree.path),
      };
    }
    // Sesi yang tak berjalan tapi punya riwayat bisa dilanjutkan (aplikasi
    // berhenti mendadak); dihitung di sini, tidak disimpan.
    copy.canContinue =
      record.sdkSessionId !== undefined && info.status !== "berjalan";
    // Isi antrean untuk klien; pesan sistem (hidden) tak ikut.
    const visible = record.queue.filter((item) => item.hidden !== true);
    if (visible.length > 0) {
      copy.queuedMessages = visible.map((item) => ({ id: item.id, text: item.text }));
    }
    return copy;
  }

  /** Ganti judul; `updatedAt` sengaja tidak diubah agar urutan daftar stabil. */
  rename(id: string, title: unknown): SessionInfo {
    const record = this.requireRecord(id);
    const value = this.validateTitle(title);
    record.info.title = value;
    this.persistSession(record);
    this.notify(record);
    return this.viewInfo(record);
  }

  /**
   * Ganti mode izin sesi; berlaku segera untuk izin yang diminta sesudahnya (SDK giliran
   * berjalan tetap memakai mode lamanya, jadi Jejak yang memutuskan). Pindah ke bypass butuh konfirmasi
   * eksplisit dan tidak boleh dimatikan oleh `allowBypass`.
   */
  setPermissionMode(id: string, mode: unknown, confirmBypass?: unknown): SessionInfo {
    const record = this.requireRecord(id);
    if (typeof mode !== "string" || !PERMISSION_MODES.includes(mode as SessionPermissionMode)) {
      throw new SessionError(`Mode izin "${String(mode)}" belum didukung.`, "tidak-valid");
    }
    if (mode === "bypassPermissions" && record.info.permissionMode !== "bypassPermissions") {
      if (!this.allowBypass) {
        throw new SessionError("Mode bypass dimatikan.", "tidak-valid");
      }
      if (confirmBypass !== true) {
        throw new SessionError("Mode bypass butuh konfirmasi eksplisit.", "tidak-valid");
      }
    }
    record.info.permissionMode = mode as SessionPermissionMode;
    // Mode plan butuh persetujuan manual; tujuan aktif otomatis dijeda.
    if (mode === "plan") {
      const goal = record.goal;
      if (goal !== undefined && goal.status === "active") {
        this.pauseGoalInternal(record, "dihentikan");
      }
    }
    this.persistSession(record);
    this.notify(record);
    this.flushPendingByMode(record);
    return this.viewInfo(record);
  }

  /**
   * Ganti profil/model sesi; berlaku mulai giliran berikutnya (giliran yang sedang
   * berjalan tetap memakai provider lamanya). Riwayat sesi tetap dipakai.
   */
  async setProvider(id: string, selection: { profileId?: string; model?: string }): Promise<SessionInfo> {
    const record = this.requireRecord(id);
    let resolved: ResolvedProvider;
    try {
      resolved = await this.resolveProvider({
        profileId: selection.profileId ?? record.info.profileId,
        ...(selection.model === undefined ? {} : { model: selection.model }),
      });
    } catch (error) {
      throw new SessionError(errorMessage(error), "tidak-valid");
    }
    record.resolved = resolved;
    record.apiKey = resolved.apiKey;
    record.price = resolved.price;
    record.info.profileId = resolved.profileId;
    if (resolved.model === undefined) delete record.info.model;
    else record.info.model = resolved.model;
    this.persistSession(record);
    this.notify(record);
    return this.viewInfo(record);
  }

  /**
   * Ganti mode sandbox Bash sesi. Bila sesi sedang berjalan, giliran yang
   * berjalan dihentikan lalu dilanjutkan otomatis dengan mode baru (SDK tak
   * bisa mengubah sandbox di tengah giliran). Bila sesi tak berjalan, mode
   * baru berlaku pada giliran berikutnya.
   */
  setSandbox(id: string, mode: unknown): SessionInfo {
    const record = this.requireRecord(id);
    if (this.sandboxStore === undefined) {
      throw new SessionError("Sandbox tidak tersedia di server ini.", "tidak-valid");
    }
    if (mode !== "standar" && mode !== "mati") {
      throw new SessionError('Field sandbox hanya "standar" atau "mati".', "tidak-valid");
    }
    const previous = this.effectiveSandboxMode(record);
    record.info.sandbox = mode;
    this.persistSession(record);
    this.notify(record);
    if (mode === "mati") {
      this.audit("pengaturan", "Sesi tanpa sandbox", record.info.id, {
        aksi: "sandbox-mati",
      });
    }
    if (previous !== mode && record.info.status === "berjalan") {
      // Giliran berjalan dihentikan; pesan lanjutan disisipkan di kepala
      // antrean (tak tampil di daftar klien) lalu dijalankan sebagai giliran
      // berikutnya dengan mode baru.
      record.queue.unshift({
        id: crypto.randomUUID(),
        text: sandboxContinueMessage(mode),
        hidden: true,
      });
      record.info.queued = record.queue.length;
      record.sendNowPending = true;
      this.persistSession(record);
      this.notify(record);
      record.controller.abort();
    }
    return this.viewInfo(record);
  }

  /** Arsipkan/batalkan arsip; sesi berjalan harus dihentikan dulu. */
  setArchived(id: string, archived: unknown): SessionInfo {
    const record = this.requireRecord(id);
    if (typeof archived !== "boolean") {
      throw new SessionError("Field archived harus berupa boolean.", "tidak-valid");
    }
    if (record.info.status === "berjalan") {
      throw new SessionError("Hentikan sesi dulu.", "konflik");
    }
    if (archived) {
      record.info.archivedAt = this.now().toISOString();
    } else {
      delete record.info.archivedAt;
    }
    this.persistSession(record);
    this.notify(record);
    return this.viewInfo(record);
  }

  /** Hapus sesi beserta event, checkpoint, dan snapshot undo (lewat hook). */
  delete(id: string): void {
    const record = this.requireRecord(id);
    if (record.info.status === "berjalan") {
      throw new SessionError("Hentikan sesi dulu.", "konflik");
    }
    this.dropSession(record);
  }

  // ---------------------------------------------------------------------
  // Mode Goal
  // ---------------------------------------------------------------------

  /**
   * Mulai tujuan baru. Syarat: sesi tidak berjalan, tidak ada izin tertunda,
   * mode izin bukan `plan`, belum ada tujuan aktif, dan jembatan MCP internal
   * aktif (tool `goal_update` harus bisa dipanggil).
   */
  startGoal(id: string, input: unknown): SessionInfo {
    const record = this.requireRecord(id);
    // Jembatan internal harus bisa menyajikan tool `goal_update`; jembatan
    // tanpa layanan memory (misalnya hanya tool browser) tak memenuhi syarat.
    if (this.memoryBridge === undefined || this.memoryBridge.goalTools === false) {
      throw new SessionError("Mode Goal butuh MCP internal aktif.", "konflik");
    }
    if (record.goal !== undefined && record.goal.status === "active") {
      throw new SessionError("Sesi ini sudah punya tujuan aktif.", "konflik");
    }
    if (record.info.status === "berjalan") {
      throw new SessionError(
        "Sesi sedang berjalan; hentikan dulu sebelum memulai tujuan.",
        "konflik",
      );
    }
    if (record.pending.size > 0) {
      throw new SessionError("Masih ada izin yang menunggu jawaban.", "konflik");
    }
    if (record.info.permissionMode === "plan") {
      throw new SessionError("Mode izin plan tidak mendukung Goal.", "konflik");
    }
    this.assertConcurrencyCapacity();

    let parsed: GoalInput;
    try {
      parsed = parseGoalInput(input);
    } catch (error) {
      if (error instanceof GoalInputError) {
        throw new SessionError(error.message, "tidak-valid");
      }
      throw error;
    }

    const ledger = this.budgetLedger;
    const goal = createGoal(parsed, {
      id: `g_${crypto.randomUUID().slice(0, 8)}`,
      startCostUsd: ledger === undefined ? 0 : ledger.sumForSession(record.info.id),
      now: this.now().toISOString(),
    });
    record.goal = goal;
    this.persistSession(record);
    this.notify(record);

    this.audit("pengaturan", "Tujuan dimulai", record.info.id, {
      aksi: "goal-mulai",
      tujuan: this.redactText(goal.objective.slice(0, 200)),
      maxTurns: goal.maxTurns,
      ...(goal.costCapUsd === undefined ? {} : { costCapUsd: goal.costCapUsd }),
    });

    // Giliran pertama memakai teks pengguna biasa (tanpa penanda otomatis).
    this.startTurn(record, firstGoalPrompt(goal.objective, goal.maxTurns), true);
    return this.viewInfo(record);
  }

  /** Jeda tujuan; giliran yang sedang berjalan dibiarkan selesai. */
  pauseGoal(id: string): SessionInfo {
    const record = this.requireRecord(id);
    const goal = record.goal;
    if (goal === undefined) {
      throw new SessionError("Sesi ini tidak punya tujuan.", "tidak-ditemukan");
    }
    if (goal.status !== "active" && goal.status !== "paused") {
      throw new SessionError("Tujuan ini sudah berakhir.", "konflik");
    }
    if (goal.status === "paused") return this.viewInfo(record);
    this.pauseGoalInternal(record, "dihentikan");
    return this.viewInfo(record);
  }

  /** Lanjutkan tujuan yang dijeda: penghitung direset, lalu satu giliran lanjutan. */
  resumeGoal(id: string): SessionInfo {
    const record = this.requireRecord(id);
    const goal = record.goal;
    if (goal === undefined) {
      throw new SessionError("Sesi ini tidak punya tujuan.", "tidak-ditemukan");
    }
    if (goal.status !== "paused") {
      throw new SessionError(
        "Hanya tujuan yang dijeda yang bisa dilanjutkan.",
        "konflik",
      );
    }
    if (record.info.status === "berjalan") {
      throw new SessionError("Sesi sedang berjalan.", "konflik");
    }
    if (record.pending.size > 0) {
      throw new SessionError("Masih ada izin yang menunggu jawaban.", "konflik");
    }
    this.assertConcurrencyCapacity();

    goal.status = "active";
    delete goal.endedReason;
    goal.autoTurns = 0;
    goal.idleTurns = 0;
    goal.updatedAt = this.now().toISOString();
    this.persistSession(record);
    this.notify(record);
    this.audit("pengaturan", "Tujuan dilanjutkan", record.info.id, {
      aksi: "goal-lanjut",
    });

    goal.autoTurns += 1;
    this.startTurn(
      record,
      continuationPrompt(goal.objective, goal.autoTurns, goal.maxTurns),
      true,
      "goal",
    );
    return this.viewInfo(record);
  }

  /** Hentikan tujuan: giliran berjalan dibatalkan, status menjadi `stopped`. */
  stopGoal(id: string): SessionInfo {
    const record = this.requireRecord(id);
    const goal = record.goal;
    if (goal === undefined) {
      throw new SessionError("Sesi ini tidak punya tujuan.", "tidak-ditemukan");
    }
    if (goal.status === "stopped" || goal.status === "achieved" || goal.status === "blocked") {
      throw new SessionError("Tujuan ini sudah berakhir.", "konflik");
    }

    goal.status = "stopped";
    goal.endedReason = "dihentikan";
    goal.updatedAt = this.now().toISOString();
    this.persistSession(record);
    this.notify(record);
    this.audit("pengaturan", "Tujuan dihentikan", record.info.id, {
      aksi: "goal-henti",
      alasan: "dihentikan",
    });

    if (record.info.status === "berjalan") {
      record.controller.abort();
      this.clearQueue(record);
    }
    this.append(record, { type: "notice", text: "Tujuan dihentikan.", level: "warn" });
    return this.viewInfo(record);
  }

  /** Tujuan sesi; `null` bila sesi tidak punya tujuan. */
  getGoal(id: string): GoalView | null {
    const record = this.requireRecord(id);
    return record.goal === undefined ? null : goalView(record.goal);
  }

  /**
   * Laporan agent lewat tool `goal_update`. Hanya mencatat status dan
   * ringkasan; batas giliran, plafon biaya, dan mode izin tidak berubah.
   */
  reportGoal(sessionId: string, report: GoalReport): GoalReportResult {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      return { ok: false, error: "Sesi tidak ditemukan." };
    }
    const goal = record.goal;
    if (goal === undefined || goal.status !== "active") {
      return { ok: false, error: "Sesi ini tidak punya tujuan aktif." };
    }

    const turn = record.turn;
    if (turn !== undefined) {
      turn.reportedStatus = report.status;
      turn.summary = report.summary;
    }
    goal.reportedStatus = report.status;
    goal.summary = report.summary;
    goal.updatedAt = this.now().toISOString();
    this.persistSession(record);
    this.notify(record);
    return { ok: true };
  }

  /** Apakah sesi punya tujuan aktif (tool `goal_update` hanya saat itu). */
  hasActiveGoal(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    const goal = record?.goal;
    return goal !== undefined && goal.status === "active";
  }

  /** Jeda internal (dipakai juga saat mode izin diganti ke `plan`). */
  private pauseGoalInternal(record: SessionRecord, reason: GoalEndReason): void {
    const goal = record.goal;
    if (goal === undefined) return;
    goal.status = "paused";
    goal.endedReason = reason;
    goal.updatedAt = this.now().toISOString();
    this.persistSession(record);
    this.notify(record);
    this.audit("pengaturan", "Tujuan dijeda", record.info.id, {
      aksi: "goal-jeda",
      alasan: reason,
    });
    this.append(record, {
      type: "notice",
      text: `Tujuan dijeda: ${GOAL_REASON_LABEL[reason]}.`,
      level: "warn",
    });
  }

  /** Akhiri tujuan: status akhir, audit, dan satu notifikasi. */
  private endGoal(
    record: SessionRecord,
    status: GoalStatus,
    reason: GoalEndReason,
    summary?: string,
  ): void {
    const goal = record.goal;
    if (goal === undefined) return;
    goal.status = status;
    goal.endedReason = reason;
    if (summary !== undefined) goal.summary = summary;
    goal.updatedAt = this.now().toISOString();
    this.persistSession(record);
    this.notify(record);
    // Ringkasan agent tidak pernah masuk audit.
    this.audit("pengaturan", `Tujuan berakhir: ${GOAL_REASON_LABEL[reason]}`, record.info.id, {
      aksi: "goal-selesai",
      alasan: reason,
    });
    this.append(record, {
      type: "notice",
      text: `Tujuan berakhir: ${GOAL_REASON_LABEL[reason]}.`,
      level: "info",
    });
  }

  /** Hasil giliran untuk keputusan loop Goal. */
  private goalOutcome(record: SessionRecord): GoalOutcome {
    const goal = record.goal;
    const turn = record.turn;
    const ledger = this.budgetLedger;
    const cost =
      goal === undefined || ledger === undefined
        ? 0
        : Math.max(0, ledger.sumForSession(record.info.id) - goal.startCostUsd);
    const budget = record.info.budget?.session;
    const outcome: GoalOutcome = {
      turnStatus: "selesai",
      toolCalls: turn?.toolCalls ?? 0,
      costSinceStartUsd: cost,
    };
    if (turn?.reportedStatus !== undefined) outcome.reportedStatus = turn.reportedStatus;
    if (budget !== undefined) outcome.sessionBudget = budget;
    return outcome;
  }

  /**
   * Lanjut otomatis. Batas keras diperiksa `decideNext` SEBELUM giliran
   * baru dimulai; bila prasyarat tidak terpenuhi, tujuan dijeda (bukan
   * menumpuk giliran).
   */
  private continueGoal(record: SessionRecord): void {
    const goal = record.goal;
    if (goal === undefined || goal.status !== "active") return;
    if (record.info.status !== "selesai") return;

    const turn = record.turn;
    const toolCalls = turn?.toolCalls ?? 0;
    // Giliran pengguna memutus rentetan giliran otomatis tanpa tool call.
    if (turn?.auto !== true) goal.idleTurns = 0;

    const decision = decideNext(goal, this.goalOutcome(record));
    if (turn?.auto === true) {
      goal.idleTurns = nextIdleTurns(goal, toolCalls);
    }

    if (decision.action === "end") {
      this.endGoal(record, decision.status, decision.reason, decision.summary);
      return;
    }

    // Prasyarat giliran otomatis: tidak ada izin tertunda dan kapasitas cukup.
    if (record.pending.size > 0) {
      this.pauseGoalInternal(record, "dihentikan");
      return;
    }
    try {
      this.assertConcurrencyCapacity();
    } catch {
      this.pauseGoalInternal(record, "dihentikan");
      return;
    }

    goal.autoTurns += 1;
    goal.updatedAt = this.now().toISOString();
    const prompt = continuationPrompt(goal.objective, goal.autoTurns, goal.maxTurns);
    try {
      this.startTurn(record, prompt, true, "goal");
    } catch {
      // Galat saat memulai: berhenti tanpa mencoba ulang.
      this.endGoal(record, "stopped", "gagal");
    }
  }

  /** Giliran gagal atau dibatalkan: tujuan berhenti, tidak pernah lanjut. */
  private finishGoalOnFailure(record: SessionRecord): void {
    const goal = record.goal;
    if (goal === undefined || goal.status !== "active") return;
    const reason: GoalEndReason =
      record.info.status === "dibatalkan" ? "dihentikan" : "gagal";
    this.endGoal(record, "stopped", reason);
  }

  /** Pesan lanjutan ditolak bila worktree sesi sudah dihapus atau foldernya hilang. */
  private assertWorktreeUsable(record: SessionRecord): void {
    const worktree = record.info.worktree;
    if (worktree === undefined) return;
    if (worktree.removed === true) {
      throw new SessionError("Worktree sesi sudah dihapus.", "konflik");
    }
    if (!existsSync(worktree.path)) {
      throw new SessionError("Folder worktree hilang; pulihkan dulu.", "konflik");
    }
  }

  private requireWorktreeRecord(id: string): SessionRecord {
    const record = this.requireRecord(id);
    if (record.info.worktree === undefined) {
      throw new SessionError("Sesi ini tidak punya worktree.", "tidak-ditemukan");
    }
    if (record.info.status === "berjalan") {
      throw new SessionError("Hentikan sesi dulu.", "konflik");
    }
    return record;
  }

  /** Hapus worktree sesi; cabang `jejak/...` sengaja tidak dihapus. */
  async removeWorktree(id: string, options: { force?: boolean } = {}): Promise<void> {
    const record = this.requireWorktreeRecord(id);
    const worktrees = this.worktrees;
    if (worktrees === undefined) {
      throw new SessionError("Worktree dimatikan.", "tidak-valid");
    }
    const info = record.info.worktree!;
    try {
      await worktrees.remove(info, { force: options.force === true });
    } catch (error) {
      if (error instanceof WorktreeError) {
        throw new SessionError(
          error.message,
          error.code === "konflik"
            ? "konflik"
            : error.code === "tidak-ditemukan"
              ? "tidak-ditemukan"
              : "tidak-valid",
          { dirtyFiles: error.dirtyFiles, commitsAhead: error.commitsAhead },
        );
      }
      throw error;
    }
    record.info.worktree = { ...info, removed: true };
    this.persistSession(record);
    this.notify(record);
  }

  /** Pulihkan folder worktree dari cabang yang sama. */
  async restoreWorktree(id: string): Promise<WorktreeInfo> {
    const record = this.requireWorktreeRecord(id);
    const worktrees = this.worktrees;
    if (worktrees === undefined) {
      throw new SessionError("Worktree dimatikan.", "tidak-valid");
    }
    const info = record.info.worktree!;
    try {
      await worktrees.restore(info);
    } catch (error) {
      if (error instanceof WorktreeError) {
        throw new SessionError(
          error.message,
          error.code === "konflik"
            ? "konflik"
            : error.code === "tidak-ditemukan"
              ? "tidak-ditemukan"
              : "tidak-valid",
        );
      }
      throw error;
    }
    record.info.worktree = { ...info, removed: false };
    this.persistSession(record);
    this.notify(record);
    return this.worktreeView(record.info.worktree!);
  }

  private worktreeView(info: WorktreeInfo): WorktreeInfo {
    return { ...info, missing: !existsSync(info.path) };
  }

  private requireRecord(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (record === undefined) {
      throw new SessionError(`Sesi "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    return record;
  }

  private validateTitle(title: unknown): string {
    if (typeof title !== "string") {
      throw new SessionError("Judul harus berupa teks.", "tidak-valid");
    }
    const value = title.trim();
    if (value === "" || value.length > 120) {
      throw new SessionError("Judul harus 1..120 karakter.", "tidak-valid");
    }
    // Hanya spasi biasa yang boleh; karakter kontrol lain ditolak.
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new SessionError("Judul tidak boleh memuat karakter kontrol.", "tidak-valid");
    }
    return value;
  }

  async *events(
    id: string,
    options: { after?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<SequencedEvent> {
    const record = this.sessions.get(id);
    if (record === undefined) {
      throw new SessionError(`Sesi "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }

    const requested = options.after ?? 0;
    let cursor = Number.isFinite(requested) ? requested : 0;
    const signal = options.signal;

    while (true) {
      if (isAborted(signal)) return;
      const version = record.version;

      for (const item of record.buffer) {
        if (item.seq <= cursor) continue;
        cursor = item.seq;
        yield item;
        if (isAborted(signal)) return;
      }

      if (record.info.status !== "berjalan" && record.turnActive !== true) return;
      await waitForChange(record, version, signal);
    }
  }

  async send(id: string, text: string): Promise<{ queued: boolean }> {
    const record = this.sessions.get(id);
    if (record === undefined) {
      throw new SessionError(`Sesi "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }

    const message = this.validateMessage(text);
    this.assertWorktreeUsable(record);

    if (record.info.status === "berjalan" || record.turnActive === true) {
      if (record.queue.length >= MAX_QUEUED_MESSAGES) {
        throw new SessionError(
          `Antrean pesan penuh; maksimal ${MAX_QUEUED_MESSAGES} pesan.`,
          "penuh",
        );
      }
      record.queue.push({ id: crypto.randomUUID(), text: message });
      record.info.queued = record.queue.length;
      this.persistSession(record);
      this.notify(record);
      if (record.info.status !== "berjalan") {
        // Giliran sudah selesai tapi masih menunggu saran: potong penantian
        // supaya pesan tak tertahan sampai batas saran habis.
        record.suggestionCut = true;
        this.stopTurn(record);
      }
      return { queued: true };
    }

    if (record.sdkSessionId === undefined) {
      throw new SessionError(
        "Sesi ini belum punya riwayat untuk dilanjutkan.",
        "tidak-valid",
      );
    }

    if (record.resolved === undefined) {
      let resolved: ResolvedProvider;
      try {
        resolved = await this.resolveProvider({
          profileId: record.info.profileId,
          model: record.info.model,
        });
      } catch (error) {
        throw new SessionError(errorMessage(error), "tidak-valid");
      }
      record.resolved = resolved;
      record.apiKey = resolved.apiKey;
      record.price = resolved.price;
    }

    this.assertConcurrencyCapacity();
    this.startTurn(record, message, true);
    return { queued: false };
  }

  /**
   * Buang satu pesan dari antrean; pesan lain tetap antre.
   */
  removeQueued(id: string, queueId: string): void {
    const record = this.requireRecord(id);
    const index = record.queue.findIndex((item) => item.id === queueId);
    if (index === -1) {
      throw new SessionError("pesan antrean tidak ditemukan", "tidak-ditemukan");
    }
    record.queue.splice(index, 1);
    record.info.queued = record.queue.length;
    this.persistSession(record);
    this.notify(record);
  }

  /**
   * Kirim satu pesan antrean sekarang: giliran yang sedang berjalan dihentikan
   * lalu pesan itu jadi giliran berikutnya; pesan lain tetap antre di
   * belakangnya dan jalan sesudahnya.
   */
  sendQueuedNow(id: string, queueId: string): void {
    const record = this.requireRecord(id);
    if (record.info.status !== "berjalan") {
      throw new SessionError("Sesi sedang tidak berjalan.", "konflik");
    }
    const index = record.queue.findIndex((item) => item.id === queueId);
    if (index === -1) {
      throw new SessionError("pesan antrean tidak ditemukan", "tidak-ditemukan");
    }
    const [entry] = record.queue.splice(index, 1);
    record.queue.unshift(entry!);
    record.info.queued = record.queue.length;
    // Penanda dibaca di akhir giliran: antrean tak dibersihkan dan pesan
    // teratas dijalankan sebagai giliran berikutnya.
    record.sendNowPending = true;
    this.persistSession(record);
    this.notify(record);
    record.controller.abort();
  }

  /**
   * Arahkan satu pesan antrean ke giliran yang sedang berjalan: pesan itu
   * disisipkan ke giliran berjalan tanpa membatalkannya, jadi giliran tak
   * perlu dihentikan lalu diulang.
   */
  steerQueued(id: string, queueId: string): void {
    const record = this.requireRecord(id);
    const steer = record.steer;
    if (record.info.status !== "berjalan" || steer === undefined) {
      throw new SessionError("Sesi sedang tidak berjalan.", "konflik");
    }
    // Pesan sistem (hidden) tak pernah bisa diarahkan pengguna.
    const index = record.queue.findIndex(
      (item) => item.id === queueId && item.hidden !== true,
    );
    if (index === -1) {
      throw new SessionError("pesan antrean tidak ditemukan", "tidak-ditemukan");
    }
    const entry = record.queue[index]!;
    const masuk = steer(entry.text);
    if (!masuk) {
      throw new SessionError("Giliran sudah selesai; pesan tetap antre.", "konflik");
    }
    record.queue.splice(index, 1);
    record.info.queued = record.queue.length;
    this.append(record, { type: "user_message", text: entry.text });
    this.persistSession(record);
    this.notify(record);
  }

  /**
   * Mundur percakapan: pesan pengguna target dan semua sesudahnya dibuang dari
   * riwayat sesi. Giliran berikutnya melanjutkan percakapan SDK dari jangkar
   * giliran sebelumnya (opsi `resumeSessionAt` + fork). Berkas tidak ikut
   * dikembalikan; teks pesan yang dibuang dikembalikan untuk disunting ulang.
   */
  async rewindConversation(id: string, eventSeq: unknown): Promise<{ text: string }> {
    const record = this.sessions.get(id);
    if (record === undefined) {
      throw new SessionError(`Sesi "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    const goal = record.goal;
    if (goal !== undefined && goal.status === "active") {
      throw new SessionError(
        "Hentikan tujuan dulu sebelum mundur percakapan.",
        "konflik",
      );
    }
    if (record.info.status === "berjalan" || record.pending.size > 0) {
      throw new SessionError("Hentikan sesi dulu.", "konflik");
    }
    if (typeof eventSeq !== "number" || !Number.isSafeInteger(eventSeq) || eventSeq < 1) {
      throw new SessionError("Field eventSeq harus berupa nomor urut event.", "tidak-valid");
    }

    const target = record.buffer.find((item) => item.seq === eventSeq);
    if (target === undefined) {
      throw new SessionError("Pesan tidak ditemukan pada sesi ini.", "tidak-valid");
    }
    if (target.event.type !== "user_message") {
      throw new SessionError("Hanya pesan pengguna yang bisa dimundurkan.", "tidak-valid");
    }
    // Pesan otomatis mode Goal tidak bisa dimundurkan.
    if (target.event.auto !== undefined) {
      throw new SessionError("Pesan otomatis tidak bisa dimundurkan.", "tidak-valid");
    }

    const anchor = this.anchorBefore(record, target.seq);
    if (anchor === undefined) {
      throw new SessionError(
        "Pesan ini tidak bisa dimundurkan: giliran sebelumnya tidak punya jangkar.",
        "tidak-valid",
      );
    }
    const sdkSessionId = record.sdkSessionId;
    if (sdkSessionId === undefined) {
      throw new SessionError(
        "Sesi ini belum punya riwayat untuk dilanjutkan.",
        "tidak-valid",
      );
    }

    // (a) buang event target dan sesudahnya dari buffer dan penyimpanan.
    record.buffer = record.buffer.filter((item) => item.seq < target.seq);
    this.storeGuard(() => this.store?.deleteEventsFrom(record.info.id, target.seq));

    // (b) simpan jangkar untuk giliran berikutnya (persisten di baris sesi).
    record.rewindTo = { uuid: anchor, sdkSessionId };

    // (c) hitung ulang field turunan.
    record.info.eventCount = record.buffer.filter(
      (item) => !isTransientEvent(item.event),
    ).length;
    record.queue.length = 0;
    record.info.queued = 0;
    record.info.pendingPermissions = 0;
    record.turns = this.countTurns(record.buffer);
    record.info.updatedAt = this.now().toISOString();
    this.persistSession(record);
    this.notify(record);

    // (d) catat audit.
    this.audit("pengaturan", "Percakapan dimundurkan", record.info.id, {
      aksi: "mundur-percakapan",
    });

    return { text: target.event.text };
  }

  /**
   * Jangkar giliran sebelumnya: uuid pesan assistant terakhir pada `result`
   * paling akhir sebelum nomor urut target. `undefined` bila tidak ada.
   */
  private anchorBefore(record: SessionRecord, seq: number): string | undefined {
    for (let index = record.buffer.length - 1; index >= 0; index -= 1) {
      const item = record.buffer[index]!;
      if (item.seq >= seq) continue;
      if (item.event.type !== "result") continue;
      return item.event.anchorUuid;
    }
    return undefined;
  }

  /**
   * Pertanyaan sampingan: dijawab model dari salinan (fork) percakapan sesi.
   * Tidak menambah event ke timeline, tidak mengubah status sesi, dan tidak
   * mengganggu giliran yang sedang berjalan.
   */
  async askAside(id: string, question: unknown): Promise<{ answer: string }> {
    const record = this.sessions.get(id);
    if (record === undefined) {
      throw new SessionError(`Sesi "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }

    const text = this.validateMessage(question as string);

    if (record.sdkSessionId === undefined) {
      throw new SessionError(
        "Sesi ini belum punya riwayat untuk ditanya.",
        "tidak-valid",
      );
    }

    // Provider diselesaikan seperti `send`, tetapi record tidak boleh berubah.
    let provider: ResolvedProvider | undefined = record.resolved;
    if (provider === undefined) {
      try {
        provider = await this.resolveProvider({
          profileId: record.info.profileId,
          model: record.info.model,
        });
      } catch (error) {
        throw new SessionError(errorMessage(error), "tidak-valid");
      }
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ASIDE_TIMEOUT_MS);

    const parts: string[] = [];
    let failure: string | undefined;
    try {
      for await (const event of this.runner.run({
        prompt: text,
        cwd: record.info.cwd,
        provider,
        permissionMode: "plan",
        resumeSessionId: record.sdkSessionId,
        fork: true,
        noTools: true,
        signal: controller.signal,
      })) {
        // Event `session` dari fork diabaikan; `sdkSessionId` sesi asal tetap.
        if (event.type === "text") {
          parts.push(event.text);
        } else if (event.type === "error") {
          failure = event.message;
        } else if (event.type === "result" && !event.ok) {
          failure = event.error ?? "gagal menjawab pertanyaan";
        }
      }
    } catch (error) {
      throw new SessionError(errorMessage(error), "tidak-valid");
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      throw new SessionError(
        `Waktu menjawab pertanyaan sampingan habis (${Math.round(ASIDE_TIMEOUT_MS / 1000)} detik).`,
        "tidak-valid",
      );
    }
    if (failure !== undefined) {
      throw new SessionError(failure, "tidak-valid");
    }

    // Tiap event `text` adalah satu blok utuh; pisahkan blok dengan paragraf baru.
    const answer = parts
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join("\n\n");
    return { answer };
  }

  interrupt(id: string): boolean {
    const record = this.sessions.get(id);
    if (record === undefined || record.info.status !== "berjalan") {
      return false;
    }
    record.controller.abort();
    this.clearQueue(record);
    return true;
  }

  done(id: string): Promise<void> {
    const record = this.sessions.get(id);
    return record === undefined ? Promise.resolve() : record.done;
  }

  private async validate(input: CreateSessionInput): Promise<{
    prompt: string;
    cwd: string;
    title: string;
    permissionMode: SessionPermissionMode;
    workspaceId?: string;
    workspaceName?: string;
    worktree?: boolean;
    sandbox?: SandboxMode;
  }> {
    if (typeof input.prompt !== "string") {
      throw new SessionError("Prompt harus berupa teks.", "tidak-valid");
    }
    const prompt = input.prompt.trim();
    if (prompt === "") {
      throw new SessionError("Prompt tidak boleh kosong.", "tidak-valid");
    }
    if (prompt.length > this.maxPromptLength) {
      throw new SessionError(
        `Prompt terlalu panjang; maksimal ${this.maxPromptLength} karakter.`,
        "tidak-valid",
      );
    }

    if (input.worktree !== undefined && typeof input.worktree !== "boolean") {
      throw new SessionError("Field worktree harus berupa boolean.", "tidak-valid");
    }
    const wantsWorktree = input.worktree === true;
    if (wantsWorktree && this.worktrees === undefined) {
      throw new SessionError("Worktree dimatikan.", "tidak-valid");
    }
    if (wantsWorktree && input.workspaceId !== undefined) {
      throw new SessionError("Worktree belum didukung untuk sesi workspace.", "tidak-valid");
    }

    if (input.sandbox !== undefined && input.sandbox !== "standar" && input.sandbox !== "mati") {
      throw new SessionError('Field sandbox hanya "standar" atau "mati".', "tidak-valid");
    }
    let sandbox: SandboxMode | undefined;
    if (this.sandboxStore === undefined) {
      if (input.sandbox !== undefined) {
        throw new SessionError("Sandbox dimatikan.", "tidak-valid");
      }
    } else {
      if (input.sandbox !== undefined) {
        sandbox = input.sandbox;
      } else {
        try {
          sandbox = this.sandboxStore.get().mode;
        } catch {
          sandbox = "standar";
        }
      }
    }

    const workspace = await this.resolveWorkspaceForCreate(input.workspaceId);

    const rawCwd = input.cwd;
    const cwdMissing = typeof rawCwd !== "string" || rawCwd.trim() === "";
    let cwd: string;
    if (cwdMissing) {
      if (workspace === undefined) {
        throw new SessionError("cwd harus berupa path absolut yang ada.", "tidak-valid");
      }
      cwd = workspace.primary.path;
    } else {
      cwd = (rawCwd as string).trim();
      if (!isAbsolute(cwd)) {
        throw new SessionError("cwd harus berupa path absolut.", "tidak-valid");
      }
      let cwdIsDirectory = false;
      try {
        cwdIsDirectory = (await stat(cwd)).isDirectory();
      } catch {
        cwdIsDirectory = false;
      }
      if (!cwdIsDirectory) {
        throw new SessionError(
          `cwd "${cwd}" tidak ditemukan atau bukan direktori.`,
          "tidak-valid",
        );
      }
    }

    if (workspace !== undefined && !cwdMissing) {
      const matches = await this.cwdMatchesWorkspace(cwd, workspace.view);
      if (!matches) {
        throw new SessionError("cwd bukan salah satu repo workspace.", "tidak-valid");
      }
    }

    let permissionMode: SessionPermissionMode = "default";
    if (input.permissionMode !== undefined) {
      const requested = input.permissionMode;
      if (!PERMISSION_MODES.includes(requested as SessionPermissionMode)) {
        throw new SessionError(`Mode izin "${String(requested)}" belum didukung.`, "tidak-valid");
      }
      permissionMode = requested as SessionPermissionMode;
    }

    if (input.confirmBypass !== undefined && typeof input.confirmBypass !== "boolean") {
      throw new SessionError("Field confirmBypass harus berupa boolean.", "tidak-valid");
    }
    if (permissionMode === "bypassPermissions") {
      if (!this.allowBypass) {
        throw new SessionError("Mode bypass dimatikan.", "tidak-valid");
      }
      if (input.confirmBypass !== true) {
        throw new SessionError("Mode bypass butuh konfirmasi eksplisit.", "tidak-valid");
      }
    } else if (input.confirmBypass !== undefined) {
      throw new SessionError("confirmBypass hanya untuk mode bypass.", "tidak-valid");
    }

    let title = "";
    if (typeof input.title === "string") {
      title = input.title.trim();
    }
    if (title === "") {
      title = collapseWhitespace(prompt).slice(0, 60).trimEnd();
    }

    const result: {
      prompt: string;
      cwd: string;
      title: string;
      permissionMode: SessionPermissionMode;
      workspaceId?: string;
      workspaceName?: string;
      worktree?: boolean;
      sandbox?: SandboxMode;
    } = { prompt, cwd, title, permissionMode };
    if (workspace !== undefined) {
      result.workspaceId = workspace.view.id;
      result.workspaceName = workspace.view.name;
    }
    if (wantsWorktree) result.worktree = true;
    if (sandbox !== undefined) result.sandbox = sandbox;
    return result;
  }

  private async resolveWorkspaceForCreate(
    workspaceId: unknown,
  ): Promise<
    | {
        view: WorkspaceResolverView;
        primary: WorkspaceResolverRepo;
      }
    | undefined
  > {
    if (workspaceId === undefined) {
      return undefined;
    }
    if (typeof workspaceId !== "string" || this.workspaces === undefined) {
      throw new SessionError("Workspace tidak ditemukan.", "tidak-valid");
    }
    const id = workspaceId.trim();
    if (id === "") {
      throw new SessionError("Workspace tidak ditemukan.", "tidak-valid");
    }

    let view: WorkspaceResolverView | undefined;
    try {
      view = await this.workspaces.get(id);
    } catch {
      view = undefined;
    }
    if (view === undefined) {
      throw new SessionError("Workspace tidak ditemukan.", "tidak-valid");
    }

    const primary = view.repos[0];
    if (primary === undefined) {
      throw new SessionError(
        `Workspace "${view.name}" tidak punya repo utama; tentukan cwd secara eksplisit.`,
        "tidak-valid",
      );
    }
    if (primary.missing) {
      throw new SessionError(
        `Repo utama "${primary.name}" pada workspace "${view.name}" tidak ditemukan.`,
        "tidak-valid",
      );
    }
    return { view, primary };
  }

  private async cwdMatchesWorkspace(cwd: string, view: WorkspaceResolverView): Promise<boolean> {
    let cwdReal: string;
    try {
      cwdReal = await realpath(cwd);
    } catch {
      return false;
    }
    for (const repo of view.repos) {
      if (repo.missing) continue;
      try {
        if ((await realpath(repo.path)) === cwdReal) {
          return true;
        }
      } catch {
        // Repo yang menghilang dianggap tidak cocok.
      }
    }
    return false;
  }

  private validateMessage(text: string): string {
    if (typeof text !== "string") {
      throw new SessionError("Pesan harus berupa teks.", "tidak-valid");
    }
    const message = text.trim();
    if (message === "") {
      throw new SessionError("Pesan tidak boleh kosong.", "tidak-valid");
    }
    if (message.length > this.maxPromptLength) {
      throw new SessionError(
        `Pesan terlalu panjang; maksimal ${this.maxPromptLength} karakter.`,
        "tidak-valid",
      );
    }
    return message;
  }

  private assertConcurrencyCapacity(): void {
    const running = Array.from(this.sessions.values()).filter(
      (record) => record.info.status === "berjalan",
    ).length;
    if (running >= this.maxConcurrent) {
      throw new SessionError("Terlalu banyak sesi berjalan; coba lagi nanti.", "penuh");
    }
  }

  private ensureCapacity(): void {
    this.assertConcurrencyCapacity();

    while (this.sessions.size >= this.maxSessions) {
      // Sesi terarsip yang tidak berjalan dibuang lebih dulu (tertua lebih dulu),
      // lalu urutan lama: sesi selesai pertama yang ditemukan.
      const idle = Array.from(this.sessions.values()).filter(
        (record) => record.info.status !== "berjalan",
      );
      const archived = idle
        .filter((record) => record.info.archivedAt !== undefined)
        .sort((a, b) => a.info.archivedAt!.localeCompare(b.info.archivedAt!));
      const victim = archived[0] ?? idle[0];
      if (victim === undefined) {
        throw new SessionError("Kapasitas sesi penuh; tidak ada sesi selesai untuk dibuang.", "penuh");
      }
      this.dropSession(victim);
    }
  }

  private clearQueue(record: SessionRecord): void {
    if (record.queue.length === 0 && record.info.queued === 0) {
      return;
    }
    record.queue.length = 0;
    record.info.queued = 0;
    this.persistSession(record);
    this.notify(record);
  }

  /**
   * Mulai satu giliran. `auto: "goal"` menandai giliran lanjutan otomatis
   * mode Goal (event pesannya ditandai, tidak bisa dimundurkan).
   * `auto: "sistem"` menandai pesan sistem (mis. lanjutan ganti sandbox);
   * pesan itu tampil sebagai catatan, bukan pesan pengguna.
   */
  private startTurn(
    record: SessionRecord,
    text: string,
    isFollowUp: boolean,
    auto?: "goal" | "sistem",
  ): void {
    record.controller = new AbortController();
    let settle: () => void = () => {};
    record.done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    record.settle = settle;
    record.turns += 1;
    record.turn = { auto: auto === "goal", toolCalls: 0 };

    this.setStatus(record, "berjalan");
    if (isFollowUp) {
      if (auto === "sistem") {
        this.append(record, { type: "notice", text, level: "info" });
      } else {
        this.append(
          record,
          auto === undefined
            ? { type: "user_message", text }
            : { type: "user_message", text, auto },
        );
      }
    }

    const resolved = record.resolved;
    if (resolved === undefined) {
      this.append(record, { type: "error", message: "provider belum diselesaikan" });
      this.append(record, { type: "result", ok: false, error: "provider belum diselesaikan" });
      this.setStatus(record, "gagal");
      // Giliran tidak jalan: tujuan berhenti, bukan menunggu tanpa batas.
      this.finishGoalOnFailure(record);
      record.settle();
      return;
    }

    void this.execute(
      record,
      text,
      resolved,
      record.info.permissionMode,
      record.sdkSessionId,
    );
  }

  /** Giliran terhitung dari event user_message; giliran pertama tidak punya event itu. */
  private countTurns(buffer: SequencedEvent[]): number {
    return buffer.filter((item) => item.event.type === "user_message").length + 1;
  }

  private async ensureTurnCheckpoint(record: SessionRecord): Promise<void> {
    const checkpoints = this.checkpoints;
    if (checkpoints === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(
          checkpoints.create(record.info.id, record.info.cwd, {
            kind: "turn",
            turn: record.turns,
          }),
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CHECKPOINT_TIMEOUT_MS);
        }),
      ]);
    } catch {
      if (!this.checkpointWarned) {
        this.checkpointWarned = true;
        console.warn("Checkpoint giliran tidak dibuat; sesi lanjut tanpa checkpoint.");
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async workspaceForRun(record: SessionRecord): Promise<RunWorkspace | undefined> {
    const id = record.info.workspaceId;
    const resolver = this.workspaces;
    if (id === undefined || resolver === undefined) {
      return undefined;
    }

    let view: WorkspaceResolverView | undefined;
    try {
      view = await resolver.get(id);
    } catch {
      view = undefined;
    }
    if (view === undefined) {
      if (record.workspaceWarned !== true) {
        record.workspaceWarned = true;
        console.warn("Workspace sesi tidak tersedia; sesi lanjut tanpa konteks workspace.");
      }
      return undefined;
    }

    const cwdReal = await this.realpathOrSelf(record.info.cwd);
    const additionalDirectories: string[] = [];
    for (const repo of view.repos) {
      if (repo.missing || additionalDirectories.length >= 20) continue;
      if ((await this.realpathOrSelf(repo.path)) === cwdReal) continue;
      additionalDirectories.push(repo.path);
    }

    return {
      name: view.name,
      repos: view.repos.map((repo) => ({
        name: repo.name,
        path: repo.path,
        kind: repo.kind,
      })),
      additionalDirectories,
    };
  }

  private async realpathOrSelf(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  }

  /**
   * Daftar server MCP eksternal per giliran; galat tidak menggagalkan sesi dan
   * peringatan hanya sekali (tanpa isi berkas).
   */
  private async mcpServersForRun(): Promise<ResolvedMcpServer[] | undefined> {
    const resolver = this.mcpServers;
    if (resolver === undefined) {
      return undefined;
    }
    try {
      const servers = await resolver.resolved();
      return servers.length === 0 ? undefined : servers;
    } catch {
      if (!this.mcpServersWarned) {
        this.mcpServersWarned = true;
        console.warn("Daftar server MCP tidak tersedia; sesi lanjut tanpa server eksternal.");
      }
      return undefined;
    }
  }

  private async execute(
    record: SessionRecord,
    prompt: string,
    provider: ResolvedProvider,
    permissionMode: SessionPermissionMode,
    resumeSessionId: string | undefined,
  ): Promise<void> {
    await this.ensureTurnCheckpoint(record);
    const input: Parameters<AgentRunner["run"]>[0] = {
      prompt,
      cwd: record.info.cwd,
      provider,
      // Kill switch berlaku juga untuk sesi lama (mis. dipulihkan setelah restart):
      // tanpa izin bypass, giliran jatuh ke mode "default" yang bertanya dulu.
      permissionMode: (permissionMode === "bypassPermissions" && !this.allowBypass
        ? "default"
        : permissionMode) as PermissionMode,
      signal: record.controller.signal,
      requestPermission: (request) => this.requestPermission(record, request),
      // Jalur "Arahkan": pesan antrean bisa disisipkan ke giliran ini.
      registerSteer: (steer) => {
        record.steer = steer;
      },
    };
    if (resumeSessionId !== undefined) {
      input.resumeSessionId = resumeSessionId;
    }
    // Target mundur: lanjutkan dari jangkar dan cabang riwayat lama.
    const rewindTo = record.rewindTo;
    if (rewindTo !== undefined) {
      input.resumeSessionId = rewindTo.sdkSessionId;
      input.resumeAt = rewindTo.uuid;
      input.fork = true;
    }
    const claude = this.claudeForRun(record);
    if (claude !== undefined) {
      input.claude = claude;
    }
    if (this.extraDirectories.length > 0) {
      input.extraDirectories = this.extraDirectories;
    }
    let workspace: RunWorkspace | undefined;
    if (record.info.workspaceId !== undefined && this.workspaces !== undefined) {
      workspace = await this.workspaceForRun(record);
      if (workspace !== undefined) {
        input.workspace = workspace;
      }
    }

    // Profil cadangan dicek di depan: membatasi retry SDK dan menambah host
    // cadangan ke allowlist jaringan Bash.
    let plannedFallback: ResolvedProvider | undefined;
    if (this.fallback !== undefined) {
      try {
        plannedFallback = await this.fallback(provider.profileId);
      } catch {
        plannedFallback = undefined;
      }
      if (plannedFallback?.profileId === provider.profileId) plannedFallback = undefined;
    }

    // Sandbox gagal-tertutup: bila opsi tak bisa dibangun, giliran gagal alih-alih
    // berjalan tanpa sandbox (kecuali mode `mati` yang memang tanpa opsi).
    if (this.sandboxStore !== undefined) {
      const mode = this.effectiveSandboxMode(record);
      if (mode === "standar") {
        try {
          const sandbox = this.sandboxForRun(record, provider, workspace, plannedFallback);
          if (sandbox !== undefined) input.sandbox = sandbox;
        } catch (error) {
          const message = `Sandbox gagal disiapkan: ${errorMessage(error)}`;
          this.append(record, { type: "error", message });
          this.append(record, { type: "result", ok: false, error: message });
          this.setStatus(record, "gagal");
          record.settle();
          this.notify(record);
          return;
        }
      }
    }

    const commandEnv = this.commandEnvForRun(record);
    if (commandEnv !== undefined) {
      input.commandEnv = commandEnv;
    }

    if (this.blockSecretPaths || commandEnv !== undefined) {
      const allow = this.secretAllow;
      const root = allow === undefined ? undefined : this.cwdForMemory(record);
      input.secretGuard = (call) => {
        const verdict = checkSecretAccess(
          {
            toolName: call.toolName,
            toolInput: call.toolInput,
            cwd: record.info.cwd,
          },
          {
            ...(allow === undefined || root === undefined
              ? {}
              : { isAllowed: (abs: string) => allow.isAllowed(root, abs) }),
            ...(commandEnv === undefined ? {} : { commandEnv: { keys: commandEnv.keys, file: commandEnv.file } }),
          },
        );
        if (!verdict.blocked) return undefined;
        const rule = verdict.rule ?? "";
        const envPath = resolveSecretReadPath({
          toolName: call.toolName,
          toolInput: call.toolInput,
          cwd: record.info.cwd,
        });
        const envText = envPath === undefined ? undefined : this.readEnvForDisplay(envPath);
        this.audit(
          "rahasia-diblokir",
          `Akses ke berkas rahasia diblokir: ${call.toolName}`,
          record.info.id,
          {
            tool: call.toolName,
            aturan: rule,
            sub: call.agentId !== undefined,
            ...(envText === undefined ? {} : { tampilan: "disamarkan" }),
          },
        );
        if (envText !== undefined) {
          return {
            reason:
              "Berkas .env dibaca dengan nilai rahasia disamarkan (nilai disembunyikan oleh kebijakan rahasia, jangan minta pengguna menempelkannya kecuali benar-benar perlu). Isi:\n" +
              redactEnvFileText(envText),
            rule: verdict.rule,
          };
        }
        return { reason: verdict.reason ?? SECRET_BLOCK_REASON, rule: verdict.rule };
      };
    }

    if (this.mcpServers !== undefined) {
      const mcpServers = await this.mcpServersForRun();
      if (mcpServers !== undefined) {
        input.mcpServers = mcpServers;
      }
    }

    let closeMemory: (() => void) | undefined;
    const bridge = this.memoryBridge;
    if (bridge !== undefined) {
      try {
        const opened = await bridge.open({
          sessionId: record.info.id,
          // Memory proyek memakai repo asli + subdir asal agar sesi worktree berbagi memory.
          cwd: this.cwdForMemory(record),
          ...(record.info.workspaceId === undefined
            ? {}
            : { workspaceId: record.info.workspaceId }),
        });
        input.memory = opened.memory;
        closeMemory = opened.close;
      } catch {
        if (!this.memoryWarned) {
          this.memoryWarned = true;
          console.warn("Memory sesi tidak tersedia; sesi lanjut tanpa memory.");
        }
      }
    }

    record.turnActive = true;
    try {
      if (this.fallback === undefined) {
        await this.runPlain(record, input);
      } else {
        await this.runWithFallback(record, input, provider, plannedFallback);
      }
    } finally {
      record.turnActive = false;
      try {
        closeMemory?.();
      } catch {
        // Pencabutan token tidak boleh menggagalkan sesi.
      }
      if (record.info.status === "berjalan") {
        this.setStatus(record, "gagal");
      }
      // Giliran selesai: tak ada lagi pesan yang bisa diarahkan ke giliran ini.
      record.steer = undefined;
      record.settle();
      this.notify(record);
      this.reportTurnEnd(record);

      // "Kirim sekarang" atau ganti sandbox: giliran yang berjalan dihentikan
      // lalu pesan teratas antrean jadi giliran berikutnya; antrean tak
      // dibersihkan dan pesan lain tetap menunggu giliran sesudahnya.
      const sendNow = record.sendNowPending === true;
      record.sendNowPending = false;
      const aborted = record.controller.signal.aborted === true;
      // Potongan penantian saran: pesan yang masuk saat giliran selesai
      // menunggu saran harus diproses, bukan dibuang bersama antrean.
      const cut = record.suggestionCut === true;
      record.suggestionCut = false;
      const stopped =
        record.info.status === "dibatalkan" || record.info.status === "gagal";
      if (sendNow && aborted && record.queue.length > 0) {
        const next = record.queue.shift()!;
        record.info.queued = record.queue.length;
        this.startTurn(
          record,
          next.text,
          true,
          next.hidden === true ? "sistem" : undefined,
        );
      } else if (stopped && !cut) {
        this.clearQueue(record);
        this.finishGoalOnFailure(record);
      } else if (record.queue.length > 0) {
        // Antrean pengguna selalu didahulukan dari kelanjutan otomatis.
        const next = record.queue.shift()!;
        record.info.queued = record.queue.length;
        this.startTurn(record, next.text, true);
      } else {
        this.continueGoal(record);
      }
    }
  }

  private reportTurnEnd(record: SessionRecord): void {
    const hook = this.onTurnEnd;
    if (hook === undefined || record.info.status !== "selesai") return;
    void Promise.resolve(
      hook({
        sessionId: record.info.id,
        title: record.info.title,
        cwd: this.cwdForMemory(record),
        events: record.buffer.map((item) => item.event),
      }),
    ).catch(() => undefined);
  }

  /**
   * Event `session`: sesi SDK pertama dicatat. Setelah mundur, sesi hasil
   * fork menimpa `sdkSessionId` dan target mundur dibersihkan.
   */
  private handleSessionEvent(record: SessionRecord, sessionId: string): void {
    if (record.rewindTo !== undefined) {
      record.sdkSessionId = sessionId;
      record.rewindTo = undefined;
      this.persistSession(record);
      return;
    }
    if (record.sdkSessionId === undefined) {
      record.sdkSessionId = sessionId;
      this.persistSession(record);
    }
  }

  /**
   * Iterate event giliran dengan batas menunggu saran prompt.
   *
   * Setelah pesan `result` giliran selesai, tapi stream SDK masih membuka
   * jalan untuk saran prompt. Iterasi lalu dibatasi `suggestionWaitMs`;
   * lewat batas (atau saat giliran dihentikan) stream dihentikan lewat abort
   * yang sama dengan penghentian giliran biasa. Status sesi tak diubah dan
   * tak ada event baru yang dicatat.
   */
  private async *iterateTurn(
    record: SessionRecord,
    input: Parameters<AgentRunner["run"]>[0],
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const iterator = this.runner.run(input)[Symbol.asyncIterator]();
    const signal = record.controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    let batas: Promise<void> | undefined;

    const hentikan = (): void => {
      stop?.();
    };

    try {
      while (true) {
        const pending = iterator.next();
        if (batas === undefined) {
          const langkah = await pending;
          if (langkah.done) return;
          if (langkah.value.type === "result") {
            // Giliran selesai; saran prompt yang menyusul dibatasi waktunya.
            batas = new Promise<void>((resolve) => {
              stop = resolve;
              timer = setTimeout(resolve, this.suggestionWaitMs);
            });
            if (signal.aborted) hentikan();
            else signal.addEventListener("abort", hentikan, { once: true });
          }
          yield langkah.value;
          continue;
        }
        const tunggu = batas;
        const hasil = await Promise.race([
          pending.then((langkah) => ({ jenis: "event" as const, langkah })),
          tunggu.then(() => ({ jenis: "batas" as const })),
        ]);
        if (hasil.jenis === "batas") {
          // Batas habis atau giliran dihentikan: hentikan stream.
          this.stopTurn(record);
          return;
        }
        if (hasil.langkah.done) return;
        yield hasil.langkah.value;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", hentikan);
      // Tutup stream runner; penutupannya tak boleh menggagalkan giliran.
      void iterator.return?.(undefined);
    }
  }

  /** Hentikan giliran lewat abort yang sama dengan tombol hentikan. */
  private stopTurn(record: SessionRecord): void {
    if (record.controller.signal.aborted) return;
    record.controller.abort();
  }

  /** Jalur lama: event diteruskan apa adanya tanpa buffer/fallback. */
  private async runPlain(
    record: SessionRecord,
    input: Parameters<AgentRunner["run"]>[0],
  ): Promise<void> {
    let sawResult = false;
    try {
      for await (const event of this.iterateTurn(record, input)) {
        if (sawResult) {
          // Setelah `result` yang diterima hanya saran prompt; event lain
          // diabaikan supaya giliran tak dobel.
          if (event.type === "suggestion") this.append(record, event);
          continue;
        }
        if (event.type === "session") {
          this.handleSessionEvent(record, event.sessionId);
        }
        if (event.type === "result") {
          sawResult = true;
          if (record.price !== undefined) {
            event.estimatedCostUsd = estimateCostUsd(event, record.price);
          }
          this.append(record, event);
          this.setStatus(
            record,
            event.ok ? "selesai" : event.error === "dibatalkan" ? "dibatalkan" : "gagal",
          );
          // Stream diteruskan: saran prompt datang setelah `result`.
          continue;
        }
        this.append(record, event);
      }

      if (!sawResult) {
        this.append(record, { type: "error", message: "sesi berakhir tanpa hasil" });
        this.append(record, { type: "result", ok: false, error: "sesi berakhir tanpa hasil" });
        this.setStatus(record, "gagal");
      }
    } catch (error) {
      if (!sawResult) {
        const message = sanitizeText(errorMessage(error), record.apiKey) || "sesi gagal";
        this.append(record, { type: "error", message });
        this.append(record, { type: "result", ok: false, error: message });
        this.setStatus(record, "gagal");
      }
    }
  }

  /**
   * Satu percobaan giliran dengan buffer sampai output substantif pertama.
   * Kegagalan sebelum output substantif dikembalikan agar pemanggil bisa
   * memutuskan fallback; event tertahan baru ditulis saat gagal final.
   */
  private async runAttempt(
    record: SessionRecord,
    input: Parameters<AgentRunner["run"]>[0],
  ): Promise<AttemptOutcome> {
    const buffered: AgentEvent[] = [];
    let substantive = false;
    let sawResult = false;
    let lastErrorMessage: string | undefined;
    /** Hasil giliran yang sudah tercatat; setelah itu hanya saran prompt. */
    let outcome: AttemptOutcome | undefined;

    const flush = (): void => {
      for (const event of buffered.splice(0)) this.append(record, event);
    };
    // Permintaan izin datang lewat callback, bukan iterator: anggap substantif.
    record.flushPending = () => {
      substantive = true;
      flush();
    };

    try {
      for await (const event of this.iterateTurn(record, input)) {
        if (outcome !== undefined) {
          // Hasil sudah tercatat; yang diterima hanya saran prompt yang
          // datang setelah `result`.
          if (event.type === "suggestion") this.append(record, event);
          continue;
        }

        if (event.type === "session") {
          this.handleSessionEvent(record, event.sessionId);
          // Event sesi diteruskan langsung, bukan bagian buffer fallback.
          this.append(record, event);
          continue;
        }

        if (event.type === "result") {
          sawResult = true;
          if (record.price !== undefined) {
            event.estimatedCostUsd = estimateCostUsd(event, record.price);
          }
          if (event.ok || substantive) {
            flush();
            this.append(record, event);
            this.setStatus(
              record,
              event.ok ? "selesai" : event.error === "dibatalkan" ? "dibatalkan" : "gagal",
            );
            // Stream diteruskan sebentar: saran prompt datang setelah `result`.
            outcome = { kind: "selesai" };
            continue;
          }
          return {
            kind: "gagal",
            failure: {
              message: [event.error, lastErrorMessage]
                .filter((part): part is string => part !== undefined && part !== "")
                .join(" | "),
              events: [...buffered, event],
              hasResult: true,
              synthetic: false,
              substantive,
            },
          };
        }

        // SDK melaporkan galat API sebagai teks sintetis "API Error: ..." diikuti
        // result gagal generik; sebelum output nyata ini bukan jawaban model.
        if (!substantive && event.type === "text" && isSdkApiErrorText(event.text)) {
          lastErrorMessage = event.text;
          buffered.push(event);
          continue;
        }

        if (isSubstantiveEvent(event)) {
          substantive = true;
          flush();
          this.append(record, event);
          continue;
        }

        if (event.type === "error") {
          lastErrorMessage = event.message;
        }
        if (substantive) {
          this.append(record, event);
        } else {
          buffered.push(event);
        }
      }

      if (outcome !== undefined) return outcome;
      if (sawResult) return { kind: "selesai" };

      if (substantive) {
        this.append(record, { type: "error", message: "sesi berakhir tanpa hasil" });
        this.append(record, { type: "result", ok: false, error: "sesi berakhir tanpa hasil" });
        this.setStatus(record, "gagal");
        return { kind: "selesai" };
      }
      return {
        kind: "gagal",
        failure: {
          message: lastErrorMessage ?? "sesi berakhir tanpa hasil",
          events: buffered,
          hasResult: false,
          synthetic: true,
          substantive,
        },
      };
    } catch (error) {
      if (outcome !== undefined) return outcome;
      if (sawResult) return { kind: "selesai" };
      if (substantive) {
        const keys = [record.apiKey, ...(record.extraApiKeys ?? [])];
        const message = sanitizeTextKeys(errorMessage(error), keys) || "sesi gagal";
        this.append(record, { type: "error", message });
        this.append(record, { type: "result", ok: false, error: message });
        this.setStatus(record, "gagal");
        return { kind: "selesai" };
      }
      return {
        kind: "gagal",
        failure: {
          message: sanitizeTextKeys(errorMessage(error), [
            record.apiKey,
            ...(record.extraApiKeys ?? []),
          ]),
          events: buffered,
          hasResult: false,
          synthetic: false,
          substantive,
        },
      };
    } finally {
      record.flushPending = undefined;
    }
  }

  /** Perilaku gagal biasa: tulis event tertahan lalu hasil gagal. */
  private replayFailure(record: SessionRecord, failure: AttemptFailure): void {
    for (const event of failure.events) this.append(record, event);
    if (!failure.hasResult) {
      const message = failure.synthetic
        ? "sesi berakhir tanpa hasil"
        : sanitizeTextKeys(failure.message, [
            record.apiKey,
            ...(record.extraApiKeys ?? []),
          ]) || "sesi gagal";
      this.append(record, { type: "error", message });
      this.append(record, { type: "result", ok: false, error: message });
    }
    const cancelled =
      failure.hasResult &&
      failure.events.some(
        (event) => event.type === "result" && event.error === "dibatalkan",
      );
    this.setStatus(record, cancelled ? "dibatalkan" : "gagal");
  }

  /**
   * Jalur fallback: gagal oleh galat provider sebelum output substantif
   * mengulang SEKALI dengan profil cadangan; event gagal pertama dibuang.
   */
  private async runWithFallback(
    record: SessionRecord,
    input: Parameters<AgentRunner["run"]>[0],
    provider: ResolvedProvider,
    planned: ResolvedProvider | undefined,
  ): Promise<void> {
    // Bila ada profil cadangan, retry SDK dipersingkat agar fallback cepat.
    const hasFallback = planned !== undefined;
    const attempt = await this.runAttempt(
      record,
      hasFallback ? { ...input, maxRetries: FALLBACK_SDK_RETRIES } : input,
    );
    if (attempt.kind === "selesai") return;

    const failure = attempt.failure;
    if (failure.substantive || record.controller.signal.aborted) {
      this.replayFailure(record, failure);
      return;
    }
    const kind = classifyProviderError(failure.message);
    if (kind === undefined) {
      this.replayFailure(record, failure);
      return;
    }

    const fallbackProvider = planned;
    if (fallbackProvider === undefined || fallbackProvider.profileId === provider.profileId) {
      this.replayFailure(record, failure);
      return;
    }

    this.append(record, {
      type: "notice",
      text: `Profil ${provider.profileId} gagal (${describeFallbackReason(kind)}); memakai ${fallbackProvider.profileId}.`,
      level: "warn",
    });
    this.audit(
      "provider",
      `Fallback provider: ${provider.profileId} → ${fallbackProvider.profileId}`,
      record.info.id,
      { dari: provider.profileId, ke: fallbackProvider.profileId, alasan: kind },
    );

    const originalKey = provider.apiKey;
    const originalPrice = provider.price;
    record.apiKey = fallbackProvider.apiKey;
    if (fallbackProvider.price === undefined) {
      delete record.price;
    } else {
      record.price = fallbackProvider.price;
    }
    record.extraApiKeys = originalKey === undefined ? [] : [originalKey];

    try {
      const retry = await this.runAttempt(record, { ...input, provider: fallbackProvider });
      if (retry.kind === "gagal") this.replayFailure(record, retry.failure);
    } finally {
      record.apiKey = originalKey;
      if (originalPrice === undefined) {
        delete record.price;
      } else {
        record.price = originalPrice;
      }
      record.extraApiKeys = undefined;
    }
  }

  /** Mode sandbox efektif sesi: pilihan tersimpan, lalu default global. */
  private effectiveSandboxMode(record: SessionRecord): SandboxMode {
    const store = this.sandboxStore;
    if (store === undefined) return "standar";
    if (record.info.sandbox !== undefined) return record.info.sandbox;
    try {
      return store.get().mode;
    } catch {
      return "standar";
    }
  }

  /** Petunjuk perbaikan bila giliran gagal karena sandbox tak tersedia. */
  private withSandboxHint(record: SessionRecord, event: AgentEvent): AgentEvent {
    if (this.sandboxStore === undefined) return event;
    if (event.type !== "error" && event.type !== "result") return event;
    if (this.effectiveSandboxMode(record) !== "standar") return event;
    const hint = describeSandboxFailure(
      event.type === "error" ? event.message : (event.error ?? ""),
    );
    if (hint === undefined) return event;
    if (event.type === "error") {
      return { ...event, message: `${event.message}${hint}` };
    }
    return { ...event, error: `${event.error ?? ""}${hint}` };
  }

  private append(record: SessionRecord, event: AgentEvent): void {
    event = this.withSandboxHint(record, event);
    const sanitized = sanitizeEventKeys(event, [
      record.apiKey,
      ...(record.extraApiKeys ?? []),
    ]);

    // Penyamaran hanya untuk yang disimpan/disiarkan; `event` asli tetap dipakai
    // untuk akumulasi usage di bawah agar perilaku lama tidak berubah.
    let storedEvent = sanitized;
    if (this.secretsMode !== "off") {
      try {
        const redacted = redactEvent(sanitized, [
          ...this.envValuesFor(record),
          ...(record.commandEnvValues ?? []),
        ]);
        if (this.secretsMode === "redact") {
          storedEvent = redacted.event;
        }
        if (redacted.hits.length > 0) {
          record.info.redactedEvents = (record.info.redactedEvents ?? 0) + 1;
          const jenis = describeHits(redacted.hits);
          this.audit(
            "rahasia-disamarkan",
            this.secretsMode === "redact"
              ? `Rahasia disamarkan pada event ${sanitized.type}`
              : `Rahasia terdeteksi pada event ${sanitized.type} (tidak disamarkan)`,
            record.info.id,
            { eventType: sanitized.type, mode: this.secretsMode, jenis },
          );
        }
      } catch {
        // Penyamaran gagal tidak boleh menggagalkan sesi.
      }
    }

    if (isTransientEvent(event)) {
      // Transien: disiarkan ke pelanggan tetapi tidak disimpan ke DB maupun dihitung.
      record.buffer.push({ seq: record.nextSeq, event: storedEvent });
      record.nextSeq += 1;
      this.notify(record);
      return;
    }
    // Event nyata menggantikan delta yang sedang mengalir.
    if (record.buffer.some((item) => item.event.type === "text_delta")) {
      record.buffer = record.buffer.filter((item) => item.event.type !== "text_delta");
    }

    const stored: SequencedEvent = {
      seq: record.nextSeq,
      event: storedEvent,
    };
    record.nextSeq += 1;
    record.buffer.push(stored);
    const trimmed = record.buffer.length > this.maxEventsPerSession;
    if (trimmed) {
      record.buffer.splice(0, record.buffer.length - this.maxEventsPerSession);
    }
    record.info.eventCount += 1;
    record.info.updatedAt = this.now().toISOString();
    this.storeGuard(() => this.store?.appendEvent(record.info.id, stored));
    if (trimmed) {
      const oldest = record.buffer[0]?.seq ?? record.nextSeq;
      this.storeGuard(() => this.store?.trimEvents(record.info.id, oldest));
    }

    if (event.type === "tool_call") {
      // Tool call dihitung untuk deteksi "tanpa kemajuan" pada mode Goal.
      if (record.turn !== undefined) record.turn.toolCalls += 1;
      this.audit("tool", `${event.name}: ${toolSummary(event.input)}`, record.info.id, {
        tool: event.name,
        sub: event.parentToolUseId !== undefined,
      });
    }

    // Pelanggaran sandbox dilaporkan SDK sebagai teks di hasil tool Bash.
    if (event.type === "tool_result" && event.output.includes("<sandbox_violations>")) {
      const violations = extractSandboxViolations(event.output);
      if (violations.length > 0) {
        this.audit(
          "sandbox",
          `Sandbox menolak: ${(violations[0] ?? "").slice(0, 200)}`,
          record.info.id,
          { jumlah: violations.length },
        );
      }
    }

    // Accumulate usage for result events
    if (event.type === "result") {
      if (event.inputTokens !== undefined || event.outputTokens !== undefined || event.cacheReadTokens !== undefined || event.cacheWriteTokens !== undefined) {
        if (record.info.usage === undefined) {
          record.info.usage = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          };
        }
        if (event.inputTokens !== undefined) {
          record.info.usage.inputTokens += event.inputTokens;
        }
        if (event.outputTokens !== undefined) {
          record.info.usage.outputTokens += event.outputTokens;
        }
        if (event.cacheReadTokens !== undefined) {
          record.info.usage.cacheReadTokens += event.cacheReadTokens;
        }
        if (event.cacheWriteTokens !== undefined) {
          record.info.usage.cacheWriteTokens += event.cacheWriteTokens;
        }
        if (event.estimatedCostUsd !== undefined) {
          if (record.info.usage.estimatedCostUsd === undefined) {
            record.info.usage.estimatedCostUsd = 0;
          }
          record.info.usage.estimatedCostUsd += event.estimatedCostUsd;
        }
        if (event.costUsd !== undefined) {
          if (record.info.usage.sdkCostUsd === undefined) {
            record.info.usage.sdkCostUsd = 0;
          }
          record.info.usage.sdkCostUsd += event.costUsd;
        }
      }
      this.applyBudget(record, event);
    }

    this.persistSession(record);
    this.notify(record);
  }

  private setStatus(record: SessionRecord, status: SessionStatus): void {
    const previous = record.info.status;
    record.info.status = status;
    if (previous === "berjalan" && status !== "berjalan") {
      this.audit("sesi-berhenti", "Sesi berhenti", record.info.id, {
        status,
        turns: record.turns,
      });
    }
    this.persistSession(record);
    this.notify(record);
  }

  private notify(record: SessionRecord): void {
    record.version += 1;
    for (const listener of Array.from(record.listeners)) {
      listener();
    }
  }

  /**
   * Apakah mode izin sesi saat ini menyetujui tool ini tanpa bertanya.
   * Rencana dan pertanyaan agent selalu butuh keputusan pengguna.
   */
  private autoAllowedByMode(record: SessionRecord, name: string): boolean {
    if (name === "ExitPlanMode" || name === "AskUserQuestion") return false;
    const mode = record.info.permissionMode;
    if (mode === "bypassPermissions") return this.allowBypass;
    if (mode === "acceptEdits") return EDIT_TOOL_NAMES.has(name);
    return false;
  }

  /** Setujui izin yang sedang menunggu bila mode baru sudah mengizinkannya. */
  private flushPendingByMode(record: SessionRecord): void {
    for (const [requestId, pending] of Array.from(record.pending)) {
      if (!this.autoAllowedByMode(record, pending.name)) continue;
      this.resolvePermission(record.info.id, requestId, "allow").catch(() => {});
    }
  }

  private generateRequestId(): string {
    return crypto.randomUUID();
  }

  private async requestPermission(
    record: SessionRecord,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    // Permintaan izin adalah output substantif: hentikan buffer fallback.
    record.flushPending?.();

    // Mode diganti di tengah giliran: SDK masih memakai mode lamanya dan tetap
    // bertanya, jadi keputusan mengikuti mode sesi saat ini.
    if (this.autoAllowedByMode(record, request.name)) {
      this.audit("izin", `Izin diizinkan otomatis (mode): ${request.name}`, record.info.id, {
        tool: request.name,
        decision: "diizinkan",
        alasan: "mode",
      });
      return { behavior: "allow" };
    }

    const requestId = this.generateRequestId();

    // Create a promise that resolves when the permission is granted or denied
    const pending: Pending = {
      resolve: () => {},
      name: request.name,
      input: request.input,
    };

    const promise = new Promise<PermissionDecision>((resolve) => {
      pending.resolve = resolve;
      record.pending.set(requestId, pending);

      // Update pendingPermissions count
      record.info.pendingPermissions += 1;
      record.info.updatedAt = this.now().toISOString();
      this.persistSession(record);
      this.notify(record);
    });

    // Add event to buffer
    const permissionRequestEvent: AgentEvent = {
      type: "permission_request",
      id: requestId,
      toolUseId: request.toolUseId,
      name: request.name,
      input: request.input,
      expiresAt: new Date(this.now().getTime() + record.permissionTimeoutMs).toISOString(),
    };

    this.append(record, permissionRequestEvent);
    this.audit("izin", `Izin diminta: ${request.name}`, record.info.id, {
      tool: request.name,
      decision: "diminta",
    });

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (record.pending.has(requestId)) {
        const denyEvent: AgentEvent = {
          type: "permission_resolved",
          id: requestId,
          decision: "deny",
          message: PERMISSION_EXPIRED_MESSAGE,
        };

        record.pending.delete(requestId);
        record.info.pendingPermissions -= 1;
        record.info.updatedAt = this.now().toISOString();
        this.persistSession(record);
        this.notify(record);

        this.append(record, denyEvent);
        this.audit("izin", `Izin ditolak: ${pending.name}`, record.info.id, {
          tool: pending.name,
          decision: "ditolak",
          alasan: "kedaluwarsa",
        });

        pending.resolve({ behavior: "deny", message: PERMISSION_EXPIRED_MESSAGE });
      }
    }, record.permissionTimeoutMs);

    // Set up abort handler
    const abortHandler = (): void => {
      if (record.pending.has(requestId)) {
        const denyEvent: AgentEvent = {
          type: "permission_resolved",
          id: requestId,
          decision: "deny",
          message: PERMISSION_STOPPED_MESSAGE,
        };

        record.pending.delete(requestId);
        record.info.pendingPermissions -= 1;
        record.info.updatedAt = this.now().toISOString();
        this.persistSession(record);
        this.notify(record);

        this.append(record, denyEvent);
        this.audit("izin", `Izin ditolak: ${pending.name}`, record.info.id, {
          tool: pending.name,
          decision: "ditolak",
          alasan: "dihentikan",
        });

        pending.resolve({ behavior: "deny", message: PERMISSION_STOPPED_MESSAGE });
      }
      clearTimeout(timeoutId);
    };

    record.controller.signal.addEventListener("abort", abortHandler, { once: true });

    try {
      return await promise;
    } finally {
      // Clean up abort handler
      record.controller.signal.removeEventListener("abort", abortHandler);
      clearTimeout(timeoutId);
    }
  }

  async resolvePermission(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
    answers?: Record<string, string>,
  ): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new SessionError("sesi tidak ditemukan", "tidak-ditemukan");
    }

    const pending = record.pending.get(requestId);
    if (pending === undefined) {
      // Izin tak ada di antrean memori: mungkin sesi sempat terputus dan
      // permintaannya ditutup saat pemulihan.
      await this.resolveOrphanPermission(record, requestId, decision, message, answers);
      return;
    }

    // Remove from pending map
    record.pending.delete(requestId);

    // Update pendingPermissions count
    record.info.pendingPermissions -= 1;
    record.info.updatedAt = this.now().toISOString();
    this.persistSession(record);
    this.notify(record);

    // Create resolved event
    const resolvedEvent: Extract<AgentEvent, { type: "permission_resolved" }> = {
      type: "permission_resolved",
      id: requestId,
      decision,
      message: message ? collapseWhitespace(message).substring(0, 200) : undefined,
    };
    if (decision === "allow" && pending.name === "AskUserQuestion" && answers !== undefined) {
      resolvedEvent.answers = answers;
    }

    this.append(record, resolvedEvent);
    this.audit(
      "izin",
      `Izin ${decision === "allow" ? "diizinkan" : "ditolak"}: ${pending.name}`,
      record.info.id,
      { tool: pending.name, decision: decision === "allow" ? "diizinkan" : "ditolak" },
    );

    // Resolve the pending promise
    if (decision === "allow") {
      if (pending.name === "AskUserQuestion" && answers !== undefined) {
        // Jawaban pengguna dikembalikan ke SDK sebagai `answers` (pertanyaan -> label).
        const base =
          typeof pending.input === "object" && pending.input !== null && !Array.isArray(pending.input)
            ? (pending.input as Record<string, unknown>)
            : {};
        pending.resolve({ behavior: "allow", updatedInput: { ...base, answers } });
      } else {
        pending.resolve({ behavior: "allow" });
      }
    } else {
      pending.resolve({
        behavior: "deny",
        message: message ? collapseWhitespace(message).substring(0, 200) : "ditolak pengguna",
      });
    }
  }

  /**
   * Jalur yatim: izin yang sudah ada di log sesi tapi prosesnya mati.
   *
   * Permintaan ditutup saat pemulihan dengan status "terputus", jadi tak ada
   * antrean memori. Keputusan pengguna diterjemahkan jadi pesan lanjutan yang
   * dikirim ke sesi; izin tool biasa tak pernah disetujui otomatis.
   */
  private async resolveOrphanPermission(
    record: SessionRecord,
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
    answers?: Record<string, string>,
  ): Promise<void> {
    if (record.info.status === "berjalan") {
      throw new SessionError("izin tidak ditemukan atau sudah diputuskan", "tidak-ditemukan");
    }

    const events = this.sessionEvents(record);
    const index = events.findIndex(
      (item) => item.event.type === "permission_request" && item.event.id === requestId,
    );
    if (index === -1) {
      throw new SessionError("izin tidak ditemukan atau sudah diputuskan", "tidak-ditemukan");
    }
    const request = events[index]!.event;
    if (request.type !== "permission_request") {
      throw new SessionError("izin tidak ditemukan atau sudah diputuskan", "tidak-ditemukan");
    }

    // Izin harus berstatus "terputus": ditutup saat pemulihan, bukan diputuskan.
    const sesudah = events.slice(index + 1);
    const terputus = sesudah.some(
      (item) =>
        item.event.type === "permission_resolved" &&
        item.event.id === requestId &&
        item.event.message === PERMISSION_INTERRUPTED_MESSAGE,
    );
    if (!terputus) {
      throw new SessionError("izin tidak ditemukan atau sudah diputuskan", "tidak-ditemukan");
    }

    // Usang: ada giliran atau pesan baru sesudah permintaan (bukan event
    // pemulihan), artinya sesi sudah berjalan lagi.
    if (sesudah.some((item) => !this.isRecoveryEvent(item.event))) {
      throw new SessionError("Izin ini sudah usang; sesi sudah berlanjut.", "konflik");
    }

    const name = request.name;
    if (name === "ExitPlanMode") {
      await this.resumePlanPermission(record, decision, message);
    } else if (name === "AskUserQuestion") {
      await this.resumeQuestionPermission(record, decision, answers);
    } else {
      // Izin tool biasa tak pernah disetujui dari jalur yatim.
      throw new SessionError(
        "Sesi terputus; pilih Lanjutkan sesi agar agent mengulang pekerjaannya dan meminta izin lagi.",
        "konflik",
      );
    }

    // Catat keputusan sebenarnya supaya kartu berubah jadi Diizinkan/Ditolak.
    const resolvedEvent: Extract<AgentEvent, { type: "permission_resolved" }> = {
      type: "permission_resolved",
      id: requestId,
      decision,
      message: message ? collapseWhitespace(message).substring(0, 200) : undefined,
    };
    if (decision === "allow" && name === "AskUserQuestion" && answers !== undefined) {
      resolvedEvent.answers = answers;
    }
    this.append(record, resolvedEvent);
    this.audit(
      "izin",
      `Izin ${decision === "allow" ? "diizinkan" : "ditolak"}: ${name}`,
      record.info.id,
      { tool: name, decision: decision === "allow" ? "diizinkan" : "ditolak" },
    );
  }

  /**
   * Rencana yang disetujui (atau perlu direvisi) setelah sesi terputus.
   *
   * Persetujuan mengubah mode izin dari `plan` ke `default`; penolakan
   * membiarkan mode tetap agar agent menyusun ulang rencana.
   */
  private async resumePlanPermission(
    record: SessionRecord,
    decision: "allow" | "deny",
    message?: string,
  ): Promise<void> {
    if (decision === "allow") {
      if (record.info.permissionMode === "plan") {
        this.setPermissionMode(record.info.id, "default");
      }
      await this.send(
        record.info.id,
        "Rencana yang kamu ajukan sudah disetujui. Lanjutkan implementasi sesuai rencana itu.",
      );
      return;
    }
    const catatan = message === undefined || message.trim() === ""
      ? "Rencana ditolak; susun ulang."
      : `Rencana perlu direvisi: ${collapseWhitespace(message)}. Susun ulang rencananya sesuai catatan itu lalu ajukan lagi.`;
    await this.send(record.info.id, catatan);
  }

  /** Jawaban pertanyaan agent yang sempat menggantung saat sesi terputus. */
  private async resumeQuestionPermission(
    record: SessionRecord,
    decision: "allow" | "deny",
    answers?: Record<string, string>,
  ): Promise<void> {
    if (decision === "deny") {
      await this.send(record.info.id, "Pengguna melewati pertanyaan tadi.");
      return;
    }
    const baris = Object.entries(answers ?? {}).map(
      ([pertanyaan, jawaban]) => `${pertanyaan} → ${jawaban}`,
    );
    const isi =
      baris.length === 0
        ? "Jawaban untuk pertanyaanmu sebelum sesi terputus: (tidak ada jawaban)"
        : `Jawaban untuk pertanyaanmu sebelum sesi terputus:\n${baris.join("\n")}`;
    await this.send(record.info.id, isi);
  }

  /** Event yang dibuat saat pemulihan; bukan giliran baru. */
  private isRecoveryEvent(event: AgentEvent): boolean {
    if (event.type === "permission_resolved") {
      return event.message === PERMISSION_INTERRUPTED_MESSAGE;
    }
    if (event.type === "error") return event.message === RECOVERY_ERROR_MESSAGE;
    if (event.type === "result") return event.error === RECOVERY_ERROR_MESSAGE;
    return false;
  }

  /**
   * Seluruh event log sesi; dari penyimpanan bila ada, kalau tidak dari
   * buffer di memori.
   */
  private sessionEvents(record: SessionRecord): SequencedEvent[] {
    const store = this.store;
    if (store !== undefined) {
      try {
        const loaded = store.loadEvents(record.info.id);
        if (loaded.length > 0) return loaded;
      } catch {
        // Penyimpanan tak terbaca; pakai buffer di memori.
      }
    }
    return record.buffer;
  }

  /**
   * Lanjutkan sesi yang terputus karena aplikasi berhenti.
   *
   * Hanya untuk sesi tak-berjalan yang punya riwayat SDK: pesan dikirim
   * sebagai giliran biasa sehingga agent mengulang pekerjaannya.
   */
  async continue(id: string): Promise<{ queued: boolean }> {
    const record = this.sessions.get(id);
    if (record === undefined) {
      throw new SessionError(`Sesi "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    if (record.info.status === "berjalan") {
      throw new SessionError("Sesi sedang berjalan.", "konflik");
    }
    return this.send(id, CONTINUE_MESSAGE);
  }
}
