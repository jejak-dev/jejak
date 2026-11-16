import { Elysia } from "elysia";
import type { HeldPrompt, HeldPromptService } from "../sessions/held-prompts";
import {
  SessionError,
  type CreateSessionInput,
  type SessionManager,
} from "../sessions/session-manager";
import { parseCreateBody, parseJsonBody } from "./sessions";

export interface HeldRoutesOptions {
  service: HeldPromptService;
  /** Manajer sesi; dipakai memeriksa aturan izin/bypass seperti saat membuat sesi. */
  manager: SessionManager;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof SessionError) {
    const status =
      error.code === "tidak-ditemukan"
        ? 404
        : error.code === "penuh"
          ? 429
          : error.code === "konflik"
            ? 409
            : 400;
    return jsonResponse(status, { error: error.message });
  }
  const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
  return jsonResponse(400, { error: message });
}

function invalid(message: string): SessionError {
  return new SessionError(message, "tidak-valid");
}

/**
 * Bentuk tahanan untuk klien: konfirmasi bypass tak pernah dikirim ke klien
 * (nilainya hanya urusan server).
 */
function toView(held: HeldPrompt): HeldPrompt {
  const input: CreateSessionInput = { ...held.input };
  delete input.confirmBypass;
  return { ...held, input };
}

/** Baca body tahanan: id sesi yang ditunggu + input pembuatan sesi. */
function parseHoldBody(body: unknown): {
  input: CreateSessionInput;
  waitForSessionId: string;
} {
  const parsed = parseJsonBody(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("Body permintaan harus berupa objek.");
  }
  const record = parsed as Record<string, unknown>;
  const waitForSessionId = record.waitForSessionId;
  if (typeof waitForSessionId !== "string" || waitForSessionId.trim() === "") {
    throw invalid("Field waitForSessionId harus berupa teks yang tidak kosong.");
  }
  return { input: parseCreateBody(body), waitForSessionId: waitForSessionId.trim() };
}

export function heldRoutes(options: HeldRoutesOptions): Elysia {
  const service = options.service;

  const plugin = new Elysia({ name: "jejak-held-routes" })
    .get("/api/held-prompts", () => {
      return { held: service.list().map(toView) };
    })
    .post(
      "/api/held-prompts",
      async ({ body }) => {
        try {
          const { input, waitForSessionId } = parseHoldBody(body);
          // Aturan izin dan bypass diperiksa lewat jalur yang sama dengan
          // pembuatan sesi; sesi itself baru dibuat nanti.
          await options.manager.checkCreateInput(input);
          const held = service.hold(input, waitForSessionId);
          return jsonResponse(201, { held: toView(held) });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete("/api/held-prompts/:id", ({ params }) => {
      try {
        const item = service.get(params.id);
        if (item === undefined) {
          return jsonResponse(404, {
            error: `Tertahan "${params.id}" tidak ditemukan.`,
          });
        }
        if (item.status === "menunggu") {
          // Klien memulihkan draf dari `input` tahanan yang dibatalkan.
          const held = service.cancel(params.id);
          return jsonResponse(200, { held: toView(held) });
        }
        service.dismiss(params.id);
        return jsonResponse(200, { ok: true });
      } catch (error) {
        return errorResponse(error);
      }
    });

  return plugin as unknown as Elysia;
}
