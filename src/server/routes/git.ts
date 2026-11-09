import { Elysia } from "elysia";
import type { SessionInfo, SessionManager, WorkspaceResolver } from "../sessions/session-manager";
import type { GitOptions } from "../files/changes";
import { FileError } from "../files/path";
import { resolveRepoRoot } from "../files/repo-root";
import { GitError, gitLog, gitShow, gitStatus } from "../git/git-read";
import { gitCommit, gitStage, gitUnstage } from "../git/git-write";

export interface GitRoutesOptions {
  manager: SessionManager;
  /** Dipakai untuk mencari repo workspace dari query `repo`. */
  workspaces?: WorkspaceResolver;
  git?: GitOptions;
  /** false -> semua rute menjawab 503. */
  enabled?: boolean;
  /** false -> rute stage/unstage/commit menjawab 403. */
  writeEnabled?: boolean;
}

const DISABLED = "Panel git dimatikan.";
const WRITE_DISABLED = "Penulisan git dimatikan.";
const RUNNING = "Sesi sedang berjalan; tunggu selesai sebelum mengubah git.";
const INVALID_LIMIT = "Limit harus bilangan 1 sampai 100.";
const INVALID_HASH = "Hash commit tidak valid.";

const STAGE_KEYS = ["paths", "all", "repo"] as const;
const COMMIT_KEYS = ["message", "repo"] as const;

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
    if (error.code === "konflik") {
      return jsonResponse(409, { error: error.message });
    }
    if (error.code === "gagal") {
      return jsonResponse(500, { error: error.message });
    }
    return jsonResponse(400, { error: error.message });
  }
  if (error instanceof FileError) {
    return jsonResponse(error.code === "tidak-ditemukan" ? 404 : 400, { error: error.message });
  }
  return jsonResponse(400, { error: "Permintaan tidak valid." });
}

/** Body mutasi wajib JSON objek; field di luar `allowed` ditolak. */
function parseObjectBody(
  body: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  let parsed: unknown = body;
  if (typeof body === "string") {
    if (body.trim() === "") {
      throw new GitError("Body permintaan harus berupa JSON.", "tidak-valid");
    }
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new GitError("Body permintaan harus berupa JSON yang valid.", "tidak-valid");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GitError("Body permintaan harus berupa objek.", "tidak-valid");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new GitError(`Field "${key}" tidak dikenal.`, "tidak-valid");
    }
  }
  return record;
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
  const writeEnabled = options.writeEnabled ?? true;

  /**
   * Penjaga bersama rute tulis: 503 (git mati), 403 (tulis mati), 404 (sesi
   * tidak ada), 409 (sesi berjalan). Mengembalikan sesi bila boleh lanjut.
   */
  const writeGuard = (
    id: string,
  ): { session: SessionInfo } | { response: Response } => {
    if (!enabled) {
      return { response: jsonResponse(503, { error: DISABLED }) };
    }
    const session = manager.get(id);
    if (session === undefined) {
      return { response: jsonResponse(404, { error: `Sesi "${id}" tidak ditemukan.` }) };
    }
    if (session.status === "berjalan") {
      return { response: jsonResponse(409, { error: RUNNING }) };
    }
    if (!writeEnabled) {
      return { response: jsonResponse(403, { error: WRITE_DISABLED }) };
    }
    return { session };
  };

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
    })
    .post(
      "/api/sessions/:id/git/stage",
      async ({ params, body }) => {
        const guard = writeGuard(params.id);
        if ("response" in guard) return guard.response;
        try {
          const record = parseObjectBody(body, STAGE_KEYS);
          const root = await resolveRepoRoot(guard.session, record.repo, workspaces);
          const input = { paths: record.paths, all: record.all } as {
            paths?: string[];
            all?: boolean;
          };
          await gitStage(root, input, gitOptions);
          return jsonResponse(200, { ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/git/unstage",
      async ({ params, body }) => {
        const guard = writeGuard(params.id);
        if ("response" in guard) return guard.response;
        try {
          const record = parseObjectBody(body, STAGE_KEYS);
          const root = await resolveRepoRoot(guard.session, record.repo, workspaces);
          const input = { paths: record.paths, all: record.all } as {
            paths?: string[];
            all?: boolean;
          };
          await gitUnstage(root, input, gitOptions);
          return jsonResponse(200, { ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/git/commit",
      async ({ params, body }) => {
        const guard = writeGuard(params.id);
        if ("response" in guard) return guard.response;
        try {
          const record = parseObjectBody(body, COMMIT_KEYS);
          const root = await resolveRepoRoot(guard.session, record.repo, workspaces);
          const result = await gitCommit(root, record.message as string, gitOptions);
          return jsonResponse(200, result);
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    );

  return plugin as unknown as Elysia;
}
