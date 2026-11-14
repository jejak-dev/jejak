import { Elysia } from "elysia";
import { MemoryError, type MemoryService } from "../memory/memory-service";
import type { Memory } from "../memory/memory-files";
import type { AuditEntryInput, AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";

export interface MemoryRoutesOptions {
  service?: MemoryService;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

/** Target revisi yang masih ada; `null` bila bukan revisi atau target hilang. */
interface MemoryRevises {
  id: string;
  title: string;
  body: string;
}

/** Item memory yang dikirim ke klien: memuat `replaces` dan `revises`. */
interface MemoryItemOutput extends Memory {
  revises: MemoryRevises | null;
}

/** Menambahkan `revises` pada item memory tanpa mengubah isi memory itu. */
async function decorateItem(
  service: MemoryService,
  item: Memory,
): Promise<MemoryItemOutput> {
  const target = await service.revisionTarget(item);
  return { ...item, revises: target };
}

const DISABLED = "Memory dimatikan.";
const LIST_QUERY_KEYS = new Set(["status", "layer", "project", "q", "limit"]);

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function disabledResponse(): Response {
  return jsonResponse(503, { error: DISABLED });
}

function errorStatus(error: MemoryError): number {
  if (error.code === "tidak-ditemukan") return 404;
  if (error.code === "konflik") return 409;
  return 400;
}

function errorResponse(error: unknown): Response {
  if (error instanceof MemoryError) {
    return jsonResponse(errorStatus(error), { error: error.message });
  }
  const message = error instanceof Error ? error.message : "Permintaan tidak valid.";
  return jsonResponse(400, { error: message });
}

function parseJsonBody(body: unknown): unknown {
  if (typeof body !== "string" || body.trim() === "") {
    throw new MemoryError("Body permintaan harus berupa JSON.", "tidak-valid");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new MemoryError("Body permintaan harus berupa JSON yang valid.", "tidak-valid");
  }
}

function parseObjectBody(body: unknown): Record<string, unknown> {
  const parsed = parseJsonBody(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MemoryError("Body permintaan harus berupa objek.", "tidak-valid");
  }
  return parsed as Record<string, unknown>;
}

export function memoryRoutes(options: MemoryRoutesOptions = {}): Elysia {
  const service = options.service;
  const audit = options.audit;
  const auditAction = (aksi: string, id: unknown): void => {
    const entry: AuditEntryInput = {
      kind: "pengaturan",
      summary: `Memory ${aksi}`,
      meta: typeof id === "string" ? { aksi, id } : { aksi },
    };
    recordAudit(audit, entry);
  };

  const plugin = new Elysia({ name: "jejak-memory-routes" });
  if (service === undefined) {
    return plugin
      .get("/api/memory", () => disabledResponse())
      .post("/api/memory", () => disabledResponse())
      .post("/api/memory/import", () => disabledResponse())
      .patch("/api/memory/:id", () => disabledResponse())
      .post("/api/memory/:id/accept", () => disabledResponse())
      .post("/api/memory/:id/reject", () => disabledResponse())
      .post("/api/memory/:id/archive", () => disabledResponse())
      .delete("/api/memory/:id", () => disabledResponse()) as unknown as Elysia;
  }

  return plugin
    .get("/api/memory", async ({ query }) => {
      try {
        const record = query as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          if (!LIST_QUERY_KEYS.has(key)) {
            throw new MemoryError(`Parameter "${key}" tidak dikenal.`, "tidak-valid");
          }
        }
        const result = await service.list({
          status: query.status,
          layer: query.layer,
          project: query.project,
          q: query.q,
          limit: query.limit,
        });
        return {
          ...result,
          items: await Promise.all(
            result.items.map((item) => decorateItem(service, item)),
          ),
        };
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/memory",
      async ({ body }) => {
        try {
          const input = parseObjectBody(body);
          const item = await service.create({
            layer: input.layer,
            projectKey: input.projectKey,
            title: input.title,
            body: input.body,
          });
          auditAction("ditambah", item.id);
          return jsonResponse(201, { item: await decorateItem(service, item) });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/memory/import",
      async ({ body }) => {
        try {
          const input = parseObjectBody(body);
          const projectKey = input.projectKey;
          if (typeof projectKey !== "string") {
            throw new MemoryError("Folder proyek tidak ditemukan.", "tidak-valid");
          }
          const result = await service.importProjectDocs(projectKey);
          auditAction("impor", undefined);
          return jsonResponse(200, {
            ...result,
            created: await Promise.all(
              result.created.map((item) => decorateItem(service, item)),
            ),
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .patch(
      "/api/memory/:id",
      async ({ params, body }) => {
        try {
          const input = parseObjectBody(body);
          const item = await service.update(params.id, {
            title: input.title,
            body: input.body,
          });
          auditAction("diubah", item.id);
          return { item: await decorateItem(service, item) };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/memory/:id/accept",
      async ({ params }) => {
        try {
          const item = await service.accept(params.id);
          auditAction("diterima", item.id);
          return { item: await decorateItem(service, item) };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/memory/:id/reject",
      async ({ params }) => {
        try {
          const item = await service.reject(params.id);
          auditAction("ditolak", item.id);
          return { item: await decorateItem(service, item) };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/memory/:id/archive",
      async ({ params }) => {
        try {
          const item = await service.archive(params.id);
          auditAction("diarsipkan", item.id);
          return { item: await decorateItem(service, item) };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete("/api/memory/:id", async ({ params }) => {
      try {
        await service.delete(params.id);
        auditAction("dihapus", params.id);
        return { ok: true };
      } catch (error) {
        return errorResponse(error);
      }
    }) as unknown as Elysia;
}
