import { Elysia } from "elysia";
import type { SessionManager } from "../sessions/session-manager";
import type { AuditStore } from "../audit/audit-store";
import type { CommandEnvStore } from "../security/command-env-store";
import { CommandEnvError, readCommandEnv } from "../security/command-env-store";
import { recordAudit } from "../audit/record";

export interface CommandEnvRoutesOptions {
  manager: SessionManager;
  /** Tanpa store semua rute menjawab 503. */
  store?: CommandEnvStore;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

const DISABLED = "Env perintah dimatikan.";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof CommandEnvError) {
    return jsonResponse(400, { error: error.message });
  }
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "tidak-ditemukan") {
      return jsonResponse(404, { error: error.message });
    }
  }
  const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
  return jsonResponse(400, { error: message });
}

/** Body mutasi wajib JSON objek; field di luar `allowed` ditolak. */
function parseObjectBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error("Body permintaan harus berupa JSON.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Body permintaan harus berupa JSON yang valid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Body permintaan harus berupa objek.");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`Field "${key}" tidak dikenal.`);
    }
  }
  return record;
}

/** Hanya nama kunci yang pernah dikirim ke klien; nilai tak pernah keluar. */
function keysOf(path: string | undefined): string[] {
  if (path === undefined) return [];
  try {
    return readCommandEnv(path).keys;
  } catch {
    return [];
  }
}

export function commandEnvRoutes(options: CommandEnvRoutesOptions): Elysia {
  const manager = options.manager;
  const store = options.store;
  const audit = options.audit;

  const plugin = new Elysia({ name: "jejak-command-env-routes" });
  if (store === undefined) {
    return plugin
      .get("/api/sessions/:id/command-env", () => jsonResponse(503, { error: DISABLED }))
      .put("/api/sessions/:id/command-env", () => jsonResponse(503, { error: DISABLED }))
      .delete("/api/sessions/:id/command-env", () => jsonResponse(503, { error: DISABLED })) as unknown as Elysia;
  }

  return plugin
    .get("/api/sessions/:id/command-env", ({ params }) => {
      try {
        const root = manager.secretProjectRoot(params.id);
        const path = store.get(root);
        return path === undefined ? { keys: [] } : { path, keys: keysOf(path) };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .put(
      "/api/sessions/:id/command-env",
      ({ params, body }) => {
        try {
          const record = parseObjectBody(body, ["path"]);
          if (typeof record.path !== "string" || record.path.trim() === "") {
            throw new Error('Field "path" harus berupa teks yang tidak kosong.');
          }
          const root = manager.secretProjectRoot(params.id);
          const path = store.set(root, record.path);
          recordAudit(audit, {
            kind: "pengaturan",
            sessionId: params.id,
            summary: "Env perintah diatur",
            meta: { aksi: "env-perintah-diatur", path },
          });
          return { path, keys: keysOf(path) };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete(
      "/api/sessions/:id/command-env",
      ({ params }) => {
        try {
          const root = manager.secretProjectRoot(params.id);
          const removed = store.clear(root);
          if (removed) {
            recordAudit(audit, {
              kind: "pengaturan",
              sessionId: params.id,
              summary: "Env perintah dihapus",
              meta: { aksi: "env-perintah-dihapus" },
            });
          }
          return { removed };
        } catch (error) {
          return errorResponse(error);
        }
      },
    ) as unknown as Elysia;
}
