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

export interface ApiClient {
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
  getProviders(): Promise<unknown>;
  setActiveProvider(profileId: string): Promise<unknown>;
  testProvider(selection?: { profileId?: string; model?: string }): Promise<unknown>;
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

    async getProviders() {
      return request("GET", "/api/providers");
    },

    async setActiveProvider(profileId) {
      return request("POST", "/api/providers/active", { profileId });
    },

    async testProvider(selection) {
      return request("POST", "/api/providers/test", selection ?? {});
    },
  };
}
