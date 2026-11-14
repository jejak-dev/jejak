import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import { TerminalError, type TerminalManager } from "../terminal/terminal-manager";

export interface TerminalRoutesOptions {
  /** Tanpa manajer semua rute menjawab 503 (terminal dimatikan secara default). */
  manager?: TerminalManager;
  audit?: AuditStore;
}

const DISABLED = "Terminal dimatikan. Jalankan Jejak dengan JEJAK_TERMINAL=1 untuk menyalakannya.";

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parse(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") {
    throw new TerminalError("Body permintaan harus berupa JSON.", "tidak-valid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TerminalError("Body permintaan harus berupa JSON yang valid.", "tidak-valid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TerminalError("Body permintaan harus berupa objek.", "tidak-valid");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new TerminalError(`Field "${key}" tidak dikenal.`, "tidak-valid");
  }
  return record;
}

function errorResponse(error: unknown): Response {
  if (error instanceof TerminalError) {
    const status = error.code === "tidak-ditemukan" ? 404 : error.code === "batas" ? 429 : 400;
    return json(status, { error: error.message });
  }
  return json(400, { error: "Permintaan tidak valid." });
}

export function terminalRoutes(options: TerminalRoutesOptions = {}): Elysia {
  const manager = options.manager;
  const plugin = new Elysia({ name: "jejak-terminal-routes" });
  if (manager === undefined) {
    const off = () => json(503, { error: DISABLED });
    return plugin
      .get("/api/terminal", off)
      .post("/api/terminal", off)
      .get("/api/terminal/:id/output", off)
      .post("/api/terminal/:id/input", off)
      .post("/api/terminal/:id/resize", off)
      .delete("/api/terminal/:id", off) as unknown as Elysia;
  }
  // Isi ketikan tidak pernah dicatat; hanya pembukaan dan penutupan.
  const note = (aksi: string, meta: Record<string, string | number | boolean | null>): void =>
    recordAudit(options.audit, {
      kind: "pengaturan",
      summary: `Terminal ${aksi}`,
      meta: { aksi: `terminal-${aksi}`, ...meta },
    });

  return (plugin
    .get("/api/terminal", () => ({ terminals: manager.list() }))
    .post(
      "/api/terminal",
      ({ body }) => {
        try {
          const input = parse(body, ["cwd", "cols", "rows"]);
          const info = manager.create({ ...input, cwd: input.cwd });
          note("dibuka", { id: info.id, cwd: info.cwd });
          return json(201, info);
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .get("/api/terminal/:id/output", ({ params, request }) => {
      let handle: ReturnType<typeof manager.subscribe>;
      const encoder = new TextEncoder();
      const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
      try {
        let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller;
          },
          cancel() {
            handle?.unsubscribe();
          },
        });
        const send = (text: string): void => {
          try {
            controllerRef?.enqueue(encoder.encode(text));
          } catch {
            handle?.unsubscribe();
          }
        };
        handle = manager.subscribe(params.id, {
          onData: (bytes) => send(`data: ${b64(bytes)}\n\n`),
          onExit: (code) => send(`event: exit\ndata: ${code ?? ""}\n\n`),
        });
        if (handle.replay.length > 0) send(`data: ${b64(handle.replay)}\n\n`);
        if (handle.exited) send("event: exit\ndata: \n\n");
        request.signal.addEventListener("abort", () => handle.unsubscribe());
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    })
    .post(
      "/api/terminal/:id/input",
      ({ params, body }) => {
        try {
          const input = parse(body, ["data"]);
          manager.write(params.id, input.data);
          return { ok: true };
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/terminal/:id/resize",
      ({ params, body }) => {
        try {
          const input = parse(body, ["cols", "rows"]);
          return manager.resize(params.id, input.cols, input.rows);
        } catch (error) {
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .delete("/api/terminal/:id", ({ params }) => {
      try {
        manager.close(params.id);
        note("ditutup", { id: params.id });
        return { ok: true };
      } catch (error) {
        return errorResponse(error);
      }
    })) as unknown as Elysia;
}
