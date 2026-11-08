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
  createSession(input: {
    prompt: string;
    cwd: string;
    title?: string;
    profileId?: string;
    model?: string;
    lightModel?: string;
    permissionMode?: "default" | "acceptEdits" | "plan";
  }): Promise<SessionInfo>;
  interruptSession(id: string): Promise<{ interrupted: boolean }>;
  sendMessage(id: string, text: string): Promise<{ queued: boolean }>;
  getFiles(id: string, path?: string): Promise<DirectoryListing>;
  getFile(id: string, path: string): Promise<FileContent>;
  getChanges(id: string): Promise<Changes>;
  rejectChange(id: string, input: RejectChangeInput): Promise<RejectChangeResult>;
  undoChange(id: string, undoId: string): Promise<{ path: string }>;
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

const TOOL_CALLING_VALUES = new Set(["ok", "tidak-dipanggil", "tidak-diuji"]);

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

    async createSession(input) {
      return sessionFrom(await request("POST", "/api/sessions", input));
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

    async getFiles(id, path) {
      const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
      return (await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/files${query}`,
      )) as DirectoryListing;
    },

    async getFile(id, path) {
      return (await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
      )) as FileContent;
    },

    async getChanges(id) {
      return (await request(
        "GET",
        `/api/sessions/${encodeURIComponent(id)}/changes`,
      )) as Changes;
    },

    async rejectChange(id, input) {
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/changes/reject`,
        input,
      );
      const undoId = field(data, "undoId");
      const path = field(data, "path");
      const scope = field(data, "scope");
      if (typeof undoId !== "string" || typeof path !== "string") {
        throw new ApiError("respons server tidak valid", 200);
      }
      return { undoId, path, scope: scope === "file" ? "file" : "hunk" };
    },

    async undoChange(id, undoId) {
      const data = await request(
        "POST",
        `/api/sessions/${encodeURIComponent(id)}/changes/undo`,
        { undoId },
      );
      const path = field(data, "path");
      if (typeof path !== "string") {
        throw new ApiError("respons server tidak valid", 200);
      }
      return { path };
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
  };
}
