import { Elysia } from "elysia";
import type { SessionManager, SessionInfo } from "../sessions/session-manager";
import {
  CheckpointError,
  type CheckpointService,
} from "../checkpoints/checkpoint-service";

export interface CheckpointRoutesOptions {
  manager: SessionManager;
  /** Tanpa layanan ini semua rute checkpoint menjawab 503. */
  service?: CheckpointService;
}

const DISABLED = "Checkpoint dimatikan.";
const RUNNING = "Sesi sedang berjalan. Tunggu selesai atau hentikan dulu.";
const MAX_LABEL = 80;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof CheckpointError) {
    return jsonResponse(error.status, { error: error.message });
  }
  return jsonResponse(400, { error: "Permintaan tidak valid." });
}

function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string" || body.trim() === "") return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new CheckpointError("Body permintaan harus berupa JSON yang valid.", 400);
  }
}

function parseObjectBody(body: unknown): Record<string, unknown> {
  const parsed = parseJsonBody(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CheckpointError("Body permintaan harus berupa objek.", 400);
  }
  return parsed as Record<string, unknown>;
}

function manualLabel(body: unknown): string | undefined {
  const record = parseObjectBody(body);
  const label = record.label;
  if (label === undefined) return undefined;
  if (typeof label !== "string") {
    throw new CheckpointError("Field label harus berupa teks.", 400);
  }
  const value = label.trim();
  if (value === "") return undefined;
  if (value.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CheckpointError("Label checkpoint harus 1..80 karakter tanpa karakter kontrol.", 400);
  }
  return value;
}

function confirmed(body: unknown): boolean {
  const record = parseObjectBody(body);
  return record.confirm === true;
}

export function checkpointRoutes(options: CheckpointRoutesOptions): Elysia {
  const manager = options.manager;
  const service = options.service;

  const plugin = new Elysia({ name: "jejak-checkpoint-routes" });
  if (service === undefined) {
    return plugin
      .get("/api/sessions/:id/checkpoints", () => jsonResponse(503, { error: DISABLED }))
      .post("/api/sessions/:id/checkpoints", () => jsonResponse(503, { error: DISABLED }))
      .get("/api/sessions/:id/checkpoints/:cid/preview", () =>
        jsonResponse(503, { error: DISABLED }),
      )
      .post("/api/sessions/:id/checkpoints/:cid/rewind", () =>
        jsonResponse(503, { error: DISABLED }),
      ) as unknown as Elysia;
  }

  function sessionOf(id: string): SessionInfo | undefined {
    return manager.get(id);
  }

  return plugin
    .get("/api/sessions/:id/checkpoints", async ({ params }) => {
      const session = sessionOf(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        const result = await service.list(session.id, session.cwd);
        return jsonResponse(200, result);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/sessions/:id/checkpoints",
      async ({ params, body }) => {
        const session = sessionOf(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        if (session.status === "berjalan") {
          return jsonResponse(409, { error: RUNNING });
        }
        try {
          const input: { kind: "manual"; label?: string } = { kind: "manual" };
          const label = manualLabel(body);
          if (label !== undefined) input.label = label;
          const result = await service.create(session.id, session.cwd, input);
          if (!result.enabled) {
            return jsonResponse(409, { error: result.reason });
          }
          return jsonResponse(201, { ok: true, item: result.item });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/sessions/:id/checkpoints/:cid/preview", async ({ params }) => {
      const session = sessionOf(params.id);
      if (session === undefined) {
        return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
      }
      try {
        if (!/^[0-9a-fA-F]{40}$/.test(params.cid)) {
          throw new CheckpointError("Titik checkpoint tidak valid.", 400);
        }
        const result = await service.preview(session.id, session.cwd, params.cid);
        return jsonResponse(200, result);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/sessions/:id/checkpoints/:cid/rewind",
      async ({ params, body }) => {
        const session = sessionOf(params.id);
        if (session === undefined) {
          return jsonResponse(404, { error: `Sesi "${params.id}" tidak ditemukan.` });
        }
        if (session.status === "berjalan") {
          return jsonResponse(409, { error: RUNNING });
        }
        try {
          if (!/^[0-9a-fA-F]{40}$/.test(params.cid)) {
            throw new CheckpointError("Titik checkpoint tidak valid.", 400);
          }
          if (!confirmed(body)) {
            throw new CheckpointError("Rewind butuh konfirmasi (confirm: true).", 400);
          }
          const result = await service.rewind(session.id, session.cwd, params.cid);
          return jsonResponse(200, { ok: true, ...result });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    ) as unknown as Elysia;
}
