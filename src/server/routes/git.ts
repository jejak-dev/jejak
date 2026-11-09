import { Elysia } from "elysia";
import type { SessionManager, WorkspaceResolver } from "../sessions/session-manager";
import type { GitOptions } from "../files/changes";
import { FileError } from "../files/path";
import { resolveRepoRoot } from "../files/repo-root";
import { GitError, gitLog, gitShow, gitStatus } from "../git/git-read";

export interface GitRoutesOptions {
  manager: SessionManager;
  /** Dipakai untuk mencari repo workspace dari query `repo`. */
  workspaces?: WorkspaceResolver;
  git?: GitOptions;
  /** false -> semua rute menjawab 503. */
  enabled?: boolean;
}

const DISABLED = "Panel git dimatikan.";
const INVALID_LIMIT = "Limit harus bilangan 1 sampai 100.";
const INVALID_HASH = "Hash commit tidak valid.";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof GitError) {
    if (error.code === "tidak-ditemukan") {
      return jsonResponse(404, { error: error.message });
    }
    return jsonResponse(400, { error: error.message });
  }
  if (error instanceof FileError) {
    return jsonResponse(error.code === "tidak-ditemukan" ? 404 : 400, { error: error.message });
  }
  return jsonResponse(400, { error: "Permintaan tidak valid." });
}

/** Query `limit` harus bilangan bulat 1..100; tanpa nilai memakai default. */
function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new GitError(INVALID_LIMIT, "tidak-valid");
  }
  const limit = Number(value);
  if (limit < 1 || limit > 100) {
    throw new GitError(INVALID_LIMIT, "tidak-valid");
  }
  return limit;
}

function parseHash(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new GitError(INVALID_HASH, "tidak-valid");
  }
  return value;
}

export function gitRoutes(options: GitRoutesOptions): Elysia {
  const manager = options.manager;
  const workspaces = options.workspaces;
  const gitOptions = options.git ?? {};
  const enabled = options.enabled ?? true;

  const plugin = new Elysia({ name: "jejak-git-routes" })
    .get("/api/sessions/:id/git/status", async ({ params, query }) => {
      if (!enabled) {
        return jsonResponse(503, { error: DISABLED });
      }
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        return await gitStatus(root, gitOptions);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/sessions/:id/git/log", async ({ params, query }) => {
      if (!enabled) {
        return jsonResponse(503, { error: DISABLED });
      }
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const limit = parseLimit(query.limit);
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        const logOptions = limit === undefined ? {} : { limit };
        return await gitLog(root, logOptions, gitOptions);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/sessions/:id/git/show", async ({ params, query }) => {
      if (!enabled) {
        return jsonResponse(503, { error: DISABLED });
      }
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const hash = parseHash(query.hash);
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        return await gitShow(root, hash, gitOptions);
      } catch (error) {
        return errorResponse(error);
      }
    });

  return plugin as unknown as Elysia;
}
