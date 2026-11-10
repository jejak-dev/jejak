import { Elysia } from "elysia";
import {
  AttachmentError,
  imageTypeOf,
  type AttachmentStore,
} from "../attachments/store";

export interface AttachmentRoutesOptions {
  store: AttachmentStore;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function attachmentRoutes(options: AttachmentRoutesOptions) {
  const { store } = options;
  return new Elysia()
    .post(
      "/api/attachments",
      async ({ body }) => {
        try {
          let parsed: unknown;
          try {
            parsed = typeof body === "string" ? JSON.parse(body) : undefined;
          } catch {
            parsed = undefined;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new AttachmentError("Body permintaan harus berupa objek.", 400);
          }
          const record = parsed as Record<string, unknown>;
          const saved = await store.save(record.name, record.data);
          return jsonResponse(201, {
            attachment: {
              id: saved.id,
              name: saved.name,
              path: saved.path,
              size: saved.size,
              image: saved.image,
            },
          });
        } catch (error) {
          if (error instanceof AttachmentError) {
            return jsonResponse(error.status, { error: error.message });
          }
          return jsonResponse(400, { error: "Permintaan tidak valid." });
        }
      },
      { parse: "text" },
    )
    .get("/api/attachments/:id/:name", ({ params }) => {
      const path = store.resolve(params.id, decodeURIComponent(params.name));
      if (path === undefined) return jsonResponse(404, { error: "Lampiran tidak ditemukan." });
      const type = imageTypeOf(path);
      return new Response(Bun.file(path), {
        headers: {
          "content-type": type ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
          ...(type === undefined ? { "content-disposition": "attachment" } : {}),
        },
      });
    });
}
