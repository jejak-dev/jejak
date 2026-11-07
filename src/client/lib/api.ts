import type { SessionInfo } from "../../server/sessions/session-manager";

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
  };
}
