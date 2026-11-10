import { existsSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  PERMISSION_EXPIRED_MESSAGE,
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
  type ProviderErrorKind,
} from "../agent/provider-error";
import type { AuditKind, AuditMeta, AuditStore } from "../audit/audit-store";
import type { ClaudeConfigStore } from "../claude-config/config-store";
import { listSkills } from "../claude-config/skills";
import {
  evaluateBudget,
  formatUsd,
  localDayStartIso,
  type BudgetLevel,
} from "../budget/budget";
import type { BudgetStore } from "../budget/budget-store";
import type { UsageLedger } from "../budget/usage-ledger";
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
import { SECRET_BLOCK_REASON, checkSecretAccess } from "../security/secret-paths";
import type { SecretAllowStore } from "../security/secret-allow-store";
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
}

export interface SequencedEvent {
  seq: number;
  event: AgentEvent;
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
  store?: SessionStore;
  memoryBridge?: MemoryBridge;
  checkpoints?: SessionManagerCheckpoints;
  workspaces?: WorkspaceResolver;
  /** Server MCP eksternal; dibaca ulang tiap giliran. */
  mcpServers?: McpServerResolver;
  /** Layanan worktree; tanpa opsi ini `worktree: true` ditolak. */
  worktrees?: WorktreeService;
  /** Default `true`; `false` menolak semua sesi bermode bypass. */
  allowBypass?: boolean;
  /** Dipanggil setelah sesi dibuang (hapus manual maupun eviksi). Galatnya ditelan. */
  onSessionDeleted?: (id: string) => void | Promise<void>;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan audit. */
  audit?: AuditStore;
  /** Pengaturan sumber Claude; tanpa store `input.claude` tidak diisi. */
  claude?: ClaudeConfigStore;
  /** Sandbox Bash; tanpa store `input.sandbox` tidak diisi. */
  sandbox?: { store: SandboxStore; home?: string };
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
  queue: string[];
  /** Jumlah giliran yang sudah dimulai; giliran pertama = 1. */
  turns: number;
  /** Peringatan workspace tak tersedia hanya sekali per sesi. */
  workspaceWarned?: boolean;
  /** Nilai rahasia dari `.env` sesi; dimuat malas dan tidak dipersist. */
  envValues?: readonly string[];
  /** Penyalur event yang tertahan sebelum output substantif (mode fallback). */
  flushPending?: () => void;
  /** Kunci tambahan yang ikut disanitasi dari event (kunci profil asal saat fallback). */
  extraApiKeys?: readonly string[];
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

const CHECKPOINT_TIMEOUT_MS = 30_000;

const MAX_QUEUED_MESSAGES = 5;

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

function isSubstantiveEvent(event: AgentEvent): boolean {
  return (
    event.type === "text" ||
    event.type === "thinking" ||
    event.type === "tool_call" ||
    event.type === "permission_request"
  );
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
  private readonly store: SessionStore | undefined;
  private readonly memoryBridge: MemoryBridge | undefined;
  private readonly checkpoints: SessionManagerCheckpoints | undefined;
  private readonly workspaces: WorkspaceResolver | undefined;
  private readonly mcpServers: McpServerResolver | undefined;
  private readonly worktrees: WorktreeService | undefined;
  private readonly allowBypass: boolean;
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
    this.store = options.store;
    this.memoryBridge = options.memoryBridge;
    this.checkpoints = options.checkpoints;
    this.workspaces = options.workspaces;
    this.mcpServers = options.mcpServers;
    this.worktrees = options.worktrees;
    this.allowBypass = options.allowBypass ?? true;
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
    const store = this.claudeConfig;
    if (store === undefined) return undefined;
    try {
      const config = store.get();
      const projectRoot = this.cwdForMemory(record);
      const disabled = store.disabledFor(projectRoot);
      const result: RunClaudeConfig = {
        userSettings: config.userSettings,
        hooksEnabled: config.hooksEnabled,
      };
      if (disabled.length > 0) {
        const found = listSkills(projectRoot, this.home, disabled);
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
   * Opsi sandbox untuk satu giliran. Mode efektif: pilihan sesi, lalu default
   * global. Galat TIDAK ditelan: pemanggil menggagalkan giliran secara tertutup
   * kecuali mode `mati`.
   */
  private sandboxForRun(
    record: SessionRecord,
    provider: ResolvedProvider,
    workspace: RunWorkspace | undefined,
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
      providerHosts: providerHostsFrom(provider.baseUrl),
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
      try {
        buffer = store.loadEvents(item.info.id).slice(-this.maxEventsPerSession);
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
      this.sessions.set(record.info.id, record);

      if (record.info.status === "berjalan") {
        record.info.status = "gagal";
        this.append(record, { type: "error", message: "server dimulai ulang saat sesi berjalan" });
        this.append(record, {
          type: "result",
          ok: false,
          error: "server dimulai ulang saat sesi berjalan",
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

  list(): SessionInfo[] {
    return Array.from(this.sessions.values())
      .reverse()
      .map((record) => this.viewInfo(record.info));
  }

  get(id: string): SessionInfo | undefined {
    const record = this.sessions.get(id);
    return record === undefined ? undefined : this.viewInfo(record.info);
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
  private viewInfo(info: SessionInfo): SessionInfo {
    const copy: SessionInfo = { ...info };
    if (info.worktree !== undefined) {
      copy.worktree = {
        ...info.worktree,
        missing: !existsSync(info.worktree.path),
      };
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
    return { ...record.info };
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
    return { ...record.info };
  }

  /** Hapus sesi beserta event, checkpoint, dan snapshot undo (lewat hook). */
  delete(id: string): void {
    const record = this.requireRecord(id);
    if (record.info.status === "berjalan") {
      throw new SessionError("Hentikan sesi dulu.", "konflik");
    }
    this.dropSession(record);
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

      if (record.info.status !== "berjalan") return;
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

    if (record.info.status === "berjalan") {
      if (record.queue.length >= MAX_QUEUED_MESSAGES) {
        throw new SessionError(
          `Antrean pesan penuh; maksimal ${MAX_QUEUED_MESSAGES} pesan.`,
          "penuh",
        );
      }
      record.queue.push(message);
      record.info.queued = record.queue.length;
      this.persistSession(record);
      this.notify(record);
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

  private startTurn(record: SessionRecord, text: string, isFollowUp: boolean): void {
    record.controller = new AbortController();
    let settle: () => void = () => {};
    record.done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    record.settle = settle;
    record.turns += 1;

    this.setStatus(record, "berjalan");
    if (isFollowUp) {
      this.append(record, { type: "user_message", text });
    }

    const resolved = record.resolved;
    if (resolved === undefined) {
      this.append(record, { type: "error", message: "provider belum diselesaikan" });
      this.append(record, { type: "result", ok: false, error: "provider belum diselesaikan" });
      this.setStatus(record, "gagal");
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
    };
    if (resumeSessionId !== undefined) {
      input.resumeSessionId = resumeSessionId;
    }
    const claude = this.claudeForRun(record);
    if (claude !== undefined) {
      input.claude = claude;
    }
    let workspace: RunWorkspace | undefined;
    if (record.info.workspaceId !== undefined && this.workspaces !== undefined) {
      workspace = await this.workspaceForRun(record);
      if (workspace !== undefined) {
        input.workspace = workspace;
      }
    }

    // Sandbox gagal-tertutup: bila opsi tak bisa dibangun, giliran gagal alih-alih
    // berjalan tanpa sandbox (kecuali mode `mati` yang memang tanpa opsi).
    if (this.sandboxStore !== undefined) {
      const mode = this.effectiveSandboxMode(record);
      if (mode === "standar") {
        try {
          const sandbox = this.sandboxForRun(record, provider, workspace);
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

    if (this.blockSecretPaths) {
      const allow = this.secretAllow;
      const root = allow === undefined ? undefined : this.cwdForMemory(record);
      input.secretGuard = (call) => {
        const verdict = checkSecretAccess(
          {
            toolName: call.toolName,
            toolInput: call.toolInput,
            cwd: record.info.cwd,
          },
          allow === undefined || root === undefined
            ? {}
            : { isAllowed: (abs) => allow.isAllowed(root, abs) },
        );
        if (!verdict.blocked) return undefined;
        const rule = verdict.rule ?? "";
        this.audit(
          "rahasia-diblokir",
          `Akses ke berkas rahasia diblokir: ${call.toolName}`,
          record.info.id,
          { tool: call.toolName, aturan: rule, sub: call.agentId !== undefined },
        );
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

    try {
      if (this.fallback === undefined) {
        await this.runPlain(record, input);
      } else {
        await this.runWithFallback(record, input, provider);
      }
    } finally {
      try {
        closeMemory?.();
      } catch {
        // Pencabutan token tidak boleh menggagalkan sesi.
      }
      if (record.info.status === "berjalan") {
        this.setStatus(record, "gagal");
      }
      record.settle();
      this.notify(record);

      if (record.info.status === "dibatalkan" || record.info.status === "gagal") {
        this.clearQueue(record);
      } else if (record.queue.length > 0) {
        const next = record.queue.shift()!;
        record.info.queued = record.queue.length;
        this.startTurn(record, next, true);
      }
    }
  }

  /** Jalur lama: event diteruskan apa adanya tanpa buffer/fallback. */
  private async runPlain(
    record: SessionRecord,
    input: Parameters<AgentRunner["run"]>[0],
  ): Promise<void> {
    let sawResult = false;
    try {
      for await (const event of this.runner.run(input)) {
        if (event.type === "session" && record.sdkSessionId === undefined) {
          record.sdkSessionId = event.sessionId;
          this.persistSession(record);
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
          return;
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

    const flush = (): void => {
      for (const event of buffered.splice(0)) this.append(record, event);
    };
    // Permintaan izin datang lewat callback, bukan iterator: anggap substantif.
    record.flushPending = () => {
      substantive = true;
      flush();
    };

    try {
      for await (const event of this.runner.run(input)) {
        if (event.type === "session") {
          if (record.sdkSessionId === undefined) {
            record.sdkSessionId = event.sessionId;
            this.persistSession(record);
          }
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
            return { kind: "selesai" };
          }
          return {
            kind: "gagal",
            failure: {
              message: event.error ?? "",
              events: [...buffered, event],
              hasResult: true,
              synthetic: false,
              substantive,
            },
          };
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
  ): Promise<void> {
    const attempt = await this.runAttempt(record, input);
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

    let fallbackProvider: ResolvedProvider | undefined;
    try {
      fallbackProvider = await this.fallback!(provider.profileId);
    } catch {
      fallbackProvider = undefined;
    }
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
        const redacted = redactEvent(sanitized, this.envValuesFor(record));
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

  private generateRequestId(): string {
    return crypto.randomUUID();
  }

  private async requestPermission(
    record: SessionRecord,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    // Permintaan izin adalah output substantif: hentikan buffer fallback.
    record.flushPending?.();

    const requestId = this.generateRequestId();

    // Create a promise that resolves when the permission is granted or denied
    const pending: Pending = {
      resolve: () => {},
      name: request.name,
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

  resolvePermission(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
  ): void {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new SessionError("sesi tidak ditemukan", "tidak-ditemukan");
    }

    const pending = record.pending.get(requestId);
    if (pending === undefined) {
      throw new SessionError("izin tidak ditemukan atau sudah diputuskan", "tidak-ditemukan");
    }

    // Remove from pending map
    record.pending.delete(requestId);

    // Update pendingPermissions count
    record.info.pendingPermissions -= 1;
    record.info.updatedAt = this.now().toISOString();
    this.persistSession(record);
    this.notify(record);

    // Create resolved event
    const resolvedEvent: AgentEvent = {
      type: "permission_resolved",
      id: requestId,
      decision,
      message: message ? collapseWhitespace(message).substring(0, 200) : undefined,
    };

    this.append(record, resolvedEvent);
    this.audit(
      "izin",
      `Izin ${decision === "allow" ? "diizinkan" : "ditolak"}: ${pending.name}`,
      record.info.id,
      { tool: pending.name, decision: decision === "allow" ? "diizinkan" : "ditolak" },
    );

    // Resolve the pending promise
    if (decision === "allow") {
      pending.resolve({ behavior: "allow" });
    } else {
      pending.resolve({
        behavior: "deny",
        message: message ? collapseWhitespace(message).substring(0, 200) : "ditolak pengguna",
      });
    }
  }
}
