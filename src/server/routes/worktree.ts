import { Elysia } from "elysia";
import type { SessionManager } from "../sessions/session-manager";
import type { WorktreeService } from "../git/worktree-service";

export interface WorktreeRoutesOptions {
  manager: SessionManager;
  /** Tanpa layanan ini semua rute menjawab 503. */
  service?: WorktreeService;
}

const DISABLED = "Worktree dimatikan.";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "tidak-ditemukan") {
      return jsonResponse(404, { error: error.message });
    }
    if (code === "konflik") {
      const numbers = error as { dirtyFiles?: unknown; commitsAhead?: unknown };
      const payload: Record<string, unknown> = { error: error.message };
      if (typeof numbers.dirtyFiles === "number") payload.dirtyFiles = numbers.dirtyFiles;
      if (typeof numbers.commitsAhead === "number") payload.commitsAhead = numbers.commitsAhead;
      return jsonResponse(409, payload);
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

export function worktreeRoutes(options: WorktreeRoutesOptions): Elysia {
  const manager = options.manager;
  const service = options.service;

  const plugin = new Elysia({ name: "jejak-worktree-routes" });
  if (service === undefined) {
    return plugin
      .get("/api/sessions/:id/worktree", () => jsonResponse(503, { error: DISABLED }))
      .delete("/api/sessions/:id/worktree", () => jsonResponse(503, { error: DISABLED }))
      .post("/api/sessions/:id/worktree/restore", () => jsonResponse(503, { error: DISABLED })) as unknown as Elysia;
  }

  return plugin
    .get("/api/sessions/:id/worktree", async ({ params }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      if (session.worktree === undefined) {
        return jsonResponse(404, { error: "Sesi ini tidak punya worktree." });
      }
      const inspect = await service.inspect(session.worktree);
      return { worktree: session.worktree, inspect };
    })
    .delete(
      "/api/sessions/:id/worktree",
      async ({ params, body }) => {
        try {
          const record = parseObjectBody(body, ["force"]);
          if (record.force !== undefined && typeof record.force !== "boolean") {
            throw new Error('Field "force" harus berupa boolean.');
          }
          await manager.removeWorktree(params.id, {
            force: record.force === true,
          });
          return { ok: true };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/worktree/restore",
      async ({ params, body }) => {
        try {
          parseObjectBody(body ?? "{}", []);
          const worktree = await manager.restoreWorktree(params.id);
          return { worktree };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    ) as unknown as Elysia;
}
