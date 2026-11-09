import { Elysia } from "elysia";
import { join } from "node:path";
import type { SessionManager } from "../sessions/session-manager";
import type { AuditStore } from "../audit/audit-store";
import type { SecretAllowStore } from "../security/secret-allow-store";
import { SecretAllowError } from "../security/secret-allow-store";
import { checkSecretAccess } from "../security/secret-paths";
import { recordAudit } from "../audit/record";

export interface SecretAllowRoutesOptions {
  manager: SessionManager;
  /** Tanpa store semua rute menjawab 503. */
  store?: SecretAllowStore;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

const DISABLED = "Daftar izin rahasia dimatikan.";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof SecretAllowError) {
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

export function secretAllowRoutes(options: SecretAllowRoutesOptions): Elysia {
  const manager = options.manager;
  const store = options.store;
  const audit = options.audit;

  const plugin = new Elysia({ name: "jejak-secret-allow-routes" });
  if (store === undefined) {
    return plugin
      .get("/api/sessions/:id/secret-allow", () => jsonResponse(503, { error: DISABLED }))
      .post("/api/sessions/:id/secret-allow", () => jsonResponse(503, { error: DISABLED }))
      .delete("/api/sessions/:id/secret-allow", () => jsonResponse(503, { error: DISABLED })) as unknown as Elysia;
  }

  return plugin
    .get("/api/sessions/:id/secret-allow", ({ params }) => {
      try {
        const root = manager.secretProjectRoot(params.id);
        return { root, allowed: store.list(root) };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/sessions/:id/secret-allow",
      ({ params, body }) => {
        try {
          const record = parseObjectBody(body, ["path"]);
          if (typeof record.path !== "string" || record.path.trim() === "") {
            throw new Error('Field "path" harus berupa teks yang tidak kosong.');
          }
          const root = manager.secretProjectRoot(params.id);
          const added = store.add(root, record.path);
          recordAudit(audit, {
            kind: "pengaturan",
            sessionId: params.id,
            summary: "Izin berkas rahasia ditambah",
            meta: { aksi: "izinkan-rahasia", path: added.path, aturan: added.rule },
          });
          return { path: added.path, rule: added.rule, allowed: store.list(root) };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete(
      "/api/sessions/:id/secret-allow",
      ({ params, body }) => {
        try {
          const record = parseObjectBody(body, ["path"]);
          if (typeof record.path !== "string" || record.path.trim() === "") {
            throw new Error('Field "path" harus berupa teks yang tidak kosong.');
          }
          const root = manager.secretProjectRoot(params.id);
          const before = store.list(root);
          const removed = store.remove(root, record.path);
          if (removed) {
            const allowed = store.list(root);
            const removedPath = before.find((item) => !allowed.includes(item)) ?? record.path.trim();
            const verdict = checkSecretAccess({
              toolName: "Read",
              toolInput: { file_path: join(root, removedPath) },
              cwd: root,
            });
            recordAudit(audit, {
              kind: "pengaturan",
              sessionId: params.id,
              summary: "Izin berkas rahasia dihapus",
              meta: {
                aksi: "cabut-izin-rahasia",
                path: removedPath,
                aturan: verdict.rule ?? "",
              },
            });
            return { removed, allowed };
          }
          return { removed, allowed: before };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    ) as unknown as Elysia;
}
