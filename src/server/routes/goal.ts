import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { SessionError, type SessionManager } from "../sessions/session-manager";

export interface GoalRoutesOptions {
  manager: SessionManager;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan tambahan. */
  audit?: AuditStore;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Pemetaan galat yang sama dengan rute sesi lain. */
function errorResponse(error: unknown): Response {
  if (error instanceof SessionError) {
    const status =
      error.code === "tidak-ditemukan"
        ? 404
        : error.code === "penuh"
          ? 429
          : error.code === "konflik"
            ? 409
            : 400;
    return jsonResponse(status, { error: error.message });
  }
  const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
  return jsonResponse(400, { error: message });
}

function invalid(message: string): SessionError {
  return new SessionError(message, "tidak-valid");
}

function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string" || body.trim() === "") {
    throw invalid("Body permintaan harus berupa JSON.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw invalid("Body permintaan harus berupa JSON yang valid.");
  }
}

/**
 * Rute mode Goal. Semua di bawah `/api/` sehingga otomatis dilindungi
 * autentikasi.
 */
export function goalRoutes(options: GoalRoutesOptions): Elysia {
  const manager = options.manager;

  const plugin = new Elysia({ name: "jejak-goal-routes" })
    .post(
      "/api/sessions/:id/goal",
      async ({ params, body }) => {
        try {
          const parsed = parseJsonBody(body);
          const session = manager.startGoal(params.id, parsed);
          return jsonResponse(200, { goal: session.goal ?? null });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/goal/pause",
      ({ params }) => {
        try {
          const session = manager.pauseGoal(params.id);
          return jsonResponse(200, { goal: session.goal ?? null });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/goal/resume",
      ({ params }) => {
        try {
          const session = manager.resumeGoal(params.id);
          return jsonResponse(200, { goal: session.goal ?? null });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/goal/stop",
      ({ params }) => {
        try {
          const session = manager.stopGoal(params.id);
          return jsonResponse(200, { goal: session.goal ?? null });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/sessions/:id/goal", ({ params }) => {
      try {
        return { goal: manager.getGoal(params.id) };
      } catch (error) {
        return errorResponse(error);
      }
    });

  return plugin as unknown as Elysia;
}
