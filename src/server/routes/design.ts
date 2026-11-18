import { Elysia } from "elysia";
import type { SessionManager, WorkspaceResolver } from "../sessions/session-manager";
import { designStamp, readDesign } from "../design/manifest";
import { FileError } from "../files/path";
import { resolveRepoRoot } from "../files/repo-root";

export interface DesignRoutesOptions {
  manager: SessionManager;
  /** Dipakai untuk mencari repo workspace dari query `repo`. */
  workspaces?: WorkspaceResolver;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Pemetaan galat yang sama dengan rute berkas. */
function errorResponse(error: unknown): Response {
  if (error instanceof FileError) {
    return jsonResponse(error.code === "tidak-ditemukan" ? 404 : 400, { error: error.message });
  }
  return jsonResponse(400, { error: "Permintaan tidak valid." });
}

/**
 * Rute baca model desain. Semua di bawah `/api/` sehingga otomatis
 * dilindungi autentikasi; tidak ada rute yang menulis ke disk.
 */
export function designRoutes(options: DesignRoutesOptions): Elysia {
  const manager = options.manager;
  const workspaces = options.workspaces;

  const plugin = new Elysia({ name: "jejak-design-routes" })
    .get("/api/sessions/:id/design", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        return await readDesign(root);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/sessions/:id/design/stamp", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        return { stamp: await designStamp(root) };
      } catch (error) {
        return errorResponse(error);
      }
    });

  return plugin as unknown as Elysia;
}
