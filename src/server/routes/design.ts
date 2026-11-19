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
import type { CaptureBroker, CaptureFailure } from "../design/capture-broker";
import { CaptureError, NOT_FOUND } from "../design/capture-broker";
import { DesignDocError, syncDesignDoc } from "../design/design-doc";
import { exportDesignZip, exportStandalonePage } from "../design/export";
import { designStamp, readDesign } from "../design/manifest";
import { DesignTokenError, readTokens, writeTokens, type DesignToken } from "../design/tokens";
import { DesignWriteError, createVariant, initDesign, saveLayout, saveNotes } from "../design/write";
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
  /** Perantara tangkapan layar; tanpa ini unggahan tangkapan menjawab 404. */
  captures?: CaptureBroker;
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
  if (error instanceof DesignTokenError) {
    return jsonResponse(error.status, { error: error.message });
  }
  if (error instanceof DesignDocError) {
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

/** Header unduhan berkas ekspor desain (HTML mandiri atau ZIP). */
function exportHeaders(contentType: string, filename: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${filename}"`,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
}

const EDIT_DISABLED = "Penyuntingan berkas dimatikan.";
const MAX_BODY_BYTES = 256 * 1024;
/** Batas body rute token: daftar token dibatasi 200 entri. */
const MAX_TOKENS_BODY_BYTES = 64 * 1024;
/** Batas body rute catatan: daftar catatan dibatasi 50 entri. */
const MAX_NOTES_BODY_BYTES = 64 * 1024;
/** Batas body unggahan tangkapan: PNG 4 MB menjadi ~5,4 MB base64. */
const MAX_CAPTURE_BODY_CHARS = 6_000_000;
const DATA_URL_PREFIX = "data:image/png;base64,";
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const CAPTURE_FAILURES: readonly CaptureFailure[] = ["tainted", "too-large", "failed", "no-frame"];

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

/**
 * Body `PUT tokens`: `{tokens: [{name, value}], baseMtime?}`. Kunci tak
 * dikenal ditolak; daftar token divalidasi di modul token.
 */
function parseTokensBody(body: unknown): { tokens: DesignToken[]; baseMtime?: number } {
  if (typeof body !== "string") {
    throw new DesignTokenError("Body bukan JSON yang valid.", 400);
  }
  if (Buffer.byteLength(body, "utf8") > MAX_TOKENS_BODY_BYTES) {
    throw new DesignTokenError("Body permintaan terlalu besar.", 413);
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    throw new DesignTokenError("Body bukan JSON yang valid.", 400);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DesignTokenError("Body permintaan harus berupa objek.", 400);
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "tokens" && key !== "baseMtime") {
      throw new DesignTokenError("Field tidak dikenal.", 400);
    }
  }
  if (!Array.isArray(record.tokens)) {
    throw new DesignTokenError("Field tokens harus berupa daftar.", 400);
  }
  let baseMtime: number | undefined;
  if (record.baseMtime !== undefined) {
    if (typeof record.baseMtime !== "number" || !Number.isFinite(record.baseMtime)) {
      throw new DesignTokenError("baseMtime harus berupa bilangan.", 400);
    }
    baseMtime = record.baseMtime;
  }
  return { tokens: record.tokens as DesignToken[], ...(baseMtime === undefined ? {} : { baseMtime }) };
}

/** Body sinkronisasi dokumen: kosong berarti default; tak ada isi lain. */
function parseDocBody(body: unknown): void {
  if (body === undefined || body === null) return;
  let input: unknown = body;
  if (typeof body === "string") {
    if (body.trim() === "") return;
    input = parseJsonBody(body);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DesignDocError("Body permintaan harus berupa objek.", 400);
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

/** Body unggahan tangkapan: `{dataUrl}` atau `{error}`; bentuk salah -> 400. */
function parseCaptureBody(body: unknown): { dataUrl: string } | { error: CaptureFailure } {
  if (typeof body !== "string") {
    throw new DesignWriteError("Body bukan JSON yang valid.", 400);
  }
  if (body.length > MAX_CAPTURE_BODY_CHARS) {
    throw new DesignWriteError("Body permintaan terlalu besar.", 400);
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    throw new DesignWriteError("Body bukan JSON yang valid.", 400);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DesignWriteError("Body permintaan tidak valid.", 400);
  }
  const record = input as Record<string, unknown>;
  if (typeof record.dataUrl === "string") {
    const dataUrl = record.dataUrl;
    if (!dataUrl.startsWith(DATA_URL_PREFIX)) {
      throw new DesignWriteError("Gambar tangkapan tidak valid.", 400);
    }
    const isi = dataUrl.slice(DATA_URL_PREFIX.length);
    if (isi.length === 0 || !BASE64_RE.test(isi)) {
      throw new DesignWriteError("Gambar tangkapan tidak valid.", 400);
    }
    return { dataUrl };
  }
  if (typeof record.error === "string") {
    if (!(CAPTURE_FAILURES as readonly string[]).includes(record.error)) {
      throw new DesignWriteError("Body permintaan tidak valid.", 400);
    }
    return { error: record.error as CaptureFailure };
  }
  throw new DesignWriteError("Body permintaan tidak valid.", 400);
}

/**
 * Body pembuatan varian: `{slug, variant, group?}`. Kunci tak dikenal
 * ditolak; label divalidasi di modul penulis.
 */
function parseVariantBody(body: unknown): { slug: string; variant: string; group?: string } {
  if (typeof body !== "string") {
    throw new DesignWriteError("Body bukan JSON yang valid.", 400);
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new DesignWriteError("Body permintaan terlalu besar.", 400);
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    throw new DesignWriteError("Body bukan JSON yang valid.", 400);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DesignWriteError("Body permintaan harus berupa objek.", 400);
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "slug" && key !== "variant" && key !== "group") {
      throw new DesignWriteError("Field tidak dikenal.", 400);
    }
  }
  if (typeof record.slug !== "string") {
    throw new DesignWriteError("Slug halaman tidak valid.", 400);
  }
  if (typeof record.variant !== "string") {
    throw new DesignWriteError("Label variant tidak valid.", 400);
  }
  if (record.group !== undefined && typeof record.group !== "string") {
    throw new DesignWriteError("Label group tidak valid.", 400);
  }
  return {
    slug: record.slug,
    variant: record.variant,
    ...(record.group === undefined ? {} : { group: record.group }),
  };
}

/**
 * Body `PUT notes`: `{notes: [{id?, x, y, text}]}`. Kunci tak dikenal
 * ditolak; isi catatan divalidasi di modul penulis.
 */
function parseNotesBody(body: unknown): { notes: unknown[] } {
  if (typeof body !== "string") {
    throw new DesignWriteError("Body bukan JSON yang valid.", 400);
  }
  if (Buffer.byteLength(body, "utf8") > MAX_NOTES_BODY_BYTES) {
    throw new DesignWriteError("Body permintaan terlalu besar.", 400);
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    throw new DesignWriteError("Body bukan JSON yang valid.", 400);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DesignWriteError("Body permintaan harus berupa objek.", 400);
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "notes") {
      throw new DesignWriteError("Field tidak dikenal.", 400);
    }
  }
  if (!Array.isArray(record.notes)) {
    throw new DesignWriteError("Field notes harus berupa daftar.", 400);
  }
  return { notes: record.notes };
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
  const captures = options.captures;
  const auditEntry = (entry: AuditEntryInput): void => recordAudit(audit, entry);
  /**
   * Sinkronisasi DESIGN.md otomatis: berjalan diam-diam, galatnya ditelan
   * sehingga aksi utama (simpan token, tata letak, perancah) tak gagal.
   */
  const syncDocDiam = async (root: string): Promise<void> => {
    try {
      await syncDesignDoc(root);
    } catch {
      // Kegagalan sinkronisasi diabaikan.
    }
  };

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
    .get("/api/sessions/:id/design/export", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        const format = typeof query.format === "string" ? query.format : "";
        if (format === "html") {
          const slug = typeof query.slug === "string" ? query.slug : "";
          const result = await exportStandalonePage(root, slug);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Halaman desain diekspor",
            meta: { aksi: "design.export", format: "html", slug },
          });
          return new Response(result.html, {
            headers: exportHeaders("text/html; charset=utf-8", result.filename),
          });
        }
        if (format === "zip") {
          const result = await exportDesignZip(root);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Folder desain diekspor",
            meta: { aksi: "design.export", format: "zip", jumlah: result.files },
          });
          return new Response(result.data, {
            headers: exportHeaders("application/zip", result.filename),
          });
        }
        return jsonResponse(400, { error: "Format ekspor tidak dikenal." });
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
        const stamp = await designStamp(root);
        if (captures === undefined) return { stamp };
        // Polling stamp sekaligus menandai kanvas desain sedang terbuka.
        captures.touch(session.id);
        return { stamp, captures: captures.pending(session.id) };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/sessions/:id/design/capture/:requestId",
      async ({ params, body }) => {
        const session = manager.get(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        // Bukan penulisan berkas: sakelar editEnabled tidak dipakai.
        if (captures === undefined) {
          return jsonResponse(404, { error: "Permintaan tidak ditemukan." });
        }
        try {
          const input = parseCaptureBody(body);
          if ("error" in input) {
            const dikenal = captures.fail(session.id, params.requestId, input.error);
            if (!dikenal) return jsonResponse(404, { error: NOT_FOUND });
            return jsonResponse(200, { ok: true });
          }
          const png = Buffer.from(input.dataUrl.slice(DATA_URL_PREFIX.length), "base64");
          captures.complete(session.id, params.requestId, png);
          return jsonResponse(200, { ok: true });
        } catch (error) {
          if (error instanceof CaptureError) {
            if (error.message === NOT_FOUND) return jsonResponse(404, { error: error.message });
            return jsonResponse(400, { error: error.message });
          }
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
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
    .get("/api/sessions/:id/design/tokens", async ({ params, query }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const root = await resolveRepoRoot(session, query.repo, workspaces);
        return await readTokens(root);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .put(
      "/api/sessions/:id/design/tokens",
      async ({ params, query, body }) => {
        const session = manager.get(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        if (!editEnabled) {
          return jsonResponse(403, { error: EDIT_DISABLED });
        }
        try {
          const input = parseTokensBody(body);
          const root = await resolveRepoRoot(session, query.repo, workspaces);
          const { mtime } = await writeTokens(root, input);
          const read = await readTokens(root);
          await syncDocDiam(root);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Token desain disimpan",
            meta: { aksi: "design-tokens", jumlah: read.tokens.length },
          });
          return jsonResponse(200, { tokens: read.tokens, mtime });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
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
          await syncDocDiam(root);
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
    .put(
      "/api/sessions/:id/design/notes",
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
          const input = parseNotesBody(body);
          const root = await resolveRepoRoot(session, query.repo, workspaces);
          const result = await saveNotes(root, input);
          await syncDocDiam(root);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Catatan desain disimpan",
            meta: { aksi: "design-notes", jumlah: result.notes.length },
          });
          return jsonResponse(200, { notes: result.notes });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/design/variant",
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
          const input = parseVariantBody(body);
          const root = await resolveRepoRoot(session, query.repo, workspaces);
          const page = await createVariant(root, input);
          await syncDocDiam(root);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Varian desain dibuat",
            meta: { aksi: "design-variant", asal: input.slug, baru: page.slug },
          });
          return jsonResponse(200, { page });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/design/doc",
      async ({ params, query, body }) => {
        const session = manager.get(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        if (!editEnabled) {
          return jsonResponse(403, { error: EDIT_DISABLED });
        }
        try {
          parseDocBody(body);
          const root = await resolveRepoRoot(session, query.repo, workspaces);
          const result = await syncDesignDoc(root);
          auditEntry({
            kind: "berkas",
            sessionId: session.id,
            summary: "Dokumen desain diperbarui",
            meta: { aksi: "design-doc" },
          });
          return jsonResponse(200, { changed: result.changed });
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
          // Blok otomatis ditambahkan hanya bila DESIGN.md baru dibuat.
          if (result.created.includes("design/DESIGN.md")) {
            await syncDocDiam(root);
          }
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
