import type { AuditEntry, AuditSummary } from "../../server/audit/audit-store";
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
import type { HookInfo } from "../../server/claude-config/hooks";
import type { InstructionFile } from "../../server/claude-config/instructions";
import type { TerminalInfo } from "../../server/terminal/terminal-manager";
import type { RemoteRepo } from "../../server/gitprovider/adapters";
import type { GitProviderView } from "../../server/gitprovider/provider-store";
import type { IndexedRepo } from "../../server/indexer/repo-indexer";
import type { Question } from "../../server/questions/question-store";
import type { AgentInfo } from "../../server/claude-config/agents";
import type { SkillInfo } from "../../server/claude-config/skills";
import type { SessionInfo } from "../../server/sessions/session-manager";
import type {
  ServiceCard,
  ServiceKind,
  WorkspaceProblem,
  WorkspaceRepo,
} from "../../server/workspaces/workspace-files";
import type { WorkspaceView } from "../../server/workspaces/workspace-service";

export type AuditEntryItem = AuditEntry;
export type AuditSummaryResult = AuditSummary;

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

export type MemoryItem = Memory;
export type MemoryImportResult = ImportResult;

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
}

export interface SandboxState {
  config: SandboxConfigItem;
  defaults: { allowedDomains: string[]; denyRead: string[]; denyWrite: string[] };
  available: { ok: boolean; detail: string };
}

export type SandboxPatch = Partial<SandboxConfigItem>;

export interface ApiClient {
  getInfo(): Promise<{ name: string; version: string; cwd: string; mock: boolean }>;
  listSessions(): Promise<SessionInfo[]>;
  getSession(id: string): Promise<SessionInfo>;
  renameSession(id: string, title: string): Promise<SessionInfo>;
  archiveSession(id: string, archived: boolean): Promise<SessionInfo>;
  setSessionPermissionMode(
    id: string,
    mode: "default" | "acceptEdits" | "plan" | "bypassPermissions",
    confirmBypass?: boolean,
  ): Promise<SessionInfo>;
  deleteSession(id: string): Promise<void>;
  createSession(input: {
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
  }): Promise<SessionInfo>;
  interruptSession(id: string): Promise<{ interrupted: boolean }>;
  sendMessage(id: string, text: string): Promise<{ queued: boolean }>;
  uploadAttachment(file: {
    name: string;
    data: string;
  }): Promise<{ id: string; name: string; path: string; size: number; image: boolean }>;
  getFiles(id: string, path?: string, repo?: string): Promise<DirectoryListing>;
  getFile(id: string, path: string, repo?: string): Promise<FileContent>;
  searchFiles(
    id: string,
    query: string,
    options?: { repo?: string; caseSensitive?: boolean },
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
  createMemory(input: MemoryCreateInput): Promise<MemoryItem>;
  updateMemory(id: string, input: MemoryUpdateInput): Promise<MemoryItem>;
  createTerminal(cwd: string, size?: { cols: number; rows: number }): Promise<TerminalItem>;
  sendTerminalInput(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
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
  getSecretAllow(sessionId: string): Promise<SecretAllowState>;
  addSecretAllow(sessionId: string, path: string): Promise<SecretAllowAddResult>;
  removeSecretAllow(
    sessionId: string,
    path: string,
  ): Promise<{ removed: boolean; allowed: string[] }>;
  getBudget(): Promise<BudgetConfigItem>;
  /** `null` pada batas berarti hapus batas. */
  putBudget(patch: BudgetPatch): Promise<BudgetConfigItem>;
  getBudgetStatus(sessionId?: string): Promise<BudgetStatusResult>;
  getSandbox(): Promise<SandboxState>;
  putSandbox(patch: SandboxPatch): Promise<SandboxConfigItem>;
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
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function sessionFrom(payload: unknown): SessionInfo {
  const session = field(payload, "session");
  if (!isRecord(session)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  return session as unknown as SessionInfo;
}

function memoryFrom(payload: unknown): MemoryItem {
  const item = field(payload, "item");
  if (!isRecord(item)) {
    throw new ApiError("respons server tidak valid", 200);
  }
  return item as unknown as MemoryItem;
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

/** `cwd` hanya dikirim bila terisi; kunci kosong tidak ikut. */
function claudeQuery(cwd?: string): string {
  return queryString([["cwd", cwd === undefined || cwd === "" ? undefined : cwd]]);
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch: typeof fetch = options.fetch ?? globalThis.fetch;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
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

    async deleteSession(id) {
      await request("DELETE", `/api/sessions/${encodeURIComponent(id)}`, {});
    },

    async createSession(input) {
      const body: Parameters<ApiClient["createSession"]>[0] = { ...input };
      if (body.confirmBypass !== true) delete body.confirmBypass;
      if (body.worktree !== true) delete body.worktree;
      if (body.sandbox !== "mati" && body.sandbox !== "standar") delete body.sandbox;
      return sessionFrom(await request("POST", "/api/sessions", body));
    },

    async interruptSession(id) {
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/interrupt`,
        {},
      );
      return { interrupted: field(data, "interrupted") === true };
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
        items: items as MemoryItem[],
        counts: {
          proposed: typeof proposed === "number" ? proposed : 0,
          active: typeof active === "number" ? active : 0,
        },
        problems: Array.isArray(problems) ? (problems as MemoryProblem[]) : [],
      };
    },

    async createMemory(input) {
      return memoryFrom(await request("POST", "/api/memory", input));
    },

    async updateMemory(id, input) {
      return memoryFrom(await request("PATCH", `/api/memory/${encodeURIComponent(id)}`, input));
    },

    async createTerminal(cwd, size) {
      const data = await request("POST", "/api/terminal", { cwd, ...(size ?? {}) });
      if (!isRecord(data) || typeof data.id !== "string") throw invalidResponse();
      return data as unknown as TerminalItem;
    },

    async sendTerminalInput(id, data) {
      await request("POST", `/api/terminal/${encodeURIComponent(id)}/input`, { data });
    },

    async resizeTerminal(id, cols, rows) {
      await request("POST", `/api/terminal/${encodeURIComponent(id)}/resize`, { cols, rows });
    },

    async closeTerminal(id) {
      await request("DELETE", `/api/terminal/${encodeURIComponent(id)}`, {});
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
      const data = await request("PUT", "/api/sandbox", body);
      return sandboxConfigFrom(field(data, "config"));
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
  };
}
