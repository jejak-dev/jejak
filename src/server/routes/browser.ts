import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import { BrowserError, type BrowserManager } from "../browser/browser-manager";

export interface BrowserRoutesOptions {
  /**
   * Manajer browser, atau fungsi yang memcadangnya pada setiap permintaan.
   * Tanpa manajer (atau saat fungsi mengembalikan `undefined`) semua rute
   * menjawab 503 (browser dimatikan secara default).
   */
  manager?: BrowserManager | (() => BrowserManager | undefined);
  audit?: AuditStore;
}

const DISABLED = "Browser dimatikan. Jalankan Jejak dengan JEJAK_BROWSER=1 untuk menyalakannya.";
const KEEP_ALIVE_MS = 15_000;
/** Batas ukuran body permintaan input (256 KB). */
const MAX_BODY_BYTES = 256 * 1024;

const encoder = new TextEncoder();

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parse(
  body: unknown,
  allowed: readonly string[],
  maxBytes?: number,
): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new BrowserError("Body permintaan harus berupa JSON.", "tidak-valid");
  }
  if (maxBytes !== undefined && encoder.encode(body).length > maxBytes) {
    throw new BrowserError("Body permintaan terlalu besar.", "batas");
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
          : error.code === "batas"
            ? 429
            : error.code === "gagal"
              ? 500
              : 400;
    return json(status, { error: error.message });
  }
  return json(400, { error: "Permintaan tidak valid." });
}

export function browserRoutes(options: BrowserRoutesOptions = {}): Elysia {
  const plugin = new Elysia({ name: "jejak-browser-routes" });
  // Manajer dibaca pada setiap permintaan: status fitur berlaku seketika.
  const resolve = (): BrowserManager | undefined => {
    const source = options.manager;
    if (source === undefined) return undefined;
    return typeof source === "function" ? source() : source;
  };
  const off = () => json(503, { error: DISABLED });

  // Hanya URL yang dicatat; isi halaman dan isi input tak pernah masuk audit.
  const note = (aksi: string, meta: Record<string, string | number | boolean | null>): void =>
    recordAudit(options.audit, {
      kind: "pengaturan",
      summary: `Browser ${aksi}`,
      meta: { aksi: `browser-${aksi}`, ...meta },
    });

  return (plugin
    .get("/api/browser", () => {
      const manager = resolve();
      if (manager === undefined) return off();
      return manager.state();
    })
    .post(
      "/api/browser/navigate",
      async ({ body }) => {
        const manager = resolve();
        if (manager === undefined) return off();
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
    .post(
      "/api/browser/tabs",
      async ({ body }) => {
        const manager = resolve();
        if (manager === undefined) return off();
        try {
          const input = parse(body, ["url"]);
          if (input.url !== undefined) {
            if (typeof input.url !== "string" || input.url.trim() === "") {
              throw new BrowserError(
                'Field "url" wajib berisi alamat situs.',
                "tidak-valid",
              );
            }
          }
          const state = await manager.newTab(input.url);
          note("tab-dibuat", { url: state.url });
          return json(200, state);
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post("/api/browser/tabs/:id/activate", async ({ params }) => {
      const manager = resolve();
      if (manager === undefined) return off();
      try {
        const state = await manager.activateTab(params.id);
        note("tab-aktivasi", { url: state.url });
        return json(200, state);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .delete("/api/browser/tabs/:id", async ({ params }) => {
      const manager = resolve();
      if (manager === undefined) return off();
      try {
        const sebelum = manager.tabs().find((tab) => tab.id === params.id);
        const state = await manager.closeTab(params.id);
        note("tab-ditutup", { url: sebelum?.url ?? "" });
        return json(200, state);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post("/api/browser/back", async () => {
      const manager = resolve();
      if (manager === undefined) return off();
      try {
        const state = await manager.back();
        note("mundur", { url: state.url });
        return json(200, state);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post("/api/browser/forward", async () => {
      const manager = resolve();
      if (manager === undefined) return off();
      try {
        const state = await manager.forward();
        note("maju", { url: state.url });
        return json(200, state);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post("/api/browser/reload", async () => {
      const manager = resolve();
      if (manager === undefined) return off();
      try {
        const state = await manager.reload();
        note("dimuat-ulang", { url: state.url });
        return json(200, state);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post("/api/browser/stop", async () => {
      const manager = resolve();
      if (manager === undefined) return off();
      try {
        const state = await manager.stop();
        return json(200, state);
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/browser/viewport",
      async ({ body }) => {
        const manager = resolve();
        if (manager === undefined) return off();
        try {
          const input = parse(body, ["width", "height"]);
          if (input.width === undefined || input.height === undefined) {
            throw new BrowserError(
              'Field "width" dan "height" wajib diisi.',
              "tidak-valid",
            );
          }
          const state = await manager.setViewport(input.width, input.height);
          return json(200, state);
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/browser/input",
      async ({ body, request }) => {
        const manager = resolve();
        if (manager === undefined) return off();
        try {
          const panjang = request.headers.get("content-length");
          if (panjang !== null && Number.parseInt(panjang, 10) > MAX_BODY_BYTES) {
            throw new BrowserError("Body permintaan terlalu besar.", "batas");
          }
          const input = parse(body, ["events"], MAX_BODY_BYTES);
          if (input.events === undefined) {
            throw new BrowserError(
              'Field "events" wajib berisi daftar event input.',
              "tidak-valid",
            );
          }
          const state = await manager.dispatchInput(input.events);
          return json(200, state);
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/browser/copy",
      async () => {
        const manager = resolve();
        if (manager === undefined) return off();
        try {
          const text = await manager.copySelection();
          return json(200, { text });
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/browser/stream", async ({ request }) => {
      const manager = resolve();
      if (manager === undefined) return off();
      try {
        await manager.ensure();
      } catch (error) {
        return errorResponse(error);
      }
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let unsubscribe: (() => void) | undefined;
      let unsubscribeState: (() => void) | undefined;
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      const stop = (): void => {
        if (keepAlive !== undefined) {
          clearInterval(keepAlive);
          keepAlive = undefined;
        }
        unsubscribe?.();
        unsubscribe = undefined;
        unsubscribeState?.();
        unsubscribeState = undefined;
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
          // State dikirim saat sambung dan setiap kali berubah.
          unsubscribeState = manager.subscribeState((state) => {
            sendEvent("state", state);
          });
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
      const manager = resolve();
      if (manager === undefined) return off();
      try {
        await manager.close();
        note("ditutup", {});
        return { ok: true };
      } catch (error) {
        return errorResponse(error);
      }
    })) as unknown as Elysia;
}
