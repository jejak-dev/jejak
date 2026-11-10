import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import { MemoryError } from "../memory/memory-service";
import { QuestionError, type QuestionService } from "../questions/question-service";

export interface QuestionRoutesOptions {
  /** Tanpa layanan semua rute menjawab 503. */
  service?: QuestionService;
  audit?: AuditStore;
}

const DISABLED = "Pertanyaan dimatikan.";

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new QuestionError("Body permintaan harus berupa JSON.", "tidak-valid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new QuestionError("Body permintaan harus berupa JSON yang valid.", "tidak-valid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new QuestionError("Body permintaan harus berupa objek.", "tidak-valid");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new QuestionError(`Field "${key}" tidak dikenal.`, "tidak-valid");
    }
  }
  return record;
}

function errorResponse(error: unknown): Response {
  if (error instanceof QuestionError) {
    const status =
      error.code === "tidak-ditemukan" ? 404 : error.code === "konflik" ? 409 : 400;
    return json(status, { error: error.message });
  }
  if (error instanceof MemoryError) {
    const status =
      error.code === "tidak-ditemukan" ? 404 : error.code === "konflik" ? 409 : 400;
    return json(status, { error: error.message });
  }
  return json(400, { error: "Permintaan tidak valid." });
}

export function questionRoutes(options: QuestionRoutesOptions = {}): Elysia {
  const service = options.service;
  const plugin = new Elysia({ name: "jejak-question-routes" });
  if (service === undefined) {
    return plugin
      .get("/api/questions", () => json(503, { error: DISABLED }))
      .post("/api/questions", () => json(503, { error: DISABLED }))
      .patch("/api/questions/:id", () => json(503, { error: DISABLED }))
      .post("/api/questions/:id/answer", () => json(503, { error: DISABLED }))
      .post("/api/questions/:id/dismiss", () => json(503, { error: DISABLED })) as unknown as Elysia;
  }
  const note = (aksi: string, id: string): void =>
    recordAudit(options.audit, {
      kind: "pengaturan",
      summary: `Pertanyaan ${aksi}`,
      meta: { aksi: `pertanyaan-${aksi}`, id },
    });

  return (plugin
    .get("/api/questions", ({ query }) => {
      try {
        const q = query as Record<string, unknown>;
        for (const key of Object.keys(q)) {
          if (!["status", "project", "assignee"].includes(key)) {
            throw new QuestionError(`Parameter "${key}" tidak dikenal.`, "tidak-valid");
          }
        }
        return { items: service.list(q), open: service.openCount() };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/questions",
      ({ body }) => {
        try {
          const input = parseBody(body, ["question", "layer", "projectKey", "assignee"]);
          const item = service.ask({ ...input, question: input.question });
          note("dibuat", item.id);
          return json(201, item);
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .patch(
      "/api/questions/:id",
      ({ params, body }) => {
        try {
          const input = parseBody(body, ["assignee"]);
          const item = service.assign(params.id, input.assignee);
          note("ditugaskan", item.id);
          return item;
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/questions/:id/answer",
      async ({ params, body }) => {
        try {
          const input = parseBody(body, ["answer", "by"]);
          const item = await service.answer(params.id, input.answer, input.by);
          note("dijawab", item.id);
          return item;
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post("/api/questions/:id/dismiss", ({ params }) => {
      try {
        const item = service.dismiss(params.id);
        note("ditutup", item.id);
        return item;
      } catch (error) {
        return errorResponse(error);
      }
    })) as unknown as Elysia;
}
