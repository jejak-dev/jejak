import { Elysia } from "elysia";
import { RunnerError, type RunnerService } from "../runner/runner-service";

export interface RunnerRoutesOptions {
  /** Layanan peluncur perintah; tanpa opsi ini semua rute menjawab 503. */
  runner?: RunnerService;
}

const DISABLED = "Peluncur perintah dimatikan.";

const CUSTOM_BODY_KEYS = ["cwd", "label", "command", "group"] as const;
const RUN_BODY_KEYS = ["cwd", "id", "confirm"] as const;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Pemetaan galat runner ke status HTTP. */
function errorResponse(error: unknown): Response {
  if (error instanceof RunnerError) {
    const status =
      error.code === "tidak-ditemukan"
        ? 404
        : error.code === "konflik"
          ? 409
          : error.code === "batas"
            ? 429
            : error.code === "nonaktif"
              ? 503
              : 400;
    return json(status, { error: error.message });
  }
  const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
  return json(400, { error: message });
}

/** Body JSON dengan daftar field yang boleh (field lain ditolak). */
function parseObjectBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new RunnerError("Body permintaan harus berupa JSON.", "tidak-valid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RunnerError("Body permintaan harus berupa JSON yang valid.", "tidak-valid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RunnerError("Body permintaan harus berupa objek.", "tidak-valid");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new RunnerError(`Field "${key}" tidak dikenal.`, "tidak-valid");
    }
  }
  return record;
}

function queryRecord(query: unknown): Record<string, unknown> {
  return typeof query === "object" && query !== null
    ? (query as Record<string, unknown>)
    : {};
}

/** `cwd` query: wajib untuk memilih folder sesi. */
function queryCwd(query: unknown): string {
  const value = queryRecord(query).cwd;
  if (typeof value !== "string" || value.trim() === "") {
    throw new RunnerError("Parameter cwd wajib diisi.", "tidak-valid");
  }
  return value;
}

/**
 * Rute peluncur perintah. Semuanya di bawah `/api/` sehingga otomatis
 * dilindungi autentikasi.
 */
export function runnerRoutes(options: RunnerRoutesOptions = {}): Elysia {
  const runner = options.runner;
  const plugin = new Elysia({ name: "jejak-runner-routes" });
  if (runner === undefined) {
    const off = () => json(503, { error: DISABLED });
    return plugin
      .get("/api/runner", off)
      .post("/api/runner/custom", off)
      .patch("/api/runner/custom/:id", off)
      .delete("/api/runner/custom/:id", off)
      .post("/api/runner/run", off) as unknown as Elysia;
  }

  return (plugin
    .get("/api/runner", ({ query }) => {
      try {
        const cwd = queryCwd(query);
        return { commands: runner.list(cwd) };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/runner/custom",
      ({ body }) => {
        try {
          const input = parseObjectBody(body, CUSTOM_BODY_KEYS);
          const command = runner.addCustom({
            cwd: input.cwd,
            label: input.label,
            command: input.command,
            group: input.group,
          });
          return json(201, { command });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .patch(
      "/api/runner/custom/:id",
      ({ params, body }) => {
        try {
          const input = parseObjectBody(body, CUSTOM_BODY_KEYS);
          const command = runner.updateCustom({
            cwd: input.cwd,
            id: params.id,
            label: input.label,
            command: input.command,
            group: input.group,
          });
          return json(200, { command });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete("/api/runner/custom/:id", ({ params, query }) => {
      try {
        const cwd = queryCwd(query);
        runner.deleteCustom({ cwd, id: params.id });
        return json(200, { ok: true });
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/runner/run",
      ({ body }) => {
        try {
          const input = parseObjectBody(body, RUN_BODY_KEYS);
          const result = runner.run({
            cwd: input.cwd,
            id: input.id,
            confirm: input.confirm,
          });
          return json(200, result);
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )) as unknown as Elysia;
}
