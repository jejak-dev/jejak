import { Elysia } from "elysia";
import { realpath } from "node:fs/promises";
import type { ProviderSelection } from "../provider";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import {
  SessionError,
  type CreateSessionInput,
  type SessionInfo,
  type SessionManager,
  type WorkspaceResolver,
} from "../sessions/session-manager";

export interface SessionRoutesOptions {
  manager: SessionManager;
  /** Dipakai untuk menghitung `workspaceRepos` saat satu sesi dibaca. */
  workspaces?: WorkspaceResolver;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

const KEEP_ALIVE_MS = 15_000;
const encoder = new TextEncoder();

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof SessionError) {
    const status = error.code === "tidak-ditemukan" ? 404 : error.code === "penuh" ? 429 : error.code === "konflik" ? 409 : 400;
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

function parseCreateBody(body: unknown): CreateSessionInput {
  const parsed = parseJsonBody(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("Body permintaan harus berupa objek.");
  }

  const record = parsed as Record<string, unknown>;
  const selection: ProviderSelection = {};
  for (const key of ["profileId", "model", "lightModel"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw invalid(`Field ${key} harus berupa string.`);
    }
    const trimmed = value.trim();
    if (trimmed !== "") selection[key] = trimmed;
  }

  const input: CreateSessionInput = {
    prompt: record.prompt as string,
    cwd: record.cwd as string,
    selection,
  };
  if (typeof record.title === "string") {
    input.title = record.title;
  }
  if (record.permissionMode !== undefined) {
    if (typeof record.permissionMode !== "string") {
      throw invalid("Field permissionMode harus berupa string.");
    }
    input.permissionMode = record.permissionMode;
  }
  if (record.workspaceId !== undefined) {
    // Tipe tetap divalidasi di manager agar galatnya seragam.
    input.workspaceId = record.workspaceId as string;
  }
  if (record.confirmBypass !== undefined) {
    if (typeof record.confirmBypass !== "boolean") {
      throw invalid("Field confirmBypass harus berupa boolean.");
    }
    input.confirmBypass = record.confirmBypass;
  }
  if (record.worktree !== undefined) {
    if (typeof record.worktree !== "boolean") {
      throw invalid("Field worktree harus berupa boolean.");
    }
    input.worktree = record.worktree;
  }
  if (record.sandbox !== undefined) {
    if (record.sandbox !== "standar" && record.sandbox !== "mati") {
      throw invalid('Field sandbox hanya "standar" atau "mati".');
    }
    input.sandbox = record.sandbox;
  }
  return input;
}

function parseMessagesBody(body: unknown): string {
  const parsed = parseJsonBody(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("Body permintaan harus berupa objek.");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== "string") {
    throw invalid("Field text harus berupa string.");
  }
  return record.text;
}

function parseUpdateBody(body: unknown): {
  title?: string;
  archived?: boolean;
  permissionMode?: string;
  confirmBypass?: boolean;
  profileId?: string;
  model?: string;
  sandbox?: "standar" | "mati";
} {
  const parsed = parseJsonBody(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("Body permintaan harus berupa objek.");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (
      key !== "title" &&
      key !== "archived" &&
      key !== "permissionMode" &&
      key !== "confirmBypass" &&
      key !== "profileId" &&
      key !== "model" &&
      key !== "sandbox"
    ) {
      throw invalid(`Field ${key} tidak dikenal.`);
    }
  }
  const update: {
    title?: string;
    archived?: boolean;
    permissionMode?: string;
    confirmBypass?: boolean;
    profileId?: string;
    model?: string;
    sandbox?: "standar" | "mati";
  } = {};
  for (const key of ["profileId", "model"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw invalid(`Field ${key} harus berupa string tidak kosong.`);
    }
    update[key] = value.trim();
  }
  if (record.title !== undefined) {
    if (typeof record.title !== "string") {
      throw invalid("Field title harus berupa string.");
    }
    update.title = record.title;
  }
  if (record.archived !== undefined) {
    if (typeof record.archived !== "boolean") {
      throw invalid("Field archived harus berupa boolean.");
    }
    update.archived = record.archived;
  }
  if (record.permissionMode !== undefined) {
    if (typeof record.permissionMode !== "string") {
      throw invalid("Field permissionMode harus berupa string.");
    }
    update.permissionMode = record.permissionMode;
  }
  if (record.confirmBypass !== undefined) {
    if (typeof record.confirmBypass !== "boolean") {
      throw invalid("Field confirmBypass harus berupa boolean.");
    }
    update.confirmBypass = record.confirmBypass;
  }
  if (record.sandbox !== undefined) {
    if (record.sandbox !== "standar" && record.sandbox !== "mati") {
      throw invalid('Field sandbox hanya "standar" atau "mati".');
    }
    update.sandbox = record.sandbox;
  }
  if (
    update.title === undefined &&
    update.archived === undefined &&
    update.permissionMode === undefined &&
    update.profileId === undefined &&
    update.model === undefined &&
    update.sandbox === undefined
  ) {
    throw invalid(
      "Minimal satu field (title, archived, permissionMode, profileId, model, atau sandbox) harus diisi.",
    );
  }
  return update;
}

function parseSequence(raw: string | null): number {
  if (raw === null) return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function frame(seq: number, event: unknown): Uint8Array {
  return encoder.encode(`id: ${seq}\nevent: agent\ndata: ${JSON.stringify(event)}\n\n`);
}

/** `workspaceRepos` dihitung saat dibaca; workspace atau resolver hilang berarti tanpa field. */
async function withWorkspaceRepos(
  session: SessionInfo,
  resolver: WorkspaceResolver | undefined,
): Promise<SessionInfo> {
  const workspaceId = session.workspaceId;
  if (workspaceId === undefined || resolver === undefined) return session;

  let view;
  try {
    view = await resolver.get(workspaceId);
  } catch {
    return session;
  }
  if (view === undefined) return session;

  let cwdReal: string | undefined;
  try {
    cwdReal = await realpath(session.cwd);
  } catch {
    cwdReal = undefined;
  }

  const repos = await Promise.all(
    view.repos.map(async (repo) => {
      let repoReal: string | undefined;
      if (!repo.missing) {
        try {
          repoReal = await realpath(repo.path);
        } catch {
          repoReal = undefined;
        }
      }
      return {
        name: repo.name,
        primary: cwdReal !== undefined && repoReal === cwdReal,
        missing: repo.missing,
      };
    }),
  );
  return { ...session, workspaceRepos: repos };
}

function endFrame(status: string): Uint8Array {
  return encoder.encode(`event: end\ndata: ${JSON.stringify({ status })}\n\n`);
}

function parseAnswers(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("Field answers harus berupa objek.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw invalid("Terlalu banyak jawaban.");
  const out: Record<string, string> = {};
  for (const [question, answer] of entries) {
    if (typeof answer !== "string" || question.length > 1000 || answer.length > 2000) {
      throw invalid("Jawaban harus berupa teks yang tidak terlalu panjang.");
    }
    out[question] = answer;
  }
  return out;
}

export function sessionRoutes(options: SessionRoutesOptions): Elysia {
  const manager = options.manager;
  const audit = options.audit;

  const plugin = new Elysia({ name: "jejak-session-routes" })
    .post(
      "/api/sessions",
      async ({ body }) => {
        try {
          const input = parseCreateBody(body);
          const session = await manager.create(input);
          if (session.worktree !== undefined) {
            recordAudit(audit, {
              kind: "git",
              sessionId: session.id,
              summary: "Worktree dibuat",
              meta: { aksi: "worktree-buat" },
            });
          }
          return jsonResponse(201, { session });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/sessions", () => {
      return { sessions: manager.list() };
    })
    .get("/api/sessions/:id", async ({ params }) => {
      const session = manager.get(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      return { session: await withWorkspaceRepos(session, options.workspaces) };
    })
    .patch(
      "/api/sessions/:id",
      async ({ params, body }) => {
        try {
          const update = parseUpdateBody(body);
          const current = manager.get(params.id);
          if (current === undefined) {
            return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
          }
          // Dicek sebelum rename agar permintaan gabungan yang ditolak tidak
          // sempat mengubah judul.
          if (update.archived !== undefined && current.status === "berjalan") {
            throw new SessionError("Hentikan sesi dulu.", "konflik");
          }
          let session = current;
          if (update.title !== undefined) {
            session = manager.rename(params.id, update.title);
            recordAudit(audit, {
              kind: "pengaturan",
              sessionId: params.id,
              summary: "Sesi diganti nama",
              meta: { aksi: "ganti-nama" },
            });
          }
          if (update.archived !== undefined) {
            session = manager.setArchived(params.id, update.archived);
            recordAudit(audit, {
              kind: "pengaturan",
              sessionId: params.id,
              summary: "Sesi diarsipkan",
              meta: { aksi: update.archived ? "arsip" : "buka-arsip" },
            });
          }
          if (update.permissionMode !== undefined) {
            session = manager.setPermissionMode(
              params.id,
              update.permissionMode,
              update.confirmBypass,
            );
            recordAudit(audit, {
              kind: "pengaturan",
              sessionId: params.id,
              summary: "Mode izin sesi diganti",
              meta: { aksi: "ganti-mode", mode: update.permissionMode },
            });
          }
          if (update.profileId !== undefined || update.model !== undefined) {
            session = await manager.setProvider(params.id, {
              ...(update.profileId === undefined ? {} : { profileId: update.profileId }),
              ...(update.model === undefined ? {} : { model: update.model }),
            });
            recordAudit(audit, {
              kind: "pengaturan",
              sessionId: params.id,
              summary: "Provider/model sesi diganti",
              meta: { aksi: "ganti-provider", profil: session.profileId, model: session.model ?? "" },
            });
          }
          if (update.sandbox !== undefined) {
            session = manager.setSandbox(params.id, update.sandbox);
            recordAudit(audit, {
              kind: "pengaturan",
              sessionId: params.id,
              summary: update.sandbox === "mati" ? "Sandbox sesi dimatikan" : "Sandbox sesi dinyalakan",
              meta: { aksi: update.sandbox === "mati" ? "sandbox-mati" : "sandbox-standar" },
            });
          }
          return { session };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete(
      "/api/sessions/:id",
      ({ params }) => {
        try {
          manager.delete(params.id);
          recordAudit(audit, {
            kind: "pengaturan",
            sessionId: params.id,
            summary: "Sesi dihapus",
            meta: { aksi: "hapus" },
          });
          return { ok: true };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sessions/:id/messages",
      async ({ params, body }) => {
        try {
          const text = parseMessagesBody(body);
          const result = await manager.send(params.id, text);
          return jsonResponse(200, { ok: true, queued: result.queued });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post("/api/sessions/:id/interrupt", ({ params }) => {
      if (manager.get(params.id) === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      return { ok: true, interrupted: manager.interrupt(params.id) };
    })
    .get("/api/sessions/:id/events", ({ params, query, request }) => {
      const { id } = params;
      if (manager.get(id) === undefined) {
        return jsonResponse(404, { error: `Sesi "${id}" tidak ditemukan.` });
      }

      const headerAfter = request.headers.get("last-event-id");
      const after =
        headerAfter !== null
          ? parseSequence(headerAfter)
          : parseSequence(typeof query.after === "string" ? query.after : null);

      const abort = new AbortController();
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      const stopKeepAlive = (): void => {
        if (keepAlive !== undefined) {
          clearInterval(keepAlive);
          keepAlive = undefined;
        }
      };
      const stop = (): void => {
        abort.abort();
        stopKeepAlive();
      };
      request.signal.addEventListener("abort", stop, { once: true });

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          keepAlive = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              stop();
            }
          }, KEEP_ALIVE_MS);

          void (async () => {
            try {
              for await (const item of manager.events(id, { after, signal: abort.signal })) {
                if (abort.signal.aborted) break;
                controller.enqueue(frame(item.seq, item.event));
              }
              if (!abort.signal.aborted) {
                controller.enqueue(endFrame(manager.get(id)?.status ?? "selesai"));
              }
            } catch {
              // Stream ditutup; tidak ada yang perlu diteruskan ke klien.
            } finally {
              stopKeepAlive();
              request.signal.removeEventListener("abort", stop);
              try {
                controller.close();
              } catch {
                // Stream sudah dibatalkan klien.
              }
            }
          })();
        },
        cancel() {
          stop();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    })
    .post(
      "/api/sessions/:id/permissions/:requestId",
      async ({ params, body }) => {
        try {
          const parsed = parseJsonBody(body);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw invalid("Body permintaan harus berupa objek.");
          }

          const record = parsed as Record<string, unknown>;
          const decision = record.decision as string;

          if (decision !== "allow" && decision !== "deny") {
            throw invalid("Field decision harus berupa 'allow' atau 'deny'.");
          }

          const message = typeof record.message === "string" ? record.message : undefined;

          const answers = parseAnswers(record.answers);

          manager.resolvePermission(
            params.id,
            params.requestId,
            decision as "allow" | "deny",
            message,
            answers,
          );

          return jsonResponse(200, { ok: true });
        } catch (error) {
          if (error instanceof SessionError && error.code === "tidak-ditemukan") {
            return jsonResponse(404, { error: error.message });
          }
          return errorResponse(error);
        }
      },
      { parse: "text" },
    );

  return plugin as unknown as Elysia;
}
