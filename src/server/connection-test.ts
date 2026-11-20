import type { ResolvedProvider } from "./provider";

export interface ConnectionTestOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type ToolCallingStatus = "ok" | "tidak-dipanggil" | "tidak-diuji";

export interface ConnectionTestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  model?: string;
  toolCalling: ToolCallingStatus;
  error?: string;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 20000;
const REDACTED_KEY = "***";

const NO_MODEL_ERROR = "model belum diatur pada profil ini";
const NETWORK_ERROR = "tidak dapat terhubung ke provider (timeout atau jaringan)";
const AUTH_ERROR = "autentikasi ditolak (periksa API key)";
const NOT_FOUND_ERROR = "endpoint tidak ditemukan (periksa base URL dan model)";
const RATE_LIMIT_ERROR = "terkena rate limit";
const UNKNOWN_RESPONSE_ERROR =
  "respons tidak dikenali (apakah base URL menunjuk ke API kompatibel Anthropic?)";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize(value: string, apiKey: string | undefined): string {
  if (apiKey === undefined || apiKey === "") {
    return value;
  }
  return value.split(apiKey).join(REDACTED_KEY);
}

function sanitized(result: ConnectionTestResult, apiKey: string | undefined): ConnectionTestResult {
  const next: ConnectionTestResult = { ...result };
  if (next.error !== undefined) next.error = sanitize(next.error, apiKey);
  if (next.model !== undefined) next.model = sanitize(next.model, apiKey);
  return next;
}

function hasEchoToolUse(content: readonly unknown[]): boolean {
  return content.some((block) => {
    if (!isRecord(block) || block.type !== "tool_use" || block.name !== "echo") {
      return false;
    }
    return isRecord(block.input) && typeof block.input.text === "string";
  });
}

function failure(
  status: number | undefined,
  latencyMs: number,
  model: string | undefined,
  error: string,
  apiKey: string | undefined,
): ConnectionTestResult {
  const result: ConnectionTestResult = {
    ok: false,
    latencyMs,
    toolCalling: "tidak-diuji",
    error,
  };
  if (status !== undefined) result.status = status;
  if (model !== undefined) result.model = model;
  return sanitized(result, apiKey);
}

export async function testConnection(
  resolved: ResolvedProvider,
  options: ConnectionTestOptions = {},
): Promise<ConnectionTestResult> {
  const { apiKey, model } = resolved;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  if (model === undefined || model.trim() === "") {
    return failure(undefined, elapsed(), model, NO_MODEL_ERROR, apiKey);
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${(resolved.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/messages`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (apiKey !== undefined && apiKey !== "") {
    headers["x-api-key"] = apiKey;
  }

  const body = JSON.stringify({
    model,
    max_tokens: 64,
    messages: [{ role: "user", content: 'Panggil tool echo dengan text "ping".' }],
    tools: [
      {
        name: "echo",
        description: "Mengembalikan teks yang diberikan.",
        input_schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
  });

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return failure(undefined, elapsed(), model, NETWORK_ERROR, apiKey);
  }

  const status = response.status;
  if (status >= 200 && status < 300) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!isRecord(payload) || !Array.isArray(payload.content)) {
      return failure(status, elapsed(), model, UNKNOWN_RESPONSE_ERROR, apiKey);
    }

    const result: ConnectionTestResult = {
      ok: true,
      status,
      latencyMs: elapsed(),
      model,
      toolCalling: hasEchoToolUse(payload.content) ? "ok" : "tidak-dipanggil",
    };
    return sanitized(result, apiKey);
  }

  let error: string;
  if (status === 401 || status === 403) {
    error = AUTH_ERROR;
  } else if (status === 404) {
    error = NOT_FOUND_ERROR;
  } else if (status === 429) {
    error = RATE_LIMIT_ERROR;
  } else if (status >= 500) {
    error = `provider mengalami kesalahan (status ${status})`;
  } else {
    error = `permintaan ditolak (status ${status})`;
  }

  return failure(status, elapsed(), model, error, apiKey);
}

export interface ModelListResult {
  ok: boolean;
  models: string[];
  /** Jendela konteks per model bila provider melaporkannya di /models. */
  contextWindows?: Record<string, number>;
  error?: string;
}

/** Nama field jendela konteks yang dipakai berbagai provider (OpenRouter, vLLM, LiteLLM, dll). */
const WINDOW_FIELDS = ["context_length", "context_window", "max_context_length", "max_model_len", "max_input_tokens"];

function windowOfRow(row: Record<string, unknown>): number | undefined {
  for (const key of WINDOW_FIELDS) {
    const value = row[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 100_000_000) {
      return value;
    }
  }
  return undefined;
}

const MAX_MODELS = 500;

/** Memuat daftar model dari `GET <baseUrl>/v1/models` (format Anthropic dan kompatibel OpenAI). */
export async function listModels(
  resolved: ResolvedProvider,
  options: ConnectionTestOptions = {},
): Promise<ModelListResult> {
  const { apiKey } = resolved;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = `${(resolved.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/v1/models?limit=${MAX_MODELS}`;
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (apiKey !== undefined && apiKey !== "") {
    headers["x-api-key"] = apiKey;
    headers.authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, models: [], error: NETWORK_ERROR };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, models: [], error: AUTH_ERROR };
  }
  if (response.status === 404) {
    return { ok: false, models: [], error: "provider tidak menyediakan daftar model (isi manual)" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, models: [], error: `permintaan ditolak (status ${response.status})` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const rows = isRecord(payload) && Array.isArray(payload.data) ? payload.data : undefined;
  if (rows === undefined) {
    return { ok: false, models: [], error: UNKNOWN_RESPONSE_ERROR };
  }
  const models: string[] = [];
  const contextWindows: Record<string, number> = {};
  for (const row of rows) {
    const id = isRecord(row) ? row.id : undefined;
    if (typeof id !== "string") continue;
    const clean = sanitize(id.trim(), apiKey);
    if (clean !== "" && clean.length <= 200 && !models.includes(clean)) {
      models.push(clean);
      const window = windowOfRow(row as Record<string, unknown>);
      if (window !== undefined) contextWindows[clean] = window;
    }
    if (models.length >= MAX_MODELS) break;
  }
  return Object.keys(contextWindows).length > 0
    ? { ok: true, models, contextWindows }
    : { ok: true, models };
}
