import { Elysia } from "elysia";
import type { SessionManager, WorkspaceResolver } from "../sessions/session-manager";
import { DesignError, assemblePage, buildCsp } from "../design/assemble";
import {
  DesignCommentError,
  addComment,
  deleteComment,
  listComments,
  updateComment,
} from "../design/comments";
import { designStamp, readDesign } from "../design/manifest";
import { DesignWriteError, initDesign, saveLayout } from "../design/write";
import { REVERT_MESSAGES } from "../files/revert";
import { FileError } from "../files/path";
import { resolveRepoRoot } from "../files/repo-root";
import { recordAudit } from "../audit/record";
import type { AuditEntryInput, AuditStore } from "../audit/audit-store";

export interface DesignRoutesOptions {
  manager: SessionManager;
  /** Dipakai untuk mencari repo workspace dari query `repo`. */
  workspaces?: WorkspaceResolver;
  /** Sakelar "Izinkan Google Fonts" (default mati). */
  allowGoogleFonts?: boolean;
  /** false -> PUT layout dan POST init menjawab 403. */
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

/** Pemetaan galat yang sama dengan rute berkas. */
function errorResponse(error: unknown): Response {
  if (error instanceof DesignWriteError) {
    return jsonResponse(error.status, { error: error.message });
  }
  if (error instanceof DesignCommentError) {
    return jsonResponse(error.status, { error: error.message });
  }
  if (error instanceof DesignError) {
    return jsonResponse(error.status, { error: error.message });
  }
  if (error instanceof FileError) {
    return jsonResponse(error.code === "tidak-ditemukan" ? 404 : 400, { error: error.message });
  }
  return jsonResponse(400, { error: "Permintaan tidak valid." });
}

const EDIT_DISABLED = "Penyuntingan berkas dimatikan.";
const MAX_BODY_BYTES = 256 * 1024;

function runningResponse(): Response {
  return jsonResponse(409, { error: REVERT_MESSAGES.RUNNING });
}

/** Body JSON dari teks mentah; gagal parse atau terlalu besar -> 400. */
function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string") {
    throw new DesignWriteError("Body bukan JSON yang valid.", 400);
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new DesignWriteError("Body permintaan terlalu besar.", 400);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new DesignWriteError("Body bukan JSON yang valid.", 400);
  }
}

/** Body init opsional: kosong berarti default; `tracked` harus boolean. */
function parseInitBody(body: unknown): { tracked?: boolean } {
  if (body === undefined || body === null) return {};
  let input: unknown = body;
  if (typeof body === "string") {
    if (body.trim() === "") return {};
    input = parseJsonBody(body);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DesignWriteError("Pilihan tidak valid.", 400);
  }
  const record = input as Record<string, unknown>;
  if (record.tracked === undefined) return {};
  if (typeof record.tracked !== "boolean") {
    throw new DesignWriteError("Pilihan tidak valid.", 400);
  }
  return { tracked: record.tracked };
}

/**
 * Rute model desain. Semua di bawah `/api/` sehingga otomatis dilindungi
 * autentikasi. Hanya `PUT layout` dan `POST init` yang menulis ke disk.
 */
export function designRoutes(options: DesignRoutesOptions): Elysia {
  const manager = options.manager;
  const workspaces = options.workspaces;
  const allowGoogleFonts = options.allowGoogleFonts === true;
  const editEnabled = options.editEnabled ?? true;
  const audit = options.audit;
  const auditEntry = (entry: AuditEntryInput): void => recordAudit(audit, entry);

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
    .get("/api/sessions/:id/design/page", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        const slug = typeof query.slug === "string" ? query.slug : "";
        return await assemblePage(root, slug, { allowGoogleFonts });
      } catch (error) {
        return errorResponse(error);
      }
    })
    .get("/api/sessions/:id/design/frame", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        const slug = typeof query.slug === "string" ? query.slug : "";
        const page = await assemblePage(root, slug, { allowGoogleFonts });
        return new Response(page.html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": buildCsp(allowGoogleFonts),
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
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
    })
    .get("/api/sessions/:id/design/comments", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        return await listComments(root);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/sessions/:id/design/comments",
      async ({ params, query, body }) => {
        const session = manager.get(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        if (!editEnabled) {
          return jsonResponse(403, { error: EDIT_DISABLED });
        }
        try {
          const input = parseJsonBody(body);
          const root = await resolveRepoRoot(session, query.repo, workspaces);
          const comment = await addComment(root, input);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Komentar desain ditambah",
            meta: { aksi: "design-comment", halaman: comment.slug },
          });
          return jsonResponse(201, { comment });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .patch(
      "/api/sessions/:id/design/comments/:commentId",
      async ({ params, query, body }) => {
        const session = manager.get(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        if (!editEnabled) {
          return jsonResponse(403, { error: EDIT_DISABLED });
        }
        try {
          const input = parseJsonBody(body);
          const root = await resolveRepoRoot(session, query.repo, workspaces);
          const comment = await updateComment(root, params.commentId, input);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Komentar desain diubah",
            meta: { aksi: "design-comment", halaman: comment.slug },
          });
          return jsonResponse(200, { comment });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete(
      "/api/sessions/:id/design/comments/:commentId",
      async ({ params, query }) => {
        const session = manager.get(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        if (!editEnabled) {
          return jsonResponse(403, { error: EDIT_DISABLED });
        }
        try {
          const root = await resolveRepoRoot(session, query.repo, workspaces);
          await deleteComment(root, params.commentId);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Komentar desain dihapus",
            meta: { aksi: "design-comment" },
          });
          return jsonResponse(200, { ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      },
    )
    .put(
      "/api/sessions/:id/design/layout",
      async ({ params, query, body }) => {
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
          const input = parseJsonBody(body);
          const root = await resolveRepoRoot(session, query.repo, workspaces);
          const result = await saveLayout(root, input);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Tata letak desain disimpan",
            meta: { aksi: "design-layout", halaman: result.pages },
          });
          return jsonResponse(200, { ok: true, updated: result.pages });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/design/init",
      async ({ params, query, body }) => {
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
          const input = parseInitBody(body);
          const root = await resolveRepoRoot(session, query.repo, workspaces);
          const result = await initDesign(root, input);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Perancah desain dibuat",
            meta: { aksi: "design-init", dibuat: result.created.length },
          });
          return jsonResponse(201, { ok: true, created: result.created });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    );

  return plugin as unknown as Elysia;
}
