import { Elysia } from "elysia";
import { join } from "node:path";
import type { SessionManager, WorkspaceResolver } from "../sessions/session-manager";
import { getChanges, type GitOptions } from "../files/changes";
import { listDirectory } from "../files/list";
import { FileError } from "../files/path";
import { readTextFile } from "../files/read";
import { repoFieldFromBody, repoSnapshotName, resolveRepoRoot } from "../files/repo-root";
import { searchText } from "../files/search";
import { WriteError, saveTextFile } from "../files/write";
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
import { recordAudit } from "../audit/record";
import type { AuditEntryInput, AuditStore } from "../audit/audit-store";

export interface FileRoutesOptions {
  manager: SessionManager;
  /** Dipakai untuk mencari repo workspace dari query/body `repo`. */
  workspaces?: WorkspaceResolver;
  /** Direktori snapshot undo; default `<jejakHome(env)>/undo`. */
  undoDir?: string;
  env?: Record<string, string | undefined>;
  git?: GitOptions;
  now?: () => Date;
  /** false -> PUT /api/sessions/:id/file menjawab 403. */
  editEnabled?: boolean;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
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
  if (error instanceof WriteError) {
    return jsonResponse(error.status, { error: error.message });
  }
  if (error instanceof FileError) {
    return jsonResponse(error.code === "tidak-ditemukan" ? 404 : 400, { error: error.message });
  }
  return jsonResponse(400, { error: "Permintaan tidak valid." });
}

const MAX_QUERY_LENGTH = 200;
const INVALID_QUERY = "Kata kunci tidak valid.";
const EDIT_DISABLED = "Penyuntingan berkas dimatikan.";
const MAX_GLOB_ITEMS = 10;
const INVALID_GLOB = "Pola berkas tidak valid.";

/**
 * Daftar glob dari parameter query: dipisah koma, item kosong dibuang, dan
 * maksimal 10 item per daftar.
 */
function globList(value: unknown): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  const items: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new FileError(INVALID_GLOB, "tidak-valid");
    }
    for (const part of entry.split(",")) {
      if (part.trim() === "") continue;
      items.push(part);
    }
  }
  if (items.length > MAX_GLOB_ITEMS) {
    throw new FileError(INVALID_GLOB, "tidak-valid");
  }
  return items;
}

/** Query `q` harus string tunggal 1..200 tanpa NUL/baris baru. */
function searchQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw new FileError(INVALID_QUERY, "tidak-valid");
  }
  if (
    value.length < 1 ||
    value.length > MAX_QUERY_LENGTH ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) {
    throw new FileError(INVALID_QUERY, "tidak-valid");
  }
  return value;
}

/** Parse body JSON objek untuk penyimpanan berkas. */
function parseSaveBody(body: unknown): Record<string, unknown> {
  let parsed: unknown = body;
  if (typeof body === "string") {
    if (body.trim() === "") {
      throw new WriteError("Body permintaan harus berupa JSON.", 400);
    }
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new WriteError("Body permintaan harus berupa JSON yang valid.", 400);
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WriteError("Body permintaan harus berupa objek.", 400);
  }
  return parsed as Record<string, unknown>;
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
  const workspaces = options.workspaces;
  const editEnabled = options.editEnabled ?? true;
  const undoDir = options.undoDir ?? join(jejakHome(options.env), "undo");
  const revertOptions: RevertOptions = { undoDir };
  if (options.git !== undefined) revertOptions.git = options.git;
  if (options.now !== undefined) revertOptions.now = options.now;
  const audit = options.audit;
  const auditEntry = (entry: AuditEntryInput): void => recordAudit(audit, entry);

  const plugin = new Elysia({ name: "jejak-file-routes" })
    .get("/api/sessions/:id/files", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        return await listDirectory(root, pathParam(query.path));
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
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        return await readTextFile(root, pathParam(query.path));
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/sessions/:id/search", async ({ params, query, request }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        // Elysia mengambil nilai terakhir untuk kunci ganda; array tetap ditolak.
        const rawQuery = new URL(request.url).searchParams;
        const q = rawQuery.getAll("q").length > 1 ? undefined : query.q;
        const text = searchQuery(q);
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        return await searchText(root, text, {
          caseSensitive: query.case === "1",
          regex: query.regex === "1",
          wholeWord: query.word === "1",
          include: globList(query.include),
          exclude: globList(query.exclude),
        });
      } catch (error) {
        if (error instanceof FileError) {
          return jsonResponse(400, { error: error.message });
        }
        return errorResponse(error);
      }
    })
    .put(
      "/api/sessions/:id/file",
      async ({ params, body }) => {
        const session = manager.get(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        if (!editEnabled) {
          return jsonResponse(403, { error: EDIT_DISABLED });
        }
        if (session.status === "berjalan") {
          return runningResponse();
        }
        try {
          const record = parseSaveBody(body);
          const root = await resolveRepoRoot(session, record.repo, workspaces);
          const result = await saveTextFile(root, {
            path: record.path,
            content: record.content,
            baseVersion: record.baseVersion,
          });
          const path = typeof record.path === "string" ? record.path : undefined;
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Berkas disimpan lewat editor",
            meta: {
              ...(path === undefined ? {} : { path }),
              aksi: "simpan",
            },
          });
          return jsonResponse(200, { ok: true, version: result.version, size: result.size });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/sessions/:id/changes", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      let root: string;
      try {
        root = await resolveRepoRoot(session, query.repo, workspaces);
      } catch (error) {
        return errorResponse(error);
      }
      try {
        return await getChanges(root);
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
          const repoParam = repoFieldFromBody(body);
          const root = await resolveRepoRoot(session, repoParam, workspaces);
          const snapshotRepo = await repoSnapshotName(session, repoParam, root);
          const input = parseRejectInput(body);
          const result = await rejectChange(session.id, root, input, revertOptions, snapshotRepo);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Perubahan ditolak",
            meta: { path: result.path, scope: result.scope, aksi: "tolak" },
          });
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
          const repoParam = repoFieldFromBody(body);
          const root = await resolveRepoRoot(session, repoParam, workspaces);
          const snapshotRepo = await repoSnapshotName(session, repoParam, root);
          const undoId = parseUndoInput(body);
          const result = await undoChange(session.id, root, undoId, revertOptions, snapshotRepo);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Penolakan diurungkan",
            meta: { path: result.path, aksi: "urungkan" },
          });
          return jsonResponse(200, { ok: true, path: result.path });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    );

  return plugin as unknown as Elysia;
}
