import { Elysia } from "elysia";
import { join } from "node:path";
import type { SessionManager } from "../sessions/session-manager";
import { getChanges, type GitOptions } from "../files/changes";
import { listDirectory } from "../files/list";
import { FileError } from "../files/path";
import { readTextFile } from "../files/read";
import {
  REVERT_MESSAGES,
  RevertError,
  parseRejectInput,
  parseUndoInput,
  rejectChange,
  undoChange,
  type RevertOptions,
} from "../files/revert";
import { jejakHome } from "../provider-store";

export interface FileRoutesOptions {
  manager: SessionManager;
  /** Direktori snapshot undo; default `<jejakHome(env)>/undo`. */
  undoDir?: string;
  env?: Record<string, string | undefined>;
  git?: GitOptions;
  now?: () => Date;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof RevertError) {
    return jsonResponse(error.status, { error: error.message });
  }
  if (error instanceof FileError) {
    return jsonResponse(error.code === "tidak-ditemukan" ? 404 : 400, { error: error.message });
  }
  return jsonResponse(400, { error: "Permintaan tidak valid." });
}

// Nilai query bisa berupa array (mis. ?path=a&path=b); resolveInside menolak
// yang bukan string, dan path yang tidak dikirim berarti akar cwd.
function pathParam(value: unknown): unknown {
  return value === undefined ? "" : value;
}

function runningResponse(): Response {
  return jsonResponse(409, { error: REVERT_MESSAGES.RUNNING });
}

export function fileRoutes(options: FileRoutesOptions): Elysia {
  const manager = options.manager;
  const undoDir = options.undoDir ?? join(jejakHome(options.env), "undo");
  const revertOptions: RevertOptions = { undoDir };
  if (options.git !== undefined) revertOptions.git = options.git;
  if (options.now !== undefined) revertOptions.now = options.now;

  const plugin = new Elysia({ name: "jejak-file-routes" })
    .get("/api/sessions/:id/files", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        return await listDirectory(session.cwd, pathParam(query.path));
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/sessions/:id/file", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        return await readTextFile(session.cwd, pathParam(query.path));
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/sessions/:id/changes", async ({ params }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        return await getChanges(session.cwd);
      } catch {
        return jsonResponse(400, { error: "Perubahan folder kerja tidak dapat dibaca." });
      }
    })
    .post(
      "/api/sessions/:id/changes/reject",
      async ({ params, body }) => {
        const session = manager.get(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        if (session.status === "berjalan") {
          return runningResponse();
        }
        try {
          const input = parseRejectInput(body);
          const result = await rejectChange(session.id, session.cwd, input, revertOptions);
          return jsonResponse(200, {
            ok: true,
            undoId: result.undoId,
            path: result.path,
            scope: result.scope,
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/changes/undo",
      async ({ params, body }) => {
        const session = manager.get(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        if (session.status === "berjalan") {
          return runningResponse();
        }
        try {
          const undoId = parseUndoInput(body);
          const result = await undoChange(session.id, session.cwd, undoId, revertOptions);
          return jsonResponse(200, { ok: true, path: result.path });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    );

  return plugin as unknown as Elysia;
}
