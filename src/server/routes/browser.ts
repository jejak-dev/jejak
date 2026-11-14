import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import { BrowserError, type BrowserManager } from "../browser/browser-manager";

export interface BrowserRoutesOptions {
  /** Tanpa manajer semua rute menjawab 503 (browser dimatikan secara default). */
  manager?: BrowserManager;
  audit?: AuditStore;
}

const DISABLED = "Browser dimatikan. Jalankan Jejak dengan JEJAK_BROWSER=1 untuk menyalakannya.";
const KEEP_ALIVE_MS = 15_000;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parse(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new BrowserError("Body permintaan harus berupa JSON.", "tidak-valid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BrowserError("Body permintaan harus berupa JSON yang valid.", "tidak-valid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BrowserError("Body permintaan harus berupa objek.", "tidak-valid");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new BrowserError(`Field "${key}" tidak dikenal.`, "tidak-valid");
    }
  }
  return record;
}

function errorResponse(error: unknown): Response {
  if (error instanceof BrowserError) {
    const status =
      error.code === "tidak-ditemukan"
        ? 404
        : error.code === "mati"
          ? 409
          : error.code === "gagal"
            ? 500
            : 400;
    return json(status, { error: error.message });
  }
  return json(400, { error: "Permintaan tidak valid." });
}

export function browserRoutes(options: BrowserRoutesOptions = {}): Elysia {
  const manager = options.manager;
  const plugin = new Elysia({ name: "jejak-browser-routes" });
  if (manager === undefined) {
    const off = () => json(503, { error: DISABLED });
    return plugin
      .get("/api/browser", off)
      .post("/api/browser/navigate", off)
      .get("/api/browser/stream", off)
      .delete("/api/browser", off) as unknown as Elysia;
  }

  // Hanya URL yang dicatat; isi halaman tak pernah masuk audit.
  const note = (aksi: string, meta: Record<string, string | number | boolean | null>): void =>
    recordAudit(options.audit, {
      kind: "pengaturan",
      summary: `Browser ${aksi}`,
      meta: { aksi: `browser-${aksi}`, ...meta },
    });

  const encoder = new TextEncoder();

  return (plugin
    .get("/api/browser", () => manager.state())
    .post(
      "/api/browser/navigate",
      async ({ body }) => {
        try {
          const input = parse(body, ["url"]);
          if (typeof input.url !== "string" || input.url.trim() === "") {
            throw new BrowserError(
              'Field "url" wajib berisi alamat situs.',
              "tidak-valid",
            );
          }
          const state = await manager.navigate(input.url);
          note("dinavigasi", { url: state.url });
          return json(200, state);
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/browser/stream", async ({ request }) => {
      try {
        await manager.ensure();
      } catch (error) {
        return errorResponse(error);
      }
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let unsubscribe: (() => void) | undefined;
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      const stop = (): void => {
        if (keepAlive !== undefined) {
          clearInterval(keepAlive);
          keepAlive = undefined;
        }
        unsubscribe?.();
        unsubscribe = undefined;
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          const send = (text: string): void => {
            try {
              controllerRef?.enqueue(encoder.encode(text));
            } catch {
              stop();
            }
          };
          const sendEvent = (event: string, payload: unknown): void => {
            send(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
          };
          sendEvent("state", manager.state());
          unsubscribe = manager.subscribe((frame) => {
            sendEvent("frame", {
              data: frame.data,
              width: frame.width,
              height: frame.height,
            });
          });
          keepAlive = setInterval(() => {
            send(": ping\n\n");
          }, KEEP_ALIVE_MS);
          (keepAlive as { unref?: () => void }).unref?.();
        },
        cancel() {
          stop();
        },
      });
      request.signal.addEventListener("abort", stop, { once: true });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    })
    .delete("/api/browser", async () => {
      try {
        await manager.close();
        note("ditutup", {});
        return { ok: true };
      } catch (error) {
        return errorResponse(error);
      }
    })) as unknown as Elysia;
}
