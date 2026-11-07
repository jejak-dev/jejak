import { Elysia } from "elysia";
import type { SessionManager } from "../sessions/session-manager";
import { getChanges } from "../files/changes";
import { listDirectory } from "../files/list";
import { FileError } from "../files/path";
import { readTextFile } from "../files/read";

export interface FileRoutesOptions {
  manager: SessionManager;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
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

export function fileRoutes(options: FileRoutesOptions): Elysia {
  const manager = options.manager;

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
    });

  return plugin as unknown as Elysia;
}