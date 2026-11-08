import type {
  ChangeAction,
  CheckpointChange,
  CheckpointItem,
  CheckpointKind,
  ListCheckpointsResult,
  PreviewResult,
  RewindResult,
} from "../../server/checkpoints/checkpoint-service";
import type { Changes } from "../../server/files/changes";
import type { DirectoryListing } from "../../server/files/list";
import type { FileContent } from "../../server/files/read";
import type { MemoryCounts, MemoryProblem } from "../../server/memory/memory-index";
import type {
  Memory,
  MemoryLayer,
  MemoryStatus,
} from "../../server/memory/memory-files";
import type { ImportResult } from "../../server/memory/memory-service";
import type { SessionInfo } from "../../server/sessions/session-manager";
import type {
  ServiceCard,
  ServiceKind,
  WorkspaceProblem,
  WorkspaceRepo,
} from "../../server/workspaces/workspace-files";
import type { WorkspaceView } from "../../server/workspaces/workspace-service";

export type {
  ChangeAction,
  CheckpointChange,
  CheckpointItem,
  CheckpointKind,
  RewindResult,
};
export type CheckpointList = ListCheckpointsResult;
export type CheckpointPreview = PreviewResult;

export type {
  ChangedFile,
  ChangeStatus,
  Changes,
  DiffLine,
  Hunk,
} from "../../server/files/changes";
export type { DirEntry, DirectoryListing } from "../../server/files/list";
export type { FileContent } from "../../server/files/read";
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

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
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

export interface ApiClient {
  getInfo(): Promise<{ name: string; version: string; cwd: string; mock: boolean }>;
  listSessions(): Promise<SessionInfo[]>;
  getSession(id: string): Promise<SessionInfo>;
  renameSession(id: string, title: string): Promise<SessionInfo>;
  archiveSession(id: string, archived: boolean): Promise<SessionInfo>;
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
  }): Promise<SessionInfo>;
  interruptSession(id: string): Promise<{ interrupted: boolean }>;
  sendMessage(id: string, text: string): Promise<{ queued: boolean }>;
  getFiles(id: string, path?: string, repo?: string): Promise<DirectoryListing>;
  getFile(id: string, path: string, repo?: string): Promise<FileContent>;
  getChanges(id: string, repo?: string): Promise<Changes>;
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
  ): Promise<{ ok: true }>;
  getProviders(): Promise<unknown>;
  saveProviders(registry: unknown): Promise<unknown>;
  setActiveProvider(profileId: string): Promise<unknown>;
  testProvider(selection?: { profileId?: string; model?: string }): Promise<ConnectionTestView>;
  listMemory(params?: MemoryQuery): Promise<MemoryList>;
  createMemory(input: MemoryCreateInput): Promise<MemoryItem>;
  updateMemory(id: string, input: MemoryUpdateInput): Promise<MemoryItem>;
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

function memoryQuery(params: MemoryQuery | undefined): string {
  if (params === undefined) return "";
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
      throw new ApiError(message, response.status);
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

    async deleteSession(id) {
      await request("DELETE", `/api/sessions/${encodeURIComponent(id)}`, {});
    },

    async createSession(input) {
      const body: Parameters<ApiClient["createSession"]>[0] = { ...input };
      if (body.confirmBypass !== true) delete body.confirmBypass;
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

    async getChanges(id, repo) {
      const query = queryString([["repo", repo]]);
      return (await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/changes${query}`,
      )) as Changes;
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

    async decidePermission(sessionId, requestId, decision, message) {
      const body: { decision: "allow" | "deny"; message?: string } = { decision };
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
  };
}
