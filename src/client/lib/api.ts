import type { AuditEntry, AuditSummary } from "../../server/audit/audit-store";
import type { AuthStatus } from "./auth";
import type { PasswordStatus } from "./password-form";
import { parseNetworkStatus, type NetworkStatus } from "./network-form";
import { parseTunnelStatus, type TunnelStatus } from "./tunnel-form";
import type {
  ChangeAction,
  CheckpointChange,
  CheckpointItem,
  CheckpointKind,
  ListCheckpointsResult,
  PreviewResult,
  RewindResult,
} from "../../server/checkpoints/checkpoint-service";
import type { BrowseResult } from "../../server/files/browse";
import type { Changes } from "../../server/files/changes";
import type { DirectoryListing } from "../../server/files/list";
import type { FileContent } from "../../server/files/read";
import type { SearchResult } from "../../server/files/search";
import type { GitCommit, GitStatus } from "../../server/git/git-read";
import type { GitCommitResult } from "../../server/git/git-write";
import type { WorktreeInfo, WorktreeInspect } from "../../server/git/worktree-service";
import type { McpProblem, McpServerView, McpTransport } from "../../server/mcp/mcp-config";
import type { McpTestResult } from "../../server/mcp/mcp-tester";
import type { MemoryCounts, MemoryProblem } from "../../server/memory/memory-index";
import type {
  Memory,
  MemoryLayer,
  MemoryStatus,
} from "../../server/memory/memory-files";
import type { ImportResult } from "../../server/memory/memory-service";
import type { ClaudeMemoryResponse } from "../../server/memory/claude-memory";
import {
  parseClaudeMemoryResponse,
  parseClaudeMemorySyncRun,
  parseClaudeMemorySyncState,
  type ClaudeMemorySyncRun,
  type ClaudeMemorySyncState,
} from "./claude-memory";
import type { HookInfo } from "../../server/claude-config/hooks";
import type { InstructionFile } from "../../server/claude-config/instructions";
import type { PluginInfo } from "../../server/claude-config/plugins";
import type {
  MarketplaceInfo,
  MarketplacePlugin,
  MarketplaceSearchOptions,
  MarketplaceSearchResult as ServerMarketplaceSearchResult,
  PluginSourceKind,
} from "../../server/claude-config/marketplace";
import type { TerminalInfo } from "../../server/terminal/terminal-manager";
import type { RunnerCommand } from "../../server/runner/runner-service";
import type { RemoteRepo } from "../../server/gitprovider/adapters";
import type { GitProviderView } from "../../server/gitprovider/provider-store";
import type { IndexedRepo } from "../../server/indexer/repo-indexer";
import type { Question } from "../../server/questions/question-store";
import type { AgentInfo } from "../../server/claude-config/agents";
import type { SkillInfo } from "../../server/claude-config/skills";
import type { CommandInfo } from "../../server/agent/events";
import type { CommandSource } from "../../server/sessions/command-catalog";
import type { CreateSessionInput, SessionInfo } from "../../server/sessions/session-manager";
import type { ScheduleSpec } from "../../server/sessions/schedule-time";
import type { ScheduledTask } from "../../server/sessions/scheduled-tasks";
import type { GoalView } from "../../server/goals/goal";
import type {
  UsageDayBucket,
  UsageModelBucket,
  UsageProfileBucket,
  UsageSessionBucket,
  UsageSummary,
} from "../../server/budget/usage-ledger";
import type {
  ServiceCard,
  ServiceKind,
  WorkspaceProblem,
  WorkspaceRepo,
} from "../../server/workspaces/workspace-files";
import type { WorkspaceView } from "../../server/workspaces/workspace-service";
import type { WikiPage, WikiPageRef, WikiProject, WikiSync } from "./wiki";
import { parseFeatureStatus, type FeatureName, type FeatureStatus } from "./features";

export type AuditEntryItem = AuditEntry;
export type AuditSummaryResult = AuditSummary;

export type { GoalView };

export type { CommandInfo, CommandSource };

/** Hasil daftar perintah slash dari server. */
export interface CommandListResult {
  /** Daftar perintah; namanya tanpa garis miring. */
  commands: CommandInfo[];
  /** Asal daftar: dari SDK atau daftar bawaan Jejak. */
  source: CommandSource;
}

/** Masukan memulai tujuan (mode Goal). */
export interface GoalStartInput {
  objective: string;
  maxTurns?: number;
  costCapUsd?: number;
}

export type {
  UsageDayBucket,
  UsageModelBucket,
  UsageProfileBucket,
  UsageSessionBucket,
  UsageSummary,
};

/** Respons ringkasan pemakaian dari `GET /api/usage`. */
export interface UsageResponse {
  days: number;
  summary: UsageSummary;
  /** Lama retensi pemakaian dalam hari. */
  retentionDays: number;
  /** Judul sesi per id sesi. */
  sessions: Record<string, string>;
}

export interface AuditListResult {
  entries: AuditEntryItem[];
  next: number | null;
}

export interface AuditQueryInput {
  session?: string;
  kind?: string;
  before?: number;
  limit?: number;
}

export type {
  ChangeAction,
  CheckpointChange,
  CheckpointItem,
  CheckpointKind,
  RewindResult,
};
export type CheckpointList = ListCheckpointsResult;
export type CheckpointPreview = PreviewResult;

export type { ChangedFile, ChangeStatus, Changes, DiffLine, Hunk } from "../../server/files/changes";
export type { GitCommit, GitFile, GitFileStatus, GitState, GitStatus } from "../../server/git/git-read";
export type { GitCommitResult } from "../../server/git/git-write";
export type { BrowseEntry, BrowseResult } from "../../server/files/browse";
export type { DirEntry, DirectoryListing } from "../../server/files/list";
export type { FileContent } from "../../server/files/read";
export type { SearchMatch, SearchResult } from "../../server/files/search";

/** Opsi pencarian teks di tab Files; daftar glob sudah dipisah per item. */
export interface SearchFilesOptions {
  repo?: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  include?: string[];
  exclude?: string[];
}
export type {
  Memory,
  MemoryConfidence,
  MemoryLayer,
  MemoryOrigin,
  MemoryStatus,
} from "../../server/memory/memory-files";
export type { MemoryCounts, MemoryProblem } from "../../server/memory/memory-index";
export type {
  ImportResult,
  ImportSkipReason,
} from "../../server/memory/memory-service";

/** Target revisi yang masih ada: id, judul, dan isi memory yang direvisi. */
export interface MemoryRevises {
  id: string;
  title: string;
  body: string;
}

/**
 * Item memory sisi klien. `replaces` menunjuk memory yang direvisi;
 * `revises` memuat isi target saat ini (null bila target sudah hilang).
 */
export type MemoryItem = Omit<Memory, "replaces"> & {
  replaces?: string | null;
  revises?: MemoryRevises | null;
};
export type MemoryImportResult = ImportResult;

/** Hasil penggabungan ringkasan sesi: usulan baru dan jumlah sumber. */
export interface MemoryConsolidateResult {
  item: MemoryItem;
  sources: number;
}

export type { ServiceKind, WorkspaceProblem } from "../../server/workspaces/workspace-files";

export interface MemoryList {
  items: MemoryItem[];
  counts: MemoryCounts;
  problems: MemoryProblem[];
}

export interface MemoryQuery {
  status?: MemoryStatus;
  layer?: MemoryLayer;
  project?: string;
  q?: string;
  limit?: number;
}

export interface WorkspaceRepoItem extends WorkspaceRepo {
  missing: boolean;
}

export type ServiceCardItem = ServiceCard;

export type WorkspaceItem = Omit<WorkspaceView, "repos"> & {
  repos: WorkspaceRepoItem[];
};

export interface WorkspaceList {
  items: WorkspaceItem[];
  problems: WorkspaceProblem[];
}

export interface WorkspaceRepoInput {
  name: string;
  path: string;
}

export interface WorkspaceCreateInput {
  name: string;
  repos?: WorkspaceRepoInput[];
}

export interface WorkspaceUpdateInput {
  name?: string;
  repos?: WorkspaceRepoInput[];
}

export type McpServerItem = McpServerView;
export type McpTestOutcome = McpTestResult;

export type ClaudeConfigItem = { userSettings: boolean; hooksEnabled: boolean };
export type ClaudeInstructions = InstructionFile;
export type ClaudeSkillItem = SkillInfo;
export type ClaudeSkillFile = ClaudeSkillItem & { content: string };
export type TerminalItem = TerminalInfo;
export type { RunnerCommand };

/** Formulir perintah kustom (label, command, grup opsional). */
export interface RunnerCommandInput {
  label: string;
  command: string;
  group?: string;
}

/** Bagian yang boleh diubah pada perintah kustom. */
export interface RunnerCommandPatch {
  label?: string;
  command?: string;
  group?: string;
}
export type GitProviderItem = GitProviderView;
export type RemoteRepoItem = RemoteRepo & { indexed: boolean };
export type IndexedRepoItem = IndexedRepo;
export interface GitProviderInput {
  name: string;
  kind: "gitlab" | "local";
  baseUrl?: string;
  root?: string;
  /** String isi = ganti; "" = hapus; tanpa field = pertahankan. */
  token?: string;
}
export type QuestionItem = Question;
export type QuestionStatusFilter = "open" | "answered" | "dismissed" | "all";
export type ClaudeAgentItem = AgentInfo;
export type ClaudeAgentFile = ClaudeAgentItem & { content: string };
export type ClaudeHookItem = HookInfo;
export type ClaudeScope = "user" | "project";

/** Plugin Claude Code yang terpasang; `enabled` berasal dari pengaturan Jejak. */
export type ClaudePluginItem = PluginInfo & { enabled: boolean };

/** Ringkasan marketplace yang sudah dikonfigurasi di Claude Code. */
export type MarketplaceInfoItem = MarketplaceInfo;

/** Plugin di katalog marketplace. */
export type MarketplacePluginItem = MarketplacePlugin;

/** Asal sumber plugin; menentukan cara CLI memasang plugin. */
export type MarketplaceSourceKind = PluginSourceKind;

/** Opsi pencarian katalog marketplace. */
export type MarketplaceSearchInput = MarketplaceSearchOptions;

/** Hasil pencarian katalog marketplace. */
export type MarketplaceSearchResult = ServerMarketplaceSearchResult;

/** Hasil perintah pemasangan atau pencabutan plugin. */
export interface PluginCommandOutcome {
  ok: boolean;
  message: string;
}

export interface ClaudeConfigPatch {
  userSettings?: boolean;
  hooksEnabled?: boolean;
}

export interface McpList {
  items: McpServerItem[];
  problems: McpProblem[];
}

export interface McpServerInput {
  name?: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** PATCH: `null` pada env/headers berarti hapus kunci. */
export interface McpServerUpdateInput {
  name?: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string | null>;
  url?: string;
  headers?: Record<string, string | null>;
  enabled?: boolean;
}

export interface ServiceCardInput {
  description?: string;
  kind?: ServiceKind;
  tables?: string[];
  queues?: string[];
  calls?: string[];
}

export interface MemoryCreateInput {
  layer: MemoryLayer;
  projectKey?: string;
  title: string;
  body: string;
}

export interface MemoryUpdateInput {
  title?: string;
  body?: string;
}

export interface ApiErrorDetails {
  dirtyFiles?: number;
  commitsAhead?: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: ApiErrorDetails,
    /** Detik penundaan dari header `retry-after` (galat 429). */
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type WorktreeState = WorktreeInfo & { missing?: boolean };

export interface WorktreeView {
  worktree: WorktreeState;
  inspect: WorktreeInspect;
}

export interface ConnectionTestView {
  ok: boolean;
  status?: number;
  latencyMs: number;
  model?: string;
  toolCalling: "ok" | "tidak-dipanggil" | "tidak-diuji";
  error?: string;
}

export type RejectScope = "hunk" | "file";

export interface SaveFileInput {
  path: string;
  content: string;
  /** sha256 isi yang dibaca terakhir; server menolak bila berubah. */
  baseVersion: string;
  /** Nama repo workspace; hanya diisi bila bukan repo utama (cwd sesi). */
  repo?: string;
}

export interface SaveFileResult {
  ok: true;
  version: string;
  size: number;
}

export interface RejectChangeInput {
  path: string;
  scope: RejectScope;
  hunkId?: string;
  diffId: string;
  /** Nama repo workspace; hanya diisi bila bukan repo utama (cwd sesi). */
  repo?: string;
}

export interface RejectChangeResult {
  undoId: string;
  path: string;
  scope: RejectScope;
}

export interface GitLogOptions {
  /** Nama repo workspace; hanya diisi bila bukan repo utama. */
  repo?: string;
  limit?: number;
}

export interface GitStageInput {
  /** Path relatif (1..200); saling eksklusif dengan `all`. */
  paths?: string[];
  all?: boolean;
  /** Nama repo workspace; hanya diisi bila bukan repo utama. */
  repo?: string;
}

export interface GitShowResult {
  text: string;
  truncated: boolean;
}

export interface SecretAllowState {
  root: string;
  allowed: string[];
}

export interface SecretAllowAddResult {
  path: string;
  rule: string;
  allowed: string[];
}

/** Berkas .env untuk perintah Bash; hanya nama kunci yang dikirim server. */
export interface CommandEnvState {
  path?: string;
  keys: string[];
}

export type BudgetLevel = "ok" | "warn" | "over";

export interface BudgetConfigItem {
  sessionUsd?: number;
  dailyUsd?: number;
  warnAt: number;
}

export interface BudgetStatusResult {
  config: BudgetConfigItem;
  todayUsd: number;
  dayLevel?: BudgetLevel;
  sessionUsd?: number;
  sessionLevel?: BudgetLevel;
}

/** `null` pada batas berarti hapus batas. */
export interface BudgetPatch {
  sessionUsd?: number | null;
  dailyUsd?: number | null;
  warnAt?: number;
}

export type SandboxMode = "standar" | "mati";

/** Pengaturan sandbox Bash per instalasi. */
export interface SandboxConfigItem {
  mode: SandboxMode;
  allowedDomains: string[];
  extraDenyRead: string[];
  extraDenyWrite: string[];
  extraAllowWrite: string[];
  extraAllowUnixSockets: string[];
  allowLocalBinding: boolean;
}

export interface SandboxState {
  config: SandboxConfigItem;
  defaults: { allowedDomains: string[]; denyRead: string[]; denyWrite: string[] };
  available: { ok: boolean; detail: string };
}

export type SandboxPatch = Partial<SandboxConfigItem>;

/** SDK yang terpasang di folder JEJAK_HOME. */
export interface SdkInstalled {
  version: string;
  installedAt: string;
}

/** Sumber CLI `claude` yang dipakai Jejak. */
export type SdkClaudeSource = "env" | "setting" | "managed" | "path" | "common";

/** Status CLI `claude` milik pengguna di server. */
export interface SdkClaude {
  found: boolean;
  path: string | null;
  version: string | null;
  source: SdkClaudeSource | null;
  /** Jalur yang tersimpan di pengaturan Jejak; null bila belum diatur. */
  configuredPath: string | null;
}

/** CLI bawaan SDK yang sudah terpasang. */
export interface SdkCliInstalled {
  version: string;
  platform: string;
  installedAt: string;
  size: number;
}

/** Kemajuan unduhan CLI bawaan yang sedang berjalan. */
export interface SdkCliProgress {
  received: number;
  total: number | null;
}

/** Status CLI bawaan SDK di server. */
export interface SdkCli {
  /** Platform paket pendamping; null bila platform tak didukung. */
  platform: string | null;
  /** True bila platform ini punya paket pendamping. */
  supported: boolean;
  installed: SdkCliInstalled | null;
  progress: SdkCliProgress | null;
}

/** Hasil pemeriksaan paket pendamping platform. */
export interface SdkCliCheck {
  version: string;
  platform: string;
  /** Ukuran isi paket setelah diekstrak. */
  unpackedSize: number;
  /** Perkiraan ukuran unduhan; null bila belum diketahui. */
  downloadSizeEstimate: number | null;
}

/** Status SDK di server; `busy` true saat pemasangan sedang berjalan. */
export interface SdkStatus {
  installed: SdkInstalled | null;
  previous: string | null;
  supportedRange: string;
  lastCheck: { latest: string | null; checkedAt: string; note?: string } | null;
  busy: boolean;
  claude: SdkClaude;
  cli: SdkCli;
}

/** Hasil pemeriksaan versi di registry npm. */
export interface SdkCheckResult {
  latest: string | null;
  /** Versi yang dipasang bila pengguna menyetujui. */
  candidate: string;
  note?: string;
  installedVersion: string | null;
  updateAvailable: boolean;
  /** Ukuran isi paket setelah diekstrak, bila registry menyodorkannya. */
  unpackedSize?: number;
}

/** Hasil pemasangan atau pengembalian versi; `installed` null bila tidak ada. */
export interface SdkInstallResult {
  installed: SdkInstalled | null;
  note?: string;
}

/** Masukan pembuatan sesi (bentuk klien). */
export interface SessionCreateInput {
  prompt: string;
  cwd?: string;
  title?: string;
  profileId?: string;
  model?: string;
  lightModel?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  /** Dikirim hanya bersama mode bypass; UI mengirim `true` setelah pengguna menyetujui. */
  confirmBypass?: boolean;
  workspaceId?: string;
  /** Sesi bekerja di worktree terpisah pada cabang baru. */
  worktree?: boolean;
  /** Hanya dikirim saat pengguna memilih sesi tanpa sandbox. */
  sandbox?: SandboxMode;
}

/** Status prompt tertahan. */
export type HeldPromptStatus = "menunggu" | "terkirim" | "gagal" | "dibatalkan";

/**
 * Masukan tahanan di sisi klien: sama seperti masukan pembuatan sesi, tapi
 * `confirmBypass` tak pernah dikirim ke klien (nilainya urusan server).
 */
export type HeldPromptInput = Omit<CreateSessionInput, "confirmBypass">;

/** Prompt tertahan: prompt yang menunggu sesi lain selesai. */
export interface HeldPrompt {
  id: string;
  /** Isi prompt yang ditahan; sama persis dengan yang diketik pengguna. */
  input: HeldPromptInput;
  /** Id sesi yang harus selesai sebelum prompt dikirim. */
  waitForSessionId: string;
  /** Waktu tahanan dibuat (ISO). */
  createdAt: string;
  status: HeldPromptStatus;
  /** Terisi saat status "terkirim": sesi yang dibuat dari prompt ini. */
  sessionId?: string;
  /** Terisi saat status "gagal": pesan galat pengiriman. */
  error?: string;
}

/* ---------- Tugas terjadwal ---------- */

export type { ScheduleSpec, ScheduledTask };

/** Mode izin yang boleh dipakai tugas terjadwal; bypass tak pernah diizinkan. */
export type SchedulePermissionMode = "default" | "acceptEdits" | "plan";

/** Masukan pembuatan tugas terjadwal. */
export interface ScheduleCreateInput {
  /** Nama tugas (dipakai juga sebagai judul sesi). */
  name: string;
  /** Jadwal: sekali, berulang, atau harian. */
  spec: ScheduleSpec;
  /** Aktif saat dibuat; bawaan aktif. */
  enabled?: boolean;
  /** Prompt yang dijalankan sebagai sesi baru. */
  prompt: string;
  /** Folder kerja sesi; kosong berarti folder bawaan server. */
  cwd?: string;
  /** Judul sesi; kosong berarti memakai nama tugas. */
  title?: string;
  /** Mode izin sesi; bypass tak pernah dikirim. */
  permissionMode?: SchedulePermissionMode;
}

/** Bagian tugas yang boleh diubah. */
export interface SchedulePatch {
  name?: string;
  spec?: ScheduleSpec;
  enabled?: boolean;
  prompt?: string;
  cwd?: string;
  title?: string;
  permissionMode?: SchedulePermissionMode;
}

export interface ApiClient {
  getInfo(): Promise<{ name: string; version: string; cwd: string; mock: boolean }>;
  /** Status autentikasi server (apakah login diperlukan). */
  getAuthStatus(): Promise<AuthStatus>;
  /** Masuk dengan kata sandi; galat 401 melempar `ApiError`. */
  login(password: string): Promise<{ ok: boolean }>;
  /** Keluar: hapus cookie sesi. */
  logout(): Promise<{ ok: boolean }>;
  /** Status sandi milik pengguna. */
  getPasswordStatus(): Promise<PasswordStatus>;
  /** Simpan atau ganti sandi; `current` wajib bila sandi sudah ada. */
  setPassword(input: {
    password: string;
    current?: string;
  }): Promise<{ ok: boolean; updatedAt?: string }>;
  /** Hapus sandi; `current` (sandi lama) wajib dan harus benar. */
  clearPassword(current: string): Promise<{ ok: boolean }>;
  /** Status akses dari jaringan (listener kedua). */
  getNetworkStatus(): Promise<NetworkStatus>;
  /** Nyalakan atau matikan akses dari jaringan. */
  setNetwork(input: { enabled: boolean; port?: number }): Promise<NetworkStatus>;
  /** Status Cloudflare Tunnel (tanpa token). */
  getTunnel(): Promise<TunnelStatus>;
  /** Nyalakan atau matikan tunnel; `token` tak pernah dicatat di galat. */
  putTunnel(input: {
    enabled: boolean;
    publicHost?: string;
    token?: string;
  }): Promise<TunnelStatus>;
  /** Hapus token tunnel tersimpan. */
  deleteTunnelToken(): Promise<TunnelStatus>;
  listSessions(): Promise<SessionInfo[]>;
  getSession(id: string): Promise<SessionInfo>;
  renameSession(id: string, title: string): Promise<SessionInfo>;
  archiveSession(id: string, archived: boolean): Promise<SessionInfo>;
  setSessionPermissionMode(
    id: string,
    mode: "default" | "acceptEdits" | "plan" | "bypassPermissions",
    confirmBypass?: boolean,
  ): Promise<SessionInfo>;
  setSessionProvider(id: string, selection: { profileId?: string; model?: string }): Promise<SessionInfo>;
  setSessionSandbox(id: string, mode: SandboxMode): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;
  createSession(input: SessionCreateInput): Promise<SessionInfo>;
  /** Semua prompt tertahan yang tersimpan di server. */
  listHeld(): Promise<HeldPrompt[]>;
  /** Tahan prompt sampai sesi `waitForSessionId` selesai. */
  holdPrompt(input: SessionCreateInput, waitForSessionId: string): Promise<HeldPrompt>;
  /** Batalkan tahanan yang masih menunggu; isinya dikembalikan sebagai draf. */
  cancelHeld(id: string): Promise<HeldPrompt>;
  /** Tutup kartu tahanan yang tak menunggu apa pun. */
  dismissHeld(id: string): Promise<void>;
  /** Semua tugas terjadwal yang tersimpan di server. */
  listSchedules(): Promise<ScheduledTask[]>;
  /** Buat tugas terjadwal baru. */
  createSchedule(input: ScheduleCreateInput): Promise<ScheduledTask>;
  /** Ubah nama, jadwal, status aktif, atau input sesinya. */
  updateSchedule(id: string, patch: SchedulePatch): Promise<ScheduledTask>;
  /** Hapus tugas terjadwal. */
  deleteSchedule(id: string): Promise<void>;
  /** Jalankan tugas sekarang; jadwal tak digeser. */
  runSchedule(id: string): Promise<ScheduledTask>;
  interruptSession(id: string): Promise<{ interrupted: boolean }>;
  /** Lanjutkan sesi yang terputus karena aplikasi berhenti. */
  continueSession(id: string): Promise<{ ok: true; queued: boolean }>;
  /** Mulai tujuan (mode Goal) pada sesi yang sudah ada. */
  startGoal(id: string, input: GoalStartInput): Promise<{ goal: GoalView | null }>;
  /** Jeda tujuan; giliran yang sedang berjalan dibiarkan selesai. */
  pauseGoal(id: string): Promise<{ goal: GoalView | null }>;
  /** Lanjutkan tujuan yang dijeda. */
  resumeGoal(id: string): Promise<{ goal: GoalView | null }>;
  /** Hentikan tujuan dan batalkan giliran berjalan. */
  stopGoal(id: string): Promise<{ goal: GoalView | null }>;
  /** Tujuan sesi; `null` bila sesi tidak punya tujuan. */
  getGoal(id: string): Promise<{ goal: GoalView | null }>;
  sendMessage(id: string, text: string): Promise<{ queued: boolean }>;
  /** Buang satu pesan dari antrean sesi. */
  removeQueued(id: string, queueId: string): Promise<{ ok: true }>;
  /** Kirim satu pesan antrean sekarang: giliran berjalan dihentikan dulu. */
  sendQueuedNow(id: string, queueId: string): Promise<{ ok: true }>;
  /** Arahkan satu pesan antrean ke giliran yang berjalan tanpa menghentikannya. */
  steerQueued(id: string, queueId: string): Promise<{ ok: true }>;
  /** Pertanyaan sampingan dari salinan percakapan sesi (tidak masuk riwayat). */
  askSideQuestion(id: string, question: string): Promise<{ answer: string }>;
  /** Mundur percakapan ke pesan pengguna; mengembalikan teks pesan yang dibuang. */
  rewindConversation(id: string, eventSeq: number): Promise<{ text: string }>;
  uploadAttachment(file: {
    name: string;
    data: string;
  }): Promise<{ id: string; name: string; path: string; size: number; image: boolean }>;
  getFiles(id: string, path?: string, repo?: string): Promise<DirectoryListing>;
  getFile(id: string, path: string, repo?: string): Promise<FileContent>;
  searchFiles(
    id: string,
    query: string,
    options?: SearchFilesOptions,
  ): Promise<SearchResult>;
  saveFile(id: string, input: SaveFileInput): Promise<SaveFileResult>;
  getChanges(id: string, repo?: string): Promise<Changes>;
  gitStatus(id: string, repo?: string): Promise<GitStatus>;
  gitLog(id: string, options?: GitLogOptions): Promise<{ commits: GitCommit[] }>;
  gitShow(id: string, hash: string, repo?: string): Promise<GitShowResult>;
  gitStage(id: string, input: GitStageInput): Promise<void>;
  gitUnstage(id: string, input: GitStageInput): Promise<void>;
  gitCommit(id: string, message: string, repo?: string): Promise<GitCommitResult>;
  getWorktree(id: string): Promise<WorktreeView>;
  removeWorktree(id: string, options?: { force?: boolean }): Promise<void>;
  restoreWorktree(id: string): Promise<void>;
  browseDirs(path?: string): Promise<BrowseResult>;
  nativePickerAvailable(): Promise<boolean>;
  pickFolderNative(start?: string): Promise<string | undefined>;
  listProviderModels(profileId: string): Promise<{ ok: boolean; models: string[]; error?: string }>;
  rejectChange(id: string, input: RejectChangeInput): Promise<RejectChangeResult>;
  undoChange(id: string, undoId: string, repo?: string): Promise<{ path: string }>;
  getCheckpoints(id: string): Promise<CheckpointList>;
  createCheckpoint(id: string, label?: string): Promise<CheckpointItem>;
  previewCheckpoint(id: string, cid: string): Promise<CheckpointPreview>;
  rewindCheckpoint(id: string, cid: string): Promise<RewindResult>;
  decidePermission(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
    answers?: Record<string, string>,
  ): Promise<{ ok: true }>;
  getProviders(): Promise<unknown>;
  saveProviders(registry: unknown): Promise<unknown>;
  setActiveProvider(profileId: string): Promise<unknown>;
  testProvider(selection?: { profileId?: string; model?: string }): Promise<ConnectionTestView>;
  listMemory(params?: MemoryQuery): Promise<MemoryList>;
  /** Memory Claude Code untuk satu proyek; baca-saja. */
  listClaudeMemory(project: string): Promise<ClaudeMemoryResponse>;
  /** Status saklar sinkron memory ke Claude Code. */
  getClaudeMemorySync(): Promise<ClaudeMemorySyncState>;
  /** Nyalakan atau matikan sinkron memory ke Claude Code. */
  setClaudeMemorySync(enabled: boolean): Promise<ClaudeMemorySyncState>;
  /** Jalankan sinkron penuh; mengembalikan ringkasan hasil. */
  runClaudeMemorySync(): Promise<ClaudeMemorySyncRun>;
  createMemory(input: MemoryCreateInput): Promise<MemoryItem>;
  updateMemory(id: string, input: MemoryUpdateInput): Promise<MemoryItem>;
  createTerminal(cwd: string, size?: { cols: number; rows: number }): Promise<TerminalItem>;
  closeTerminal(id: string): Promise<void>;
  /** Daftar perintah folder sesi (script package + perintah kustom). */
  listRunner(cwd: string): Promise<{ commands: RunnerCommand[] }>;
  addRunnerCommand(cwd: string, form: RunnerCommandInput): Promise<RunnerCommand>;
  updateRunnerCommand(
    cwd: string,
    id: string,
    patch: RunnerCommandPatch,
  ): Promise<RunnerCommand>;
  deleteRunnerCommand(cwd: string, id: string): Promise<void>;
  /** Jalankan perintah; `confirm` benar hanya untuk konfirmasi pertama. */
  runRunnerCommand(
    cwd: string,
    id: string,
    confirm?: boolean,
  ): Promise<{ terminalId: string }>;
  /** Proyek wiki yang cocok dengan remote origin folder sesi. */
  wikiProject(cwd: string): Promise<WikiProject>;
  /** Sinkronkan wiki proyek (klon dangkal lalu segarkan). */
  wikiSync(providerId: string, fullPath: string): Promise<WikiSync>;
  /** Daftar halaman wiki dari cache server. */
  wikiPages(providerId: string, fullPath: string): Promise<WikiSync>;
  /** Isi satu halaman wiki. */
  wikiPage(providerId: string, fullPath: string, slug: string): Promise<WikiPage>;
  listGitProviders(): Promise<GitProviderItem[]>;
  putGitProvider(id: string, input: GitProviderInput): Promise<GitProviderItem>;
  deleteGitProvider(id: string): Promise<void>;
  listProviderRepos(id: string): Promise<RemoteRepoItem[]>;
  listIndexedRepos(): Promise<IndexedRepoItem[]>;
  indexRepo(providerId: string, fullPath: string): Promise<IndexedRepoItem>;
  deleteIndexedRepo(key: string): Promise<void>;
  listQuestions(status?: QuestionStatusFilter): Promise<{ items: QuestionItem[]; open: number }>;
  assignQuestion(id: string, assignee: string): Promise<QuestionItem>;
  answerQuestion(id: string, answer: string, by: string): Promise<QuestionItem>;
  dismissQuestion(id: string): Promise<QuestionItem>;
  acceptMemory(id: string): Promise<MemoryItem>;
  rejectMemory(id: string): Promise<MemoryItem>;
  archiveMemory(id: string): Promise<MemoryItem>;
  deleteMemory(id: string): Promise<void>;
  importMemory(projectKey: string): Promise<MemoryImportResult>;
  /** Gabungkan ringkasan sesi proyek menjadi satu usulan memory. */
  consolidateMemory(projectKey: string): Promise<MemoryConsolidateResult>;
  listWorkspaces(): Promise<WorkspaceList>;
  createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceItem>;
  updateWorkspace(id: string, input: WorkspaceUpdateInput): Promise<WorkspaceItem>;
  setWorkspaceCard(
    id: string,
    repoName: string,
    card: ServiceCardInput,
  ): Promise<WorkspaceItem>;
  deleteWorkspace(id: string): Promise<void>;
  listMcpServers(): Promise<McpList>;
  createMcpServer(input: McpServerInput): Promise<McpServerItem>;
  updateMcpServer(id: string, input: McpServerUpdateInput): Promise<McpServerItem>;
  deleteMcpServer(id: string): Promise<void>;
  testMcpServer(id: string): Promise<McpTestOutcome>;
  listAudit(query?: AuditQueryInput): Promise<AuditListResult>;
  getAuditSummary(): Promise<AuditSummaryResult>;
  getUsage(days: 7 | 30 | 90): Promise<UsageResponse>;
  getSecretAllow(sessionId: string): Promise<SecretAllowState>;
  addSecretAllow(sessionId: string, path: string): Promise<SecretAllowAddResult>;
  removeSecretAllow(
    sessionId: string,
    path: string,
  ): Promise<{ removed: boolean; allowed: string[] }>;
  getCommandEnv(sessionId: string): Promise<CommandEnvState>;
  setCommandEnv(sessionId: string, path: string): Promise<CommandEnvState>;
  clearCommandEnv(sessionId: string): Promise<{ removed: boolean }>;
  getBudget(): Promise<BudgetConfigItem>;
  /** `null` pada batas berarti hapus batas. */
  putBudget(patch: BudgetPatch): Promise<BudgetConfigItem>;
  getBudgetStatus(sessionId?: string): Promise<BudgetStatusResult>;
  getSandbox(): Promise<SandboxState>;
  putSandbox(patch: SandboxPatch): Promise<SandboxConfigItem>;
  /** Status fitur (terminal, browser) beserta kunci env. */
  getFeatures(): Promise<FeatureStatus>;
  /** Nyalakan atau matikan fitur; status terbaru dikembalikan. */
  putFeatures(patch: Partial<Record<FeatureName, boolean>>): Promise<FeatureStatus>;
  /** Status SDK yang dipasang pengguna. */
  getSdk(): Promise<SdkStatus>;
  /** Periksa versi terbaru di registry npm; tidak memasang apa pun. */
  checkSdk(): Promise<SdkCheckResult>;
  /** Pasang SDK; `version` dikirim persis seperti ditampilkan ke pengguna. */
  installSdk(version?: string): Promise<SdkInstallResult>;
  /** Kembalikan ke versi sebelumnya. */
  rollbackSdk(): Promise<SdkInstallResult>;
  /** Simpan atau hapus jalur CLI `claude` milik pengguna. */
  setClaudePath(path: string | null): Promise<SdkClaude>;
  /** Periksa paket pendamping platform; tidak mengunduh apa pun. */
  checkSdkCli(): Promise<SdkCliCheck>;
  /** Pasang CLI bawaan SDK untuk versi SDK yang terpasang. */
  installSdkCli(): Promise<{ ok: boolean; cli: SdkCli }>;
  /** Hapus CLI bawaan SDK yang terpasang. */
  removeSdkCli(): Promise<{ ok: boolean; cli: SdkCli }>;
  getClaudeConfig(): Promise<ClaudeConfigItem>;
  putClaudeConfig(patch: ClaudeConfigPatch): Promise<ClaudeConfigItem>;
  getInstructions(scope: ClaudeScope, cwd?: string): Promise<ClaudeInstructions>;
  putInstructions(
    scope: ClaudeScope,
    content: string,
    cwd?: string,
  ): Promise<ClaudeInstructions>;
  listSkills(cwd?: string): Promise<ClaudeSkillItem[]>;
  getSkill(scope: ClaudeScope, name: string, cwd?: string): Promise<ClaudeSkillFile>;
  putSkill(
    scope: ClaudeScope,
    name: string,
    content: string,
    cwd?: string,
  ): Promise<ClaudeSkillFile>;
  setSkillEnabled(
    scope: ClaudeScope,
    name: string,
    enabled: boolean,
    cwd?: string,
  ): Promise<{ scope: ClaudeScope; name: string; enabled: boolean }>;
  listAgents(cwd?: string): Promise<ClaudeAgentItem[]>;
  getAgent(scope: ClaudeScope, name: string, cwd?: string): Promise<ClaudeAgentFile>;
  putAgent(
    scope: ClaudeScope,
    name: string,
    content: string,
    cwd?: string,
  ): Promise<ClaudeAgentFile>;
  listHooks(cwd?: string): Promise<ClaudeHookItem[]>;
  /** Daftar plugin Claude Code yang sudah terpasang. */
  listPlugins(): Promise<ClaudePluginItem[]>;
  /** Nyalakan atau matikan plugin; berlaku untuk sesi berikutnya. */
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  /** Daftar marketplace yang sudah dikonfigurasi di Claude Code. */
  listMarketplaces(): Promise<MarketplaceInfoItem[]>;
  /** Cari plugin di katalog marketplace. */
  searchMarketplace(options?: MarketplaceSearchInput): Promise<MarketplaceSearchResult>;
  /** Pasang plugin dari katalog marketplace; boleh berjalan beberapa menit. */
  installPlugin(id: string): Promise<PluginCommandOutcome>;
  /** Copot plugin yang terpasang. */
  uninstallPlugin(id: string): Promise<PluginCommandOutcome>;
  /** Daftar perintah slash yang tersedia di folder kerja tertentu. */
  listCommands(cwd: string): Promise<CommandListResult>;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Dipanggil saat server menjawab 401; klien kembali ke layar login. */
  onUnauthorized?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Baca header `retry-after` (detik) menjadi angka. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function sessionFrom(payload: unknown): SessionInfo {
  const session = field(payload, "session");
  if (!isRecord(session)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  return session as unknown as SessionInfo;
}

/** Bentuk `{ goal }` dari server; `null` berarti sesi tidak punya tujuan. */
function goalFrom(payload: unknown): { goal: GoalView | null } {
  const goal = field(payload, "goal");
  if (goal === null || goal === undefined) return { goal: null };
  if (!isRecord(goal)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  return { goal: goal as unknown as GoalView };
}

/** Bentuk revisi dari server; bentuk rusak menjadi null. */
function memoryRevisesFrom(value: unknown): MemoryRevises | null {
  if (!isRecord(value)) return null;
  const { id, title, body } = value;
  if (typeof id !== "string" || typeof title !== "string" || typeof body !== "string") {
    return null;
  }
  return { id, title, body };
}

/** Lengkapi field revisi pada item memory; bentuk tidak dikenal ditolak. */
function memoryItemFrom(value: unknown): MemoryItem {
  if (!isRecord(value)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  const replaces = typeof value.replaces === "string" ? value.replaces : null;
  return {
    ...value,
    replaces,
    revises: memoryRevisesFrom(value.revises),
  } as unknown as MemoryItem;
}

function memoryFrom(payload: unknown): MemoryItem {
  return memoryItemFrom(field(payload, "item"));
}

function memoryImportFrom(payload: unknown): MemoryImportResult {
  if (!isRecord(payload)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  const { created, skipped, files } = payload;
  if (!Array.isArray(created) || !Array.isArray(skipped) || !Array.isArray(files)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  for (const entry of skipped) {
    if (
      !isRecord(entry) ||
      typeof entry.file !== "string" ||
      typeof entry.title !== "string" ||
      typeof entry.reason !== "string"
    ) {
      throw new ApiError("respons server tidak valid", 200);
    }
  }
  for (const entry of files) {
    if (!isRecord(entry) || typeof entry.file !== "string" || typeof entry.found !== "boolean") {
      throw new ApiError("respons server tidak valid", 200);
    }
  }
  return payload as unknown as MemoryImportResult;
}

function workspaceFrom(payload: unknown): WorkspaceItem {
  const item = field(payload, "item");
  if (!isRecord(item) || typeof item.id !== "string" || !Array.isArray(item.repos)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  return item as unknown as WorkspaceItem;
}

function workspaceListFrom(payload: unknown): WorkspaceList {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  const problems = payload.problems;
  return {
    items: payload.items as WorkspaceItem[],
    problems: Array.isArray(problems) ? (problems as WorkspaceProblem[]) : [],
  };
}

function mcpServerFrom(payload: unknown): McpServerItem {
  const item = field(payload, "item");
  if (
    !isRecord(item) ||
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    (item.transport !== "stdio" && item.transport !== "http") ||
    typeof item.enabled !== "boolean"
  ) {
    throw new ApiError("respons server tidak valid", 200);
  }
  return item as unknown as McpServerItem;
}

function mcpListFrom(payload: unknown): McpList {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  const problems = payload.problems;
  return {
    items: payload.items as McpServerItem[],
    problems: Array.isArray(problems) ? (problems as McpProblem[]) : [],
  };
}

function mcpTestFrom(payload: unknown): McpTestOutcome {
  if (
    !isRecord(payload) ||
    typeof payload.ok !== "boolean" ||
    typeof payload.ms !== "number" ||
    !Number.isFinite(payload.ms)
  ) {
    throw new ApiError("respons server tidak valid", 200);
  }
  return payload as unknown as McpTestOutcome;
}

function auditListFrom(payload: unknown): AuditListResult {
  if (!isRecord(payload) || !Array.isArray(payload.entries)) {
    throw invalidResponse();
  }
  const raw = payload.next;
  if (raw !== undefined && raw !== null && (typeof raw !== "number" || !Number.isFinite(raw))) {
    throw invalidResponse();
  }
  return {
    entries: payload.entries as AuditEntryItem[],
    next: typeof raw === "number" ? raw : null,
  };
}

function auditSummaryFrom(payload: unknown): AuditSummaryResult {
  if (!isRecord(payload)) throw invalidResponse();
  const { days, since, total, byKind, redactedSessions } = payload;
  if (
    typeof days !== "number" ||
    !Number.isFinite(days) ||
    typeof since !== "string" ||
    typeof total !== "number" ||
    !Number.isFinite(total) ||
    !isRecord(byKind) ||
    typeof redactedSessions !== "number" ||
    !Number.isFinite(redactedSessions)
  ) {
    throw invalidResponse();
  }
  return payload as unknown as AuditSummaryResult;
}

function usageResponseFrom(payload: unknown): UsageResponse {
  if (!isRecord(payload)) throw invalidResponse();
  const { days, summary, retentionDays, sessions } = payload;
  if (
    typeof days !== "number" ||
    !Number.isFinite(days) ||
    typeof retentionDays !== "number" ||
    !Number.isFinite(retentionDays) ||
    !isRecord(sessions) ||
    !isRecord(summary)
  ) {
    throw invalidResponse();
  }
  return {
    days,
    retentionDays,
    summary: summary as unknown as UsageSummary,
    sessions: Object.fromEntries(
      Object.entries(sessions).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
}

function secretAllowStateFrom(payload: unknown): SecretAllowState {
  if (!isRecord(payload) || typeof payload.root !== "string" || !Array.isArray(payload.allowed)) {
    throw invalidResponse();
  }
  return { root: payload.root, allowed: payload.allowed as string[] };
}

function secretAllowAddFrom(payload: unknown): SecretAllowAddResult {
  if (
    !isRecord(payload) ||
    typeof payload.path !== "string" ||
    typeof payload.rule !== "string" ||
    !Array.isArray(payload.allowed)
  ) {
    throw invalidResponse();
  }
  return { path: payload.path, rule: payload.rule, allowed: payload.allowed as string[] };
}

function secretAllowRemoveFrom(payload: unknown): { removed: boolean; allowed: string[] } {
  if (!isRecord(payload) || typeof payload.removed !== "boolean" || !Array.isArray(payload.allowed)) {
    throw invalidResponse();
  }
  return { removed: payload.removed, allowed: payload.allowed as string[] };
}

function commandEnvStateFrom(payload: unknown): CommandEnvState {
  if (!isRecord(payload) || !Array.isArray(payload.keys)) {
    throw invalidResponse();
  }
  const state: CommandEnvState = { keys: payload.keys as string[] };
  if (typeof payload.path === "string") state.path = payload.path;
  return state;
}

function commandEnvClearFrom(payload: unknown): { removed: boolean } {
  if (!isRecord(payload) || typeof payload.removed !== "boolean") {
    throw invalidResponse();
  }
  return { removed: payload.removed };
}

const BUDGET_LEVELS = new Set(["ok", "warn", "over"]);
function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function budgetConfigFrom(payload: unknown): BudgetConfigItem {
  if (!isRecord(payload)) throw invalidResponse();
  const warnAt = finiteOrUndefined(payload.warnAt);
  if (warnAt === undefined) throw invalidResponse();
  const config: BudgetConfigItem = { warnAt };
  const sessionUsd = finiteOrUndefined(payload.sessionUsd);
  if (sessionUsd !== undefined) config.sessionUsd = sessionUsd;
  const dailyUsd = finiteOrUndefined(payload.dailyUsd);
  if (dailyUsd !== undefined) config.dailyUsd = dailyUsd;
  return config;
}

function budgetLevel(value: unknown): BudgetLevel | undefined {
  return typeof value === "string" && BUDGET_LEVELS.has(value) ? (value as BudgetLevel) : undefined;
}

function budgetStatusFrom(payload: unknown): BudgetStatusResult {
  if (!isRecord(payload)) throw invalidResponse();
  const todayUsd = finiteOrUndefined(payload.todayUsd);
  if (todayUsd === undefined) throw invalidResponse();
  const result: BudgetStatusResult = {
    config: budgetConfigFrom(payload.config),
    todayUsd,
  };
  const dayLevel = budgetLevel(payload.dayLevel);
  if (dayLevel !== undefined) result.dayLevel = dayLevel;
  const sessionUsd = finiteOrUndefined(payload.sessionUsd);
  if (sessionUsd !== undefined) result.sessionUsd = sessionUsd;
  const sessionLevel = budgetLevel(payload.sessionLevel);
  if (sessionLevel !== undefined) result.sessionLevel = sessionLevel;
  return result;
}

function sandboxConfigFrom(payload: unknown): SandboxConfigItem {
  if (!isRecord(payload)) throw invalidResponse();
  return {
    // Mode tak dikenal diperlakukan standar (default aman).
    mode: payload.mode === "mati" ? "mati" : "standar",
    allowedDomains: stringListFrom(payload.allowedDomains),
    extraDenyRead: stringListFrom(payload.extraDenyRead),
    extraDenyWrite: stringListFrom(payload.extraDenyWrite),
    extraAllowWrite: stringListFrom(payload.extraAllowWrite),
    extraAllowUnixSockets: stringListFrom(payload.extraAllowUnixSockets),
    allowLocalBinding: payload.allowLocalBinding === true,
  };
}

function stringListFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function sandboxStateFrom(payload: unknown): SandboxState {
  if (!isRecord(payload)) throw invalidResponse();
  const defaults = isRecord(payload.defaults) ? payload.defaults : {};
  const available = isRecord(payload.available) ? payload.available : {};
  return {
    config: sandboxConfigFrom(payload.config),
    defaults: {
      allowedDomains: stringListFrom(defaults.allowedDomains),
      denyRead: stringListFrom(defaults.denyRead),
      denyWrite: stringListFrom(defaults.denyWrite),
    },
    available: {
      ok: available.ok === true,
      detail: typeof available.detail === "string" ? available.detail : "",
    },
  };
}

function sdkInstalledFrom(payload: unknown): SdkInstalled | null {
  if (!isRecord(payload)) return null;
  const version = typeof payload.version === "string" ? payload.version : "";
  if (version === "") return null;
  return {
    version,
    installedAt: typeof payload.installedAt === "string" ? payload.installedAt : "",
  };
}

/** Bentuk aman untuk status CLI `claude`; sumber di luar daftar diabaikan. */
function sdkClaudeFrom(payload: unknown): SdkClaude {
  if (!isRecord(payload)) {
    return { found: false, path: null, version: null, source: null, configuredPath: null };
  }
  const source = payload.source;
  const known: SdkClaudeSource[] = ["env", "setting", "managed", "path", "common"];
  return {
    found: payload.found === true,
    path: typeof payload.path === "string" ? payload.path : null,
    version: typeof payload.version === "string" ? payload.version : null,
    source:
      typeof source === "string" && (known as string[]).includes(source)
        ? (source as SdkClaudeSource)
        : null,
    configuredPath:
      typeof payload.configuredPath === "string" ? payload.configuredPath : null,
  };
}

/** Bentuk aman untuk status CLI bawaan SDK. */
function sdkCliFrom(payload: unknown): SdkCli {
  if (!isRecord(payload)) {
    return { platform: null, supported: false, installed: null, progress: null };
  }
  const installedRaw = isRecord(payload.installed) ? payload.installed : null;
  const progressRaw = isRecord(payload.progress) ? payload.progress : null;
  const total = progressRaw === null ? null : finiteOrUndefined(progressRaw.total);
  return {
    platform: typeof payload.platform === "string" ? payload.platform : null,
    supported: payload.supported === true,
    installed:
      installedRaw === null || typeof installedRaw.version !== "string"
        ? null
        : {
            version: installedRaw.version,
            platform: typeof installedRaw.platform === "string" ? installedRaw.platform : "",
            installedAt:
              typeof installedRaw.installedAt === "string" ? installedRaw.installedAt : "",
            size: finiteOrUndefined(installedRaw.size) ?? 0,
          },
    progress:
      progressRaw === null
        ? null
        : {
            received: finiteOrUndefined(progressRaw.received) ?? 0,
            total: total === undefined ? null : total,
          },
  };
}

function sdkStatusFrom(payload: unknown): SdkStatus {
  if (!isRecord(payload)) throw invalidResponse();
  const check = isRecord(payload.lastCheck) ? payload.lastCheck : null;
  return {
    installed: sdkInstalledFrom(payload.installed),
    previous: typeof payload.previous === "string" ? payload.previous : null,
    supportedRange: typeof payload.supportedRange === "string" ? payload.supportedRange : "",
    lastCheck:
      check === null
        ? null
        : {
            latest: typeof check.latest === "string" ? check.latest : null,
            checkedAt: typeof check.checkedAt === "string" ? check.checkedAt : "",
            ...(typeof check.note === "string" ? { note: check.note } : {}),
          },
    busy: payload.busy === true,
    claude: sdkClaudeFrom(payload.claude),
    cli: sdkCliFrom(payload.cli),
  };
}

function sdkCheckFrom(payload: unknown): SdkCheckResult {
  if (!isRecord(payload)) throw invalidResponse();
  const result: SdkCheckResult = {
    latest: typeof payload.latest === "string" ? payload.latest : null,
    candidate: typeof payload.candidate === "string" ? payload.candidate : "",
    installedVersion:
      typeof payload.installedVersion === "string" ? payload.installedVersion : null,
    updateAvailable: payload.updateAvailable === true,
  };
  if (typeof payload.note === "string") result.note = payload.note;
  const size = finiteOrUndefined(payload.unpackedSize);
  if (size !== undefined) result.unpackedSize = size;
  return result;
}

function sdkInstallFrom(payload: unknown): SdkInstallResult {
  if (!isRecord(payload)) throw invalidResponse();
  const result: SdkInstallResult = { installed: sdkInstalledFrom(payload.installed) };
  if (typeof payload.note === "string") result.note = payload.note;
  return result;
}

function sdkCliCheckFrom(payload: unknown): SdkCliCheck {
  if (!isRecord(payload)) throw invalidResponse();
  const estimate = finiteOrUndefined(payload.downloadSizeEstimate);
  return {
    version: typeof payload.version === "string" ? payload.version : "",
    platform: typeof payload.platform === "string" ? payload.platform : "",
    unpackedSize: finiteOrUndefined(payload.unpackedSize) ?? 0,
    downloadSizeEstimate: estimate === undefined ? null : estimate,
  };
}

function memoryQuery(params: MemoryQuery | undefined): string {  if (params === undefined) return "";
  const parts: string[] = [];
  const push = (key: string, value: string | number | undefined): void => {
    if (value === undefined) return;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  };
  push("status", params.status);
  push("layer", params.layer);
  push("project", params.project);
  push("q", params.q);
  push("limit", params.limit);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** Query string dari pasangan yang diberikan; nilai undefined dilewati. */
function queryString(parts: Array<[string, string | undefined]>): string {
  const pairs: string[] = [];
  for (const [key, value] of parts) {
    if (value !== undefined) pairs.push(`${key}=${encodeURIComponent(value)}`);
  }
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

const TOOL_CALLING_VALUES = new Set(["ok", "tidak-dipanggil", "tidak-diuji"]);
const CHECKPOINT_KINDS = new Set(["turn", "manual", "pre-rewind"]);
const CHANGE_ACTIONS = new Set(["restore", "recreate", "remove"]);

function invalidResponse(): ApiError {
  return new ApiError("respons server tidak valid", 200);
}

function checkpointItemFrom(value: unknown): CheckpointItem {
  if (!isRecord(value)) throw invalidResponse();
  const { id, kind, label, createdAt, files, turn } = value;
  if (typeof id !== "string" || !CHECKPOINT_KINDS.has(kind as string)) throw invalidResponse();
  if (typeof label !== "string" || typeof createdAt !== "string") throw invalidResponse();
  if (typeof files !== "number" || !Number.isFinite(files)) throw invalidResponse();
  if (turn !== undefined && (typeof turn !== "number" || !Number.isFinite(turn))) {
    throw invalidResponse();
  }
  return value as unknown as CheckpointItem;
}

function checkpointListFrom(payload: unknown): CheckpointList {
  if (!isRecord(payload) || typeof payload.enabled !== "boolean") throw invalidResponse();
  const { items, reason } = payload;
  if (!Array.isArray(items)) throw invalidResponse();
  const list: CheckpointList = {
    enabled: payload.enabled,
    items: items.map(checkpointItemFrom),
  };
  if (typeof reason === "string") list.reason = reason;
  return list;
}

function checkpointPreviewFrom(payload: unknown): CheckpointPreview {
  if (!isRecord(payload) || typeof payload.truncated !== "boolean") throw invalidResponse();
  const { changes } = payload;
  if (!Array.isArray(changes)) throw invalidResponse();
  for (const change of changes) {
    if (
      !isRecord(change) ||
      typeof change.path !== "string" ||
      !CHANGE_ACTIONS.has(change.action as string)
    ) {
      throw invalidResponse();
    }
  }
  return payload as unknown as CheckpointPreview;
}

function rewindResultFrom(payload: unknown): RewindResult {
  if (!isRecord(payload)) throw invalidResponse();
  const { safetyId, restored, recreated, removed } = payload;
  if (typeof safetyId !== "string") throw invalidResponse();
  for (const count of [restored, recreated, removed]) {
    if (typeof count !== "number" || !Number.isFinite(count)) throw invalidResponse();
  }
  return { safetyId, restored: restored as number, recreated: recreated as number, removed: removed as number };
}

function gitShowFrom(payload: unknown): GitShowResult {
  if (!isRecord(payload) || typeof payload.text !== "string") throw invalidResponse();
  return { text: payload.text, truncated: payload.truncated === true };
}

/** Body stage/unstage: `paths` atau `all`, plus `repo` bila ada. */
function stageBody(input: GitStageInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.all === true) body.all = true;
  if (input.paths !== undefined) body.paths = input.paths;
  if (input.repo !== undefined) body.repo = input.repo;
  return body;
}

const HELD_STATUSES = new Set<string>(["menunggu", "terkirim", "gagal", "dibatalkan"]);

/** Bentuk tahanan dari server; bentuk rusak ditolak. */
function heldFrom(value: unknown): HeldPrompt {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.waitForSessionId !== "string" ||
    typeof value.createdAt !== "string" ||
    !HELD_STATUSES.has(String(value.status)) ||
    !isRecord(value.input)
  ) {
    throw invalidResponse();
  }
  return value as unknown as HeldPrompt;
}

/** Ambil tahanan dari payload `{ held }`. */
function heldPayloadFrom(payload: unknown): HeldPrompt {
  return heldFrom(field(payload, "held"));
}

/** Bentuk tugas terjadwal dari server; bentuk rusak ditolak. */
function scheduleFrom(value: unknown): ScheduledTask {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isRecord(value.input) ||
    !isRecord(value.spec) ||
    typeof value.enabled !== "boolean" ||
    typeof value.runCount !== "number" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw invalidResponse();
  }
  return value as unknown as ScheduledTask;
}

/** Ambil tugas dari payload `{ task }`. */
function schedulePayloadFrom(payload: unknown): ScheduledTask {
  return scheduleFrom(field(payload, "task"));
}

/**
 * Bentuk body pembuatan tugas: field sesi disusun datar, `confirmBypass`
 * tak pernah ikut karena tugas terjadwal tak boleh berjalan tanpa izin.
 */
function createScheduleBody(input: ScheduleCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name,
    spec: input.spec,
    prompt: input.prompt,
  };
  if (input.enabled !== undefined) body.enabled = input.enabled;
  if (input.cwd !== undefined) body.cwd = input.cwd;
  if (input.title !== undefined) body.title = input.title;
  if (input.permissionMode !== undefined) body.permissionMode = input.permissionMode;
  return body;
}

/**
 * Bentuk body pembuatan sesi: field yang tak berarti tak pernah ikut
 * (`confirmBypass`, `worktree`, `sandbox`).
 */
function createSessionBody(input: SessionCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = { ...input };
  if (body["confirmBypass"] !== true) delete body["confirmBypass"];
  if (body["worktree"] !== true) delete body["worktree"];
  if (body["sandbox"] !== "mati" && body["sandbox"] !== "standar") delete body["sandbox"];
  return body;
}

function connectionTestFrom(payload: unknown): ConnectionTestView {
  const result = field(payload, "result");
  if (!isRecord(result)) {
    throw new ApiError("respons server tidak valid", 200);
  }

  const { ok, status, latencyMs, model, toolCalling, error } = result;
  if (typeof ok !== "boolean" || typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  if (typeof toolCalling !== "string" || !TOOL_CALLING_VALUES.has(toolCalling)) {
    throw new ApiError("respons server tidak valid", 200);
  }

  const view: ConnectionTestView = {
    ok,
    latencyMs,
    toolCalling: toolCalling as ConnectionTestView["toolCalling"],
  };
  if (typeof status === "number" && Number.isFinite(status)) view.status = status;
  if (typeof model === "string") view.model = model;
  if (typeof error === "string") view.error = error;
  return view;
}

function claudeConfigFrom(payload: unknown): ClaudeConfigItem {
  if (!isRecord(payload)) throw invalidResponse();
  const { userSettings, hooksEnabled } = payload;
  if (typeof userSettings !== "boolean" || typeof hooksEnabled !== "boolean") {
    throw invalidResponse();
  }
  return { userSettings, hooksEnabled };
}

function instructionsFrom(payload: unknown): ClaudeInstructions {
  if (
    !isRecord(payload) ||
    typeof payload.path !== "string" ||
    typeof payload.exists !== "boolean" ||
    typeof payload.content !== "string"
  ) {
    throw invalidResponse();
  }
  return payload as unknown as ClaudeInstructions;
}

function skillListFrom(payload: unknown): ClaudeSkillItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) throw invalidResponse();
  return payload.skills as ClaudeSkillItem[];
}

function skillFileFrom(payload: unknown): ClaudeSkillFile {
  if (
    !isRecord(payload) ||
    typeof payload.name !== "string" ||
    typeof payload.content !== "string"
  ) {
    throw invalidResponse();
  }
  return payload as unknown as ClaudeSkillFile;
}

function questionFrom(payload: unknown): QuestionItem {
  if (
    !isRecord(payload) ||
    typeof payload.id !== "string" ||
    typeof payload.question !== "string" ||
    typeof payload.status !== "string"
  ) {
    throw invalidResponse();
  }
  return payload as unknown as QuestionItem;
}

function agentListFrom(payload: unknown): ClaudeAgentItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.agents)) throw invalidResponse();
  return payload.agents as ClaudeAgentItem[];
}

function agentFileFrom(payload: unknown): ClaudeAgentFile {
  if (
    !isRecord(payload) ||
    typeof payload.name !== "string" ||
    typeof payload.content !== "string"
  ) {
    throw invalidResponse();
  }
  return payload as unknown as ClaudeAgentFile;
}

function hookListFrom(payload: unknown): ClaudeHookItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.hooks)) throw invalidResponse();
  return payload.hooks as ClaudeHookItem[];
}

/** Bentuk plugin dari server; field yang salah jenis ditolak. */
function pluginItemFrom(value: unknown): ClaudePluginItem {
  if (!isRecord(value)) throw invalidResponse();
  const {
    id,
    name,
    marketplace,
    description,
    version,
    author,
    path,
    skills,
    commands,
    agents,
    hasHooks,
    enabled,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof marketplace !== "string" ||
    typeof description !== "string" ||
    typeof version !== "string" ||
    typeof author !== "string" ||
    typeof path !== "string" ||
    typeof skills !== "number" ||
    !Number.isFinite(skills) ||
    typeof commands !== "number" ||
    !Number.isFinite(commands) ||
    typeof agents !== "number" ||
    !Number.isFinite(agents) ||
    typeof hasHooks !== "boolean" ||
    typeof enabled !== "boolean"
  ) {
    throw invalidResponse();
  }
  return value as unknown as ClaudePluginItem;
}

/** Daftar plugin dari server; bentuk salah ditolak. */
function pluginListFrom(payload: unknown): ClaudePluginItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.plugins)) throw invalidResponse();
  return payload.plugins.map(pluginItemFrom);
}

/** Ringkasan marketplace dari server; field yang salah jenis ditolak. */
function marketplaceInfoFrom(value: unknown): MarketplaceInfoItem {
  if (!isRecord(value)) throw invalidResponse();
  const { name, description, pluginCount, lastUpdated } = value;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof pluginCount !== "number" ||
    !Number.isFinite(pluginCount) ||
    typeof lastUpdated !== "string"
  ) {
    throw invalidResponse();
  }
  return value as unknown as MarketplaceInfoItem;
}

/** Daftar marketplace dari server; bentuk salah ditolak. */
function marketplaceListFrom(payload: unknown): MarketplaceInfoItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.marketplaces)) throw invalidResponse();
  return payload.marketplaces.map(marketplaceInfoFrom);
}

/** Asal sumber plugin yang dikenal server. */
const PLUGIN_SOURCE_KINDS = new Set([
  "marketplace",
  "url",
  "git",
  "command",
  "lainnya",
]);

/** Plugin katalog dari server; field yang salah jenis ditolak. */
function marketplacePluginFrom(value: unknown): MarketplacePluginItem {
  if (!isRecord(value)) throw invalidResponse();
  const {
    id,
    name,
    displayName,
    marketplace,
    description,
    author,
    category,
    homepage,
    version,
    tags,
    sourceKind,
    installed,
  } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof displayName !== "string" ||
    typeof marketplace !== "string" ||
    typeof description !== "string" ||
    typeof author !== "string" ||
    typeof category !== "string" ||
    typeof homepage !== "string" ||
    typeof version !== "string" ||
    !Array.isArray(tags) ||
    typeof sourceKind !== "string" ||
    !PLUGIN_SOURCE_KINDS.has(sourceKind) ||
    typeof installed !== "boolean"
  ) {
    throw invalidResponse();
  }
  return value as unknown as MarketplacePluginItem;
}

/** Hasil pencarian katalog dari server; bentuk salah ditolak. */
function marketplaceSearchFrom(payload: unknown): MarketplaceSearchResult {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.items) ||
    typeof payload.total !== "number" ||
    !Number.isFinite(payload.total)
  ) {
    throw invalidResponse();
  }
  const categories = Array.isArray(payload.categories)
    ? payload.categories.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    items: payload.items.map(marketplacePluginFrom),
    total: payload.total,
    categories,
  };
}

/** Hasil perintah pasang/copot plugin dari server. */
function pluginCommandOutcomeFrom(payload: unknown): PluginCommandOutcome {
  if (
    !isRecord(payload) ||
    typeof payload.ok !== "boolean" ||
    typeof payload.message !== "string"
  ) {
    throw invalidResponse();
  }
  return { ok: payload.ok, message: payload.message };
}

/** Perintah runner dari server; `group` dan `detail` boleh absen. */
function runnerCommandFrom(payload: unknown): RunnerCommand {
  if (!isRecord(payload)) throw invalidResponse();
  const { id, label, command, source, confirmed } = payload;
  if (typeof id !== "string" || typeof label !== "string" || typeof command !== "string") {
    throw invalidResponse();
  }
  if (source !== "package" && source !== "custom") throw invalidResponse();
  if (typeof confirmed !== "boolean") throw invalidResponse();
  const result: RunnerCommand = { id, label, command, source, confirmed };
  if (typeof payload.group === "string") result.group = payload.group;
  if (typeof payload.detail === "string") result.detail = payload.detail;
  return result;
}

/** `cwd` hanya dikirim bila terisi; kunci kosong tidak ikut. */
function claudeQuery(cwd?: string): string {
  return queryString([["cwd", cwd === undefined || cwd === "" ? undefined : cwd]]);
}

/** Satu perintah slash dari server. */
function commandInfoFrom(value: unknown): CommandInfo {
  if (!isRecord(value)) throw invalidResponse();
  const { name, description, argumentHint } = value;
  if (typeof name !== "string" || typeof description !== "string" || typeof argumentHint !== "string") {
    throw invalidResponse();
  }
  const result: CommandInfo = { name, description, argumentHint };
  if (Array.isArray(value.aliases)) {
    result.aliases = value.aliases.filter((alias): alias is string => typeof alias === "string");
  }
  return result;
}

/** Daftar perintah slash beserta asalnya. */
function commandListFrom(payload: unknown): CommandListResult {
  if (!isRecord(payload) || !Array.isArray(payload.commands)) throw invalidResponse();
  const source = payload.source;
  if (source !== "sdk" && source !== "bawaan") throw invalidResponse();
  return { commands: payload.commands.map(commandInfoFrom), source };
}

/** Rujukan halaman wiki dari server. */
function wikiPageRefFrom(payload: unknown): WikiPageRef {
  if (!isRecord(payload)) throw invalidResponse();
  const { slug, title, format } = payload;
  if (typeof slug !== "string" || typeof title !== "string") throw invalidResponse();
  if (format !== "markdown" && format !== "text") throw invalidResponse();
  return { slug, title, format };
}

/** Daftar halaman wiki beserta commit dan waktu pengambilan. */
function wikiSyncFrom(payload: unknown): WikiSync {
  if (!isRecord(payload)) throw invalidResponse();
  const { commit, fetchedAt, pages } = payload;
  if (typeof commit !== "string" || typeof fetchedAt !== "string" || !Array.isArray(pages)) {
    throw invalidResponse();
  }
  const result: WikiSync = {
    commit,
    fetchedAt,
    pages: pages.map(wikiPageRefFrom),
  };
  if (typeof payload.sidebar === "string") result.sidebar = payload.sidebar;
  return result;
}

/** Isi halaman wiki beserta asal dan tanda potong. */
function wikiPageFrom(payload: unknown): WikiPage {
  if (!isRecord(payload)) throw invalidResponse();
  const page = field(payload, "page");
  if (!isRecord(page)) throw invalidResponse();
  const ref = wikiPageRefFrom(page);
  const { content, truncated, commit, fetchedAt } = page;
  if (typeof content !== "string" || typeof truncated !== "boolean") throw invalidResponse();
  if (typeof commit !== "string" || typeof fetchedAt !== "string") throw invalidResponse();
  return { ...ref, content, truncated, commit, fetchedAt };
}

/**
 * Ganti kemunculan token pada pesan galat dengan `***`. Token adalah rahasia:
 * bila server (atau apa pun) memantulkannya di pesan, klien tak boleh
 * menampilkannya.
 */
function redactTunnelToken(error: unknown, token: string | undefined): unknown {
  if (token === undefined || token === "") return error;
  if (error instanceof ApiError) {
    return new ApiError(
      error.message.split(token).join("***"),
      error.status,
      error.details,
      error.retryAfterSec,
    );
  }
  if (error instanceof Error) {
    return new Error(error.message.split(token).join("***"));
  }
  return error;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch: typeof fetch = options.fetch ?? globalThis.fetch;

  async function request(
    method: string,
    path: string,
    body?: unknown,
    requestOptions: { skipUnauthorized?: boolean } = {},
  ): Promise<unknown> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await doFetch(baseUrl + path, init);
    } catch {
      throw new ApiError("tidak dapat terhubung ke server", 0);
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ApiError("tidak dapat terhubung ke server", 0);
    }

    let parsed: unknown;
    let isJson = false;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
        isJson = true;
      } catch {
        isJson = false;
      }
    }

    if (!response.ok) {
      if (response.status === 401 && requestOptions.skipUnauthorized !== true) {
        try {
          options.onUnauthorized?.();
        } catch {
          // Callback tidak boleh mengubah respons.
        }
      }
      const serverError = field(parsed, "error");
      const message =
        isJson && typeof serverError === "string" && serverError !== ""
          ? serverError
          : `permintaan gagal (status ${response.status})`;
      const details: ApiErrorDetails = {};
      const dirtyFiles = field(parsed, "dirtyFiles");
      const commitsAhead = field(parsed, "commitsAhead");
      if (typeof dirtyFiles === "number" && Number.isFinite(dirtyFiles)) {
        details.dirtyFiles = dirtyFiles;
      }
      if (typeof commitsAhead === "number" && Number.isFinite(commitsAhead)) {
        details.commitsAhead = commitsAhead;
      }
      throw new ApiError(
        message,
        response.status,
        details.dirtyFiles === undefined && details.commitsAhead === undefined
          ? undefined
          : details,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    if (!isJson) {
      throw new ApiError(`respons server bukan JSON (status ${response.status})`, response.status);
    }

    return parsed;
  }

  return {
    async getInfo() {
      return (await request("GET", "/api/info")) as {
        name: string;
        version: string;
        cwd: string;
        mock: boolean;
      };
    },

    async getAuthStatus() {
      const data = await request("GET", "/api/auth/status");
      const required = field(data, "required") === true;
      const manual = field(data, "manualLogin");
      return {
        required,
        authenticated: field(data, "authenticated") === true,
        // Server lama tak mengirim `manualLogin`: anggap manual bila perlu
        // login, supaya perilaku peramban dan sandi tak berubah.
        manualLogin: manual === undefined ? required : manual === true,
      } satisfies AuthStatus;
    },

    async login(password: string) {
      const data = await request(
        "POST",
        "/api/auth/login",
        { password },
        { skipUnauthorized: true },
      );
      return { ok: field(data, "ok") === true };
    },

    async logout() {
      const data = await request("POST", "/api/auth/logout", {});
      return { ok: field(data, "ok") === true };
    },

    async getPasswordStatus() {
      const data = await request("GET", "/api/auth/password");
      const configured = field(data, "configured") === true;
      const updatedAt = field(data, "updatedAt");
      return {
        configured,
        ...(typeof updatedAt === "string" && updatedAt !== "" ? { updatedAt } : {}),
      } satisfies PasswordStatus;
    },

    async setPassword(input) {
      const data = await request(
        "PUT",
        "/api/auth/password",
        {
          password: input.password,
          ...(input.current === undefined ? {} : { current: input.current }),
        },
        { skipUnauthorized: true },
      );
      const updatedAt = field(data, "updatedAt");
      return {
        ok: field(data, "ok") === true,
        ...(typeof updatedAt === "string" && updatedAt !== "" ? { updatedAt } : {}),
      };
    },

    async clearPassword(current: string) {
      const data = await request(
        "DELETE",
        "/api/auth/password",
        { current },
        { skipUnauthorized: true },
      );
      return { ok: field(data, "ok") === true };
    },

    async getNetworkStatus() {
      const data = await request("GET", "/api/network");
      return parseNetworkStatus(data);
    },

    async setNetwork(input) {
      const data = await request("PUT", "/api/network", {
        enabled: input.enabled,
        ...(input.port === undefined ? {} : { port: input.port }),
      });
      return parseNetworkStatus(data);
    },

    async getTunnel() {
      const data = await request("GET", "/api/tunnel");
      return parseTunnelStatus(data);
    },

    async putTunnel(input) {
      try {
        const data = await request("PUT", "/api/tunnel", {
          enabled: input.enabled,
          ...(input.publicHost === undefined ? {} : { publicHost: input.publicHost }),
          ...(input.token === undefined ? {} : { token: input.token }),
        });
        return parseTunnelStatus(data);
      } catch (caught) {
        // Token adalah rahasia: jangan pernah ikut di pesan galat.
        throw redactTunnelToken(caught, input.token);
      }
    },

    async deleteTunnelToken() {
      const data = await request("DELETE", "/api/tunnel/token");
      return parseTunnelStatus(data);
    },

    async listSessions() {
      const data = await request("GET", "/api/sessions");
      const sessions = field(data, "sessions");
      if (!Array.isArray(sessions)) {
        throw new ApiError("respons server tidak valid", 200);
      }
      return sessions as SessionInfo[];
    },

    async getSession(id) {
      return sessionFrom(await request("GET", `/api/sessions/${encodeURIComponent(id)}`));
    },

    async renameSession(id, title) {
      return sessionFrom(
        await request("PATCH", `/api/sessions/${encodeURIComponent(id)}`, { title }),
      );
    },

    async archiveSession(id, archived) {
      return sessionFrom(
        await request("PATCH", `/api/sessions/${encodeURIComponent(id)}`, { archived }),
      );
    },

    async setSessionPermissionMode(id, mode, confirmBypass) {
      return sessionFrom(
        await request("PATCH", `/api/sessions/${encodeURIComponent(id)}`, {
          permissionMode: mode,
          ...(confirmBypass === true ? { confirmBypass: true } : {}),
        }),
      );
    },

    async setSessionProvider(id, selection) {
      return sessionFrom(
        await request("PATCH", `/api/sessions/${encodeURIComponent(id)}`, selection),
      );
    },

    async setSessionSandbox(id, mode) {
      return sessionFrom(
        await request("PATCH", `/api/sessions/${encodeURIComponent(id)}`, { sandbox: mode }),
      );
    },

    async deleteSession(id) {
      await request("DELETE", `/api/sessions/${encodeURIComponent(id)}`, {});
    },

    async createSession(input) {
      return sessionFrom(await request("POST", "/api/sessions", createSessionBody(input)));
    },

    async listHeld() {
      const data = await request("GET", "/api/held-prompts");
      const list = field(data, "held");
      if (!Array.isArray(list)) throw invalidResponse();
      return list.map(heldFrom);
    },

    async holdPrompt(input, waitForSessionId) {
      const body = { ...createSessionBody(input), waitForSessionId };
      const data = await request("POST", "/api/held-prompts", body);
      return heldPayloadFrom(data);
    },

    async cancelHeld(id) {
      const data = await request(
        "DELETE",
        `/api/held-prompts/${encodeURIComponent(id)}`,
        {},
      );
      return heldPayloadFrom(data);
    },

    async dismissHeld(id) {
      await request("DELETE", `/api/held-prompts/${encodeURIComponent(id)}`, {});
    },

    async listSchedules() {
      const data = await request("GET", "/api/schedules");
      const list = field(data, "tasks");
      if (!Array.isArray(list)) throw invalidResponse();
      return list.map(scheduleFrom);
    },

    async createSchedule(input) {
      const data = await request("POST", "/api/schedules", createScheduleBody(input));
      return schedulePayloadFrom(data);
    },

    async updateSchedule(id, patch) {
      const data = await request(
        "PATCH",
        `/api/schedules/${encodeURIComponent(id)}`,
        { ...patch },
      );
      return schedulePayloadFrom(data);
    },

    async deleteSchedule(id) {
      const data = await request("DELETE", `/api/schedules/${encodeURIComponent(id)}`, {});
      if (field(data, "ok") !== true) throw invalidResponse();
    },

    async runSchedule(id) {
      const data = await request(
        "POST",
        `/api/schedules/${encodeURIComponent(id)}/run`,
        {},
      );
      return schedulePayloadFrom(data);
    },

    async interruptSession(id) {
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/interrupt`,
        {},
      );
      return { interrupted: field(data, "interrupted") === true };
    },

    async continueSession(id) {
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/continue`,
        {},
      );
      return { ok: true as const, queued: field(data, "queued") === true };
    },

    async startGoal(id, input) {
      const body: GoalStartInput = { objective: input.objective };
      if (input.maxTurns !== undefined) body.maxTurns = input.maxTurns;
      if (input.costCapUsd !== undefined) body.costCapUsd = input.costCapUsd;
      return goalFrom(
        await request("POST", `/api/sessions/${encodeURIComponent(id)}/goal`, body),
      );
    },

    async pauseGoal(id) {
      return goalFrom(
        await request("POST", `/api/sessions/${encodeURIComponent(id)}/goal/pause`, {}),
      );
    },

    async resumeGoal(id) {
      return goalFrom(
        await request("POST", `/api/sessions/${encodeURIComponent(id)}/goal/resume`, {}),
      );
    },

    async stopGoal(id) {
      return goalFrom(
        await request("POST", `/api/sessions/${encodeURIComponent(id)}/goal/stop`, {}),
      );
    },

    async getGoal(id) {
      return goalFrom(await request("GET", `/api/sessions/${encodeURIComponent(id)}/goal`));
    },

    async uploadAttachment(file) {
      const data = await request("POST", "/api/attachments", file);
      const attachment = field(data, "attachment");
      if (typeof attachment !== "object" || attachment === null) {
        throw new ApiError("Respons lampiran tidak valid.", 500);
      }
      const record = attachment as Record<string, unknown>;
      return {
        id: String(record.id),
        name: String(record.name),
        path: String(record.path),
        size: Number(record.size),
        image: record.image === true,
      };
    },

    async sendMessage(id, text) {
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/messages`,
        { text },
      );
      return { queued: field(data, "queued") === true };
    },

    async removeQueued(id, queueId) {
      await request(
        "DELETE",
        `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(queueId)}`,
        {},
      );
      return { ok: true as const };
    },

    async sendQueuedNow(id, queueId) {
      await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(queueId)}/send-now`,
        {},
      );
      return { ok: true as const };
    },

    async steerQueued(id, queueId) {
      await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(queueId)}/steer`,
        {},
      );
      return { ok: true as const };
    },

    async askSideQuestion(id, question) {
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/btw`,
        { question },
      );
      return { answer: String(field(data, "answer") ?? "") };
    },

    async rewindConversation(id, eventSeq) {
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/rewind`,
        { eventSeq },
      );
      return { text: String(field(data, "text") ?? "") };
    },

    async getFiles(id, path, repo) {
      const query = queryString([
        ["path", path],
        ["repo", repo],
      ]);
      return (await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/files${query}`,
      )) as DirectoryListing;
    },

    async getFile(id, path, repo) {
      const query = queryString([
        ["path", path],
        ["repo", repo],
      ]);
      return (await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/file${query}`,
      )) as FileContent;
    },

    async searchFiles(id, query, options) {
      const search = queryString([
        ["q", query],
        ["repo", options?.repo],
        ["case", options?.caseSensitive === true ? "1" : undefined],
        ["regex", options?.regex === true ? "1" : undefined],
        ["word", options?.wholeWord === true ? "1" : undefined],
        ["include", options?.include && options.include.length > 0 ? options.include.join(",") : undefined],
        ["exclude", options?.exclude && options.exclude.length > 0 ? options.exclude.join(",") : undefined],
      ]);
      return (await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/search${search}`,
      )) as SearchResult;
    },

    async saveFile(id, input) {
      const body: SaveFileInput = {
        path: input.path,
        content: input.content,
        baseVersion: input.baseVersion,
      };
      if (input.repo !== undefined) body.repo = input.repo;
      const data = await request(
        "PUT",
        `/api/sessions/${encodeURIComponent(id)}/file`,
        body,
      );
      const version = field(data, "version");
      const size = field(data, "size");
      if (typeof version !== "string" || typeof size !== "number") {
        throw new ApiError("respons server tidak valid", 200);
      }
      return { ok: true, version, size };
    },

    async getChanges(id, repo) {
      const query = queryString([["repo", repo]]);
      return (await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/changes${query}`,
      )) as Changes;
    },

    async gitStatus(id, repo) {
      const query = queryString([["repo", repo]]);
      return (await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/git/status${query}`,
      )) as GitStatus;
    },

    async gitLog(id, options) {
      const query = queryString([
        ["repo", options?.repo],
        ["limit", options?.limit === undefined ? undefined : String(options.limit)],
      ]);
      const data = await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/git/log${query}`,
      );
      const commits = field(data, "commits");
      if (!Array.isArray(commits)) {
        throw new ApiError("respons server tidak valid", 200);
      }
      return { commits: commits as GitCommit[] };
    },

    async gitShow(id, hash, repo) {
      const query = queryString([
        ["repo", repo],
        ["hash", hash],
      ]);
      const data = await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/git/show${query}`,
      );
      return gitShowFrom(data);
    },

    async gitStage(id, input) {
      await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/git/stage`,
        stageBody(input),
      );
    },

    async gitUnstage(id, input) {
      await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/git/unstage`,
        stageBody(input),
      );
    },

    async gitCommit(id, message, repo) {
      const body: { message: string; repo?: string } = { message };
      if (repo !== undefined) body.repo = repo;
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/git/commit`,
        body,
      );
      const hash = field(data, "hash");
      const short = field(data, "short");
      const subject = field(data, "subject");
      if (typeof hash !== "string" || typeof short !== "string" || typeof subject !== "string") {
        throw new ApiError("respons server tidak valid", 200);
      }
      return { hash, short, subject };
    },

    async getWorktree(id) {
      const data = await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/worktree`,
      );
      const worktree = field(data, "worktree");
      const inspect = field(data, "inspect");
      if (
        !isRecord(worktree) ||
        typeof worktree.repoRoot !== "string" ||
        typeof worktree.path !== "string" ||
        typeof worktree.branch !== "string" ||
        typeof worktree.baseCommit !== "string" ||
        !isRecord(inspect) ||
        typeof inspect.exists !== "boolean" ||
        typeof inspect.dirtyFiles !== "number" ||
        typeof inspect.commitsAhead !== "number" ||
        typeof inspect.branchExists !== "boolean"
      ) {
        throw invalidResponse();
      }
      return { worktree, inspect } as unknown as WorktreeView;
    },

    async removeWorktree(id, options) {
      const body: { force?: true } = {};
      if (options?.force === true) body.force = true;
      await request("DELETE", `/api/sessions/${encodeURIComponent(id)}/worktree`, body);
    },

    async restoreWorktree(id) {
      await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/worktree/restore`,
        {},
      );
    },

    async browseDirs(path) {
      const query = queryString([["path", path]]);
      return (await request("GET", `/api/fs/dirs${query}`)) as BrowseResult;
    },

    async nativePickerAvailable() {
      const data = await request("GET", "/api/fs/native");
      return field(data, "available") === true;
    },

    async pickFolderNative(start) {
      const data = await request("POST", "/api/fs/pick", start === undefined ? {} : { start });
      const path = field(data, "path");
      return typeof path === "string" && path !== "" ? path : undefined;
    },

    async listProviderModels(profileId) {
      const data = await request("POST", "/api/providers/models", { profileId });
      const result = field(data, "result");
      if (!isRecord(result) || typeof result.ok !== "boolean" || !Array.isArray(result.models)) {
        throw new ApiError("respons server tidak valid", 200);
      }
      const models = result.models.filter((id): id is string => typeof id === "string");
      const view: { ok: boolean; models: string[]; error?: string } = { ok: result.ok, models };
      if (typeof result.error === "string") view.error = result.error;
      return view;
    },

    async rejectChange(id, input) {
      const body: RejectChangeInput = { ...input };
      if (body.repo === undefined) delete body.repo;
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/changes/reject`,
        body,
      );
      const undoId = field(data, "undoId");
      const path = field(data, "path");
      const scope = field(data, "scope");
      if (typeof undoId !== "string" || typeof path !== "string") {
        throw new ApiError("respons server tidak valid", 200);
      }
      return { undoId, path, scope: scope === "file" ? "file" : "hunk" };
    },

    async undoChange(id, undoId, repo) {
      const body: { undoId: string; repo?: string } = { undoId };
      if (repo !== undefined) body.repo = repo;
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/changes/undo`,
        body,
      );
      const path = field(data, "path");
      if (typeof path !== "string") {
        throw new ApiError("respons server tidak valid", 200);
      }
      return { path };
    },

    async getCheckpoints(id) {
      return checkpointListFrom(
        await request("GET", `/api/sessions/${encodeURIComponent(id)}/checkpoints`),
      );
    },

    async createCheckpoint(id, label) {
      const body = label === undefined ? {} : { label };
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/checkpoints`,
        body,
      );
      return checkpointItemFrom(field(data, "item"));
    },

    async previewCheckpoint(id, cid) {
      return checkpointPreviewFrom(
        await request(
          "GET",
          `/api/sessions/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(cid)}/preview`,
        ),
      );
    },

    async rewindCheckpoint(id, cid) {
      return rewindResultFrom(
        await request(
          "POST",
          `/api/sessions/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(cid)}/rewind`,
          { confirm: true },
        ),
      );
    },

    async getProviders() {
      return request("GET", "/api/providers");
    },

    async saveProviders(registry) {
      return request("PUT", "/api/providers", registry);
    },

    async setActiveProvider(profileId) {
      return request("POST", "/api/providers/active", { profileId });
    },

    async testProvider(selection) {
      return connectionTestFrom(await request("POST", "/api/providers/test", selection ?? {}));
    },

    async decidePermission(sessionId, requestId, decision, message, answers) {
      const body: {
        decision: "allow" | "deny";
        message?: string;
        answers?: Record<string, string>;
      } = { decision };
      if (answers !== undefined) body.answers = answers;
      if (message !== undefined) {
        body.message = message;
      }
      await request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`, body);
      return { ok: true };
    },

    async listMemory(params) {
      const data = await request("GET", `/api/memory${memoryQuery(params)}`);
      const items = field(data, "items");
      if (!Array.isArray(items)) {
        throw new ApiError("respons server tidak valid", 200);
      }
      const counts = field(data, "counts");
      const problems = field(data, "problems");
      const proposed = field(counts, "proposed");
      const active = field(counts, "active");
      return {
        items: items.map((entry) => memoryItemFrom(entry)),
        counts: {
          proposed: typeof proposed === "number" ? proposed : 0,
          active: typeof active === "number" ? active : 0,
        },
        problems: Array.isArray(problems) ? (problems as MemoryProblem[]) : [],
      };
    },

    async listClaudeMemory(project) {
      const data = await request(
        "GET",
        `/api/memory/claude?project=${encodeURIComponent(project)}`,
      );
      const parsed = parseClaudeMemoryResponse(data);
      if (parsed === null) {
        throw new ApiError("respons server tidak valid", 200);
      }
      return parsed;
    },

    async createMemory(input) {
      return memoryFrom(await request("POST", "/api/memory", input));
    },

    async getClaudeMemorySync() {
      const data = await request("GET", "/api/memory/claude/sync");
      const parsed = parseClaudeMemorySyncState(data);
      if (parsed === null) throw new ApiError("respons server tidak valid", 200);
      return parsed;
    },

    async setClaudeMemorySync(enabled) {
      const data = await request("PUT", "/api/memory/claude/sync", { enabled });
      const parsed = parseClaudeMemorySyncState(data);
      if (parsed === null) throw new ApiError("respons server tidak valid", 200);
      return parsed;
    },

    async runClaudeMemorySync() {
      const data = await request("POST", "/api/memory/claude/sync/run", {});
      const parsed = parseClaudeMemorySyncRun(data);
      if (parsed === null) throw new ApiError("respons server tidak valid", 200);
      return parsed;
    },

    async updateMemory(id, input) {
      return memoryFrom(await request("PATCH", `/api/memory/${encodeURIComponent(id)}`, input));
    },

    async createTerminal(cwd, size) {
      const data = await request("POST", "/api/terminal", { cwd, ...(size ?? {}) });
      if (!isRecord(data) || typeof data.id !== "string") throw invalidResponse();
      return data as unknown as TerminalItem;
    },

    async closeTerminal(id) {
      await request("DELETE", `/api/terminal/${encodeURIComponent(id)}`, {});
    },

    async listRunner(cwd) {
      const data = await request("GET", `/api/runner${queryString([["cwd", cwd]])}`);
      if (!isRecord(data) || !Array.isArray(data.commands)) throw invalidResponse();
      return { commands: data.commands.map(runnerCommandFrom) };
    },

    async addRunnerCommand(cwd, form) {
      const data = await request("POST", "/api/runner/custom", {
        cwd,
        label: form.label,
        command: form.command,
        ...(form.group === undefined || form.group === "" ? {} : { group: form.group }),
      });
      if (!isRecord(data)) throw invalidResponse();
      return runnerCommandFrom(data.command);
    },

    async updateRunnerCommand(cwd, id, patch) {
      const body: Record<string, unknown> = { cwd };
      if (patch.label !== undefined) body.label = patch.label;
      if (patch.command !== undefined) body.command = patch.command;
      if (patch.group !== undefined) body.group = patch.group;
      const data = await request(
        "PATCH",
        `/api/runner/custom/${encodeURIComponent(id)}`,
        body,
      );
      if (!isRecord(data)) throw invalidResponse();
      return runnerCommandFrom(data.command);
    },

    async deleteRunnerCommand(cwd, id) {
      await request(
        "DELETE",
        `/api/runner/custom/${encodeURIComponent(id)}${queryString([["cwd", cwd]])}`,
        {},
      );
    },

    async runRunnerCommand(cwd, id, confirm) {
      const data = await request("POST", "/api/runner/run", {
        cwd,
        id,
        ...(confirm === undefined ? {} : { confirm }),
      });
      if (!isRecord(data) || typeof data.terminalId !== "string") throw invalidResponse();
      return { terminalId: data.terminalId };
    },

    async wikiProject(cwd) {
      const data = await request("GET", `/api/wiki/project${queryString([["cwd", cwd]])}`);
      if (!isRecord(data)) throw invalidResponse();
      const providerId = field(data, "providerId");
      const fullPath = field(data, "fullPath");
      if (typeof providerId !== "string" || typeof fullPath !== "string") {
        throw invalidResponse();
      }
      return { providerId, fullPath };
    },

    async wikiSync(providerId, fullPath) {
      const data = await request("POST", "/api/wiki/sync", { providerId, fullPath });
      return wikiSyncFrom(data);
    },

    async wikiPages(providerId, fullPath) {
      const query = queryString([
        ["providerId", providerId],
        ["fullPath", fullPath],
      ]);
      return wikiSyncFrom(await request("GET", `/api/wiki/pages${query}`));
    },

    async wikiPage(providerId, fullPath, slug) {
      const query = queryString([
        ["providerId", providerId],
        ["fullPath", fullPath],
        ["slug", slug],
      ]);
      return wikiPageFrom(await request("GET", `/api/wiki/page${query}`));
    },

    async listGitProviders() {
      const data = await request("GET", "/api/git-providers");
      if (!isRecord(data) || !Array.isArray(data.providers)) throw invalidResponse();
      return data.providers as GitProviderItem[];
    },

    async putGitProvider(id, input) {
      const data = await request("PUT", `/api/git-providers/${encodeURIComponent(id)}`, input);
      if (!isRecord(data) || typeof data.id !== "string") throw invalidResponse();
      return data as unknown as GitProviderItem;
    },

    async deleteGitProvider(id) {
      await request("DELETE", `/api/git-providers/${encodeURIComponent(id)}`, {});
    },

    async listProviderRepos(id) {
      const data = await request("GET", `/api/git-providers/${encodeURIComponent(id)}/repos`);
      if (!isRecord(data) || !Array.isArray(data.repos)) throw invalidResponse();
      return data.repos as RemoteRepoItem[];
    },

    async listIndexedRepos() {
      const data = await request("GET", "/api/index/repos");
      if (!isRecord(data) || !Array.isArray(data.repos)) throw invalidResponse();
      return data.repos as IndexedRepoItem[];
    },

    async indexRepo(providerId, fullPath) {
      const data = await request("POST", "/api/index/repos", { providerId, fullPath });
      if (!isRecord(data) || typeof data.key !== "string") throw invalidResponse();
      return data as unknown as IndexedRepoItem;
    },

    async deleteIndexedRepo(key) {
      await request("DELETE", `/api/index/repos/${encodeURIComponent(key)}`, {});
    },

    async listQuestions(status) {
      const data = await request(
        "GET",
        `/api/questions${status === undefined ? "" : `?status=${encodeURIComponent(status)}`}`,
      );
      if (!isRecord(data) || !Array.isArray(data.items)) throw invalidResponse();
      return {
        items: data.items.map(questionFrom),
        open: typeof data.open === "number" ? data.open : 0,
      };
    },

    async assignQuestion(id, assignee) {
      return questionFrom(
        await request("PATCH", `/api/questions/${encodeURIComponent(id)}`, { assignee }),
      );
    },

    async answerQuestion(id, answer, by) {
      return questionFrom(
        await request("POST", `/api/questions/${encodeURIComponent(id)}/answer`, { answer, by }),
      );
    },

    async dismissQuestion(id) {
      return questionFrom(
        await request("POST", `/api/questions/${encodeURIComponent(id)}/dismiss`, {}),
      );
    },

    async acceptMemory(id) {
      return memoryFrom(await request("POST", `/api/memory/${encodeURIComponent(id)}/accept`, {}));
    },

    async rejectMemory(id) {
      return memoryFrom(await request("POST", `/api/memory/${encodeURIComponent(id)}/reject`, {}));
    },

    async archiveMemory(id) {
      return memoryFrom(await request("POST", `/api/memory/${encodeURIComponent(id)}/archive`, {}));
    },

    async deleteMemory(id) {
      await request("DELETE", `/api/memory/${encodeURIComponent(id)}`, {});
    },

    async importMemory(projectKey) {
      return memoryImportFrom(await request("POST", "/api/memory/import", { projectKey }));
    },

    async consolidateMemory(projectKey) {
      const data = await request("POST", "/api/memory/consolidate", { projectKey });
      const sources = field(data, "sources");
      return {
        item: memoryFrom(data),
        sources: typeof sources === "number" ? sources : 0,
      };
    },

    async listWorkspaces() {
      return workspaceListFrom(await request("GET", "/api/workspaces"));
    },

    async createWorkspace(input) {
      return workspaceFrom(await request("POST", "/api/workspaces", input));
    },

    async updateWorkspace(id, input) {
      return workspaceFrom(
        await request("PATCH", `/api/workspaces/${encodeURIComponent(id)}`, input),
      );
    },

    async setWorkspaceCard(id, repoName, card) {
      return workspaceFrom(
        await request(
          "PUT",
          `/api/workspaces/${encodeURIComponent(id)}/repos/${encodeURIComponent(repoName)}/card`,
          card,
        ),
      );
    },

    async deleteWorkspace(id) {
      await request("DELETE", `/api/workspaces/${encodeURIComponent(id)}`, {});
    },

    async listMcpServers() {
      return mcpListFrom(await request("GET", "/api/mcp-servers"));
    },

    async createMcpServer(input) {
      return mcpServerFrom(await request("POST", "/api/mcp-servers", input));
    },

    async updateMcpServer(id, input) {
      return mcpServerFrom(
        await request("PATCH", `/api/mcp-servers/${encodeURIComponent(id)}`, input),
      );
    },

    async deleteMcpServer(id) {
      await request("DELETE", `/api/mcp-servers/${encodeURIComponent(id)}`, {});
    },

    async testMcpServer(id) {
      return mcpTestFrom(
        await request("POST", `/api/mcp-servers/${encodeURIComponent(id)}/test`, {}),
      );
    },

    async listAudit(query) {
      const session = query?.session;
      const kind = query?.kind;
      const search = queryString([
        ["session", session === undefined || session === "" ? undefined : session],
        ["kind", kind === undefined || kind === "" ? undefined : kind],
        ["before", query?.before === undefined ? undefined : String(query.before)],
        ["limit", query?.limit === undefined ? undefined : String(query.limit)],
      ]);
      return auditListFrom(await request("GET", `/api/audit${search}`));
    },

    async getAuditSummary() {
      return auditSummaryFrom(await request("GET", "/api/audit/summary"));
    },

    async getUsage(days) {
      // `tz` adalah menit timur dari UTC: tanda dibalik dari
      // `Date.getTimezoneOffset()`.
      const tz = -new Date().getTimezoneOffset();
      const search = queryString([
        ["days", String(days)],
        ["tz", String(tz)],
      ]);
      return usageResponseFrom(await request("GET", `/api/usage${search}`));
    },

    async getSecretAllow(sessionId) {
      return secretAllowStateFrom(
        await request(
          "GET",
          `/api/sessions/${encodeURIComponent(sessionId)}/secret-allow`,
        ),
      );
    },

    async addSecretAllow(sessionId, path) {
      return secretAllowAddFrom(
        await request(
          "POST",
          `/api/sessions/${encodeURIComponent(sessionId)}/secret-allow`,
          { path },
        ),
      );
    },

    async removeSecretAllow(sessionId, path) {
      return secretAllowRemoveFrom(
        await request(
          "DELETE",
          `/api/sessions/${encodeURIComponent(sessionId)}/secret-allow`,
          { path },
        ),
      );
    },

    async getCommandEnv(sessionId) {
      return commandEnvStateFrom(
        await request(
          "GET",
          `/api/sessions/${encodeURIComponent(sessionId)}/command-env`,
        ),
      );
    },

    async setCommandEnv(sessionId, path) {
      return commandEnvStateFrom(
        await request(
          "PUT",
          `/api/sessions/${encodeURIComponent(sessionId)}/command-env`,
          { path },
        ),
      );
    },

    async clearCommandEnv(sessionId) {
      return commandEnvClearFrom(
        await request(
          "DELETE",
          `/api/sessions/${encodeURIComponent(sessionId)}/command-env`,
        ),
      );
    },

    async getBudget() {
      return budgetConfigFrom(await request("GET", "/api/budget"));
    },

    async putBudget(patch) {
      const body: BudgetPatch = {};
      if (patch.sessionUsd !== undefined) body.sessionUsd = patch.sessionUsd;
      if (patch.dailyUsd !== undefined) body.dailyUsd = patch.dailyUsd;
      if (patch.warnAt !== undefined) body.warnAt = patch.warnAt;
      return budgetConfigFrom(await request("PUT", "/api/budget", body));
    },

    async getBudgetStatus(sessionId) {
      const search = sessionId === undefined || sessionId === ""
        ? ""
        : `?session=${encodeURIComponent(sessionId)}`;
      return budgetStatusFrom(await request("GET", `/api/budget/status${search}`));
    },

    async getSandbox() {
      return sandboxStateFrom(await request("GET", "/api/sandbox"));
    },

    async putSandbox(patch) {
      const body: SandboxPatch = {};
      if (patch.mode !== undefined) body.mode = patch.mode;
      if (patch.allowedDomains !== undefined) body.allowedDomains = patch.allowedDomains;
      if (patch.extraDenyRead !== undefined) body.extraDenyRead = patch.extraDenyRead;
      if (patch.extraDenyWrite !== undefined) body.extraDenyWrite = patch.extraDenyWrite;
      if (patch.extraAllowWrite !== undefined) body.extraAllowWrite = patch.extraAllowWrite;
      if (patch.extraAllowUnixSockets !== undefined) {
        body.extraAllowUnixSockets = patch.extraAllowUnixSockets;
      }
      if (patch.allowLocalBinding !== undefined) body.allowLocalBinding = patch.allowLocalBinding;
      const data = await request("PUT", "/api/sandbox", body);
      return sandboxConfigFrom(field(data, "config"));
    },

    async getFeatures() {
      const data = await request("GET", "/api/features");
      const parsed = parseFeatureStatus(data);
      if (parsed === undefined) throw new ApiError("respons server tidak valid", 200);
      return parsed;
    },

    async putFeatures(patch) {
      const body: Record<string, boolean> = {};
      if (patch.terminal !== undefined) body.terminal = patch.terminal;
      if (patch.browser !== undefined) body.browser = patch.browser;
      const data = await request("PUT", "/api/features", body);
      const parsed = parseFeatureStatus(data);
      if (parsed === undefined) throw new ApiError("respons server tidak valid", 200);
      return parsed;
    },

    async getSdk() {
      return sdkStatusFrom(await request("GET", "/api/sdk"));
    },

    async checkSdk() {
      return sdkCheckFrom(await request("POST", "/api/sdk/check", {}));
    },

    async installSdk(version) {
      // Penjaga server mewajibkan content-type JSON di setiap POST, jadi body tidak boleh kosong.
      const body = version === undefined ? {} : { version };
      return sdkInstallFrom(await request("POST", "/api/sdk/install", body));
    },

    async rollbackSdk() {
      return sdkInstallFrom(await request("POST", "/api/sdk/rollback", {}));
    },

    async setClaudePath(path) {
      // Penjaga server mewajibkan content-type JSON; body selalu berisi `path`.
      return sdkClaudeFrom(await request("POST", "/api/sdk/claude-path", { path }));
    },

    async checkSdkCli() {
      return sdkCliCheckFrom(await request("POST", "/api/sdk/check-cli", {}));
    },

    async installSdkCli() {
      const payload = await request("POST", "/api/sdk/install-cli", {});
      const record = isRecord(payload) ? payload : {};
      return { ok: record.ok === true, cli: sdkCliFrom(record.cli) };
    },

    async removeSdkCli() {
      const payload = await request("POST", "/api/sdk/remove-cli", {});
      const record = isRecord(payload) ? payload : {};
      return { ok: record.ok === true, cli: sdkCliFrom(record.cli) };
    },

    async getClaudeConfig() {
      return claudeConfigFrom(await request("GET", "/api/claude/config"));
    },

    async putClaudeConfig(patch) {
      const body: ClaudeConfigPatch = {};
      if (patch.userSettings !== undefined) body.userSettings = patch.userSettings;
      if (patch.hooksEnabled !== undefined) body.hooksEnabled = patch.hooksEnabled;
      return claudeConfigFrom(await request("PUT", "/api/claude/config", body));
    },

    async getInstructions(scope, cwd) {
      const search = queryString([
        ["scope", scope],
        ["cwd", cwd === undefined || cwd === "" ? undefined : cwd],
      ]);
      return instructionsFrom(await request("GET", `/api/claude/instructions${search}`));
    },

    async putInstructions(scope, content, cwd) {
      const search = queryString([
        ["scope", scope],
        ["cwd", cwd === undefined || cwd === "" ? undefined : cwd],
      ]);
      return instructionsFrom(
        await request("PUT", `/api/claude/instructions${search}`, { content }),
      );
    },

    async listSkills(cwd) {
      return skillListFrom(await request("GET", `/api/claude/skills${claudeQuery(cwd)}`));
    },

    async getSkill(scope, name, cwd) {
      return skillFileFrom(
        await request(
          "GET",
          `/api/claude/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}${claudeQuery(cwd)}`,
        ),
      );
    },

    async putSkill(scope, name, content, cwd) {
      return skillFileFrom(
        await request(
          "PUT",
          `/api/claude/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}${claudeQuery(cwd)}`,
          { content },
        ),
      );
    },

    async listAgents(cwd) {
      return agentListFrom(await request("GET", `/api/claude/agents${claudeQuery(cwd)}`));
    },

    async getAgent(scope, name, cwd) {
      return agentFileFrom(
        await request(
          "GET",
          `/api/claude/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}${claudeQuery(cwd)}`,
        ),
      );
    },

    async putAgent(scope, name, content, cwd) {
      return agentFileFrom(
        await request(
          "PUT",
          `/api/claude/agents/${encodeURIComponent(scope)}/${encodeURIComponent(name)}${claudeQuery(cwd)}`,
          { content },
        ),
      );
    },

    async setSkillEnabled(scope, name, enabled, cwd) {
      const data = await request(
        "PUT",
        `/api/claude/skills/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/enabled${claudeQuery(cwd)}`,
        { enabled },
      );
      if (!isRecord(data) || typeof data.name !== "string" || typeof data.enabled !== "boolean") {
        throw invalidResponse();
      }
      return {
        scope: data.scope === "user" ? "user" : "project",
        name: data.name,
        enabled: data.enabled,
      };
    },

    async listHooks(cwd) {
      return hookListFrom(await request("GET", `/api/claude/hooks${claudeQuery(cwd)}`));
    },

    async listPlugins() {
      return pluginListFrom(await request("GET", "/api/claude/plugins"));
    },

    async setPluginEnabled(id, enabled) {
      const data = await request(
        "PUT",
        `/api/claude/plugins/${encodeURIComponent(id)}`,
        { enabled },
      );
      if (!isRecord(data) || typeof data.id !== "string" || typeof data.enabled !== "boolean") {
        throw invalidResponse();
      }
    },

    async listMarketplaces() {
      return marketplaceListFrom(await request("GET", "/api/claude/marketplaces"));
    },

    async searchMarketplace(options) {
      const search = queryString([
        ["query", options?.query],
        ["marketplace", options?.marketplace],
        ["category", options?.category],
        ["limit", options?.limit === undefined ? undefined : String(options.limit)],
        ["offset", options?.offset === undefined ? undefined : String(options.offset)],
      ]);
      return marketplaceSearchFrom(
        await request("GET", `/api/claude/marketplace/plugins${search}`),
      );
    },

    async installPlugin(id) {
      return pluginCommandOutcomeFrom(
        await request("POST", "/api/claude/plugins/install", { id }),
      );
    },

    async uninstallPlugin(id) {
      return pluginCommandOutcomeFrom(
        await request("POST", "/api/claude/plugins/uninstall", { id }),
      );
    },

    async listCommands(cwd) {
      return commandListFrom(
        await request("GET", `/api/commands${queryString([["cwd", cwd]])}`),
      );
    },
  };
}
