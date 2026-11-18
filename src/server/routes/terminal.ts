import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import { TerminalError, type TerminalManager } from "../terminal/terminal-manager";
import { TERMINAL_UPGRADE_HEADER } from "../terminal/terminal-ws";

export interface TerminalRoutesOptions {
  /**
   * Manajer terminal, atau fungsi yang memcadangnya pada setiap permintaan.
   * Tanpa manajer (atau saat fungsi mengembalikan `undefined`) semua rute
   * menjawab 503 (terminal dimatikan secara default).
   */
  manager?: TerminalManager | (() => TerminalManager | undefined);
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
  const plugin = new Elysia({ name: "jejak-terminal-routes" });
  // Manajer dibaca pada setiap permintaan: status fitur berlaku seketika.
  const resolve = (): TerminalManager | undefined => {
    const source = options.manager;
    if (source === undefined) return undefined;
    return typeof source === "function" ? source() : source;
  };
  const off = () => json(503, { error: DISABLED });
  // Isi ketikan tidak pernah dicatat; hanya pembukaan dan penutupan.
  const note = (aksi: string, meta: Record<string, string | number | boolean | null>): void =>
    recordAudit(options.audit, {
      kind: "pengaturan",
      summary: `Terminal ${aksi}`,
      meta: { aksi: `terminal-${aksi}`, ...meta },
    });

  return (plugin
    .get("/api/terminal", () => {
      const manager = resolve();
      if (manager === undefined) return off();
      return { terminals: manager.list() };
    })
    .post(
      "/api/terminal",
      ({ body }) => {
        const manager = resolve();
        if (manager === undefined) return off();
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
    .get("/api/terminal/:id/ws", ({ params, request }) => {
      const manager = resolve();
      if (manager === undefined) return off();
      const origin = request.headers.get("origin");
      if (origin !== null) {
        let originHost: string | undefined;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = undefined;
        }
        if (originHost === undefined || originHost !== request.headers.get("host")) {
          return json(403, { error: "Origin tidak diizinkan." });
        }
      }
      if (!manager.list().some((terminal) => terminal.id === params.id)) {
        return json(404, { error: "Terminal tidak ditemukan." });
      }
      if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        return json(426, { error: "Butuh upgrade WebSocket." });
      }
      return new Response(null, {
        status: 204,
        headers: { [TERMINAL_UPGRADE_HEADER]: params.id },
      });
    })
    .delete("/api/terminal/:id", ({ params }) => {
      const manager = resolve();
      if (manager === undefined) return off();
      try {
        manager.close(params.id);
        note("ditutup", { id: params.id });
        return { ok: true };
      } catch (error) {
        return errorResponse(error);
      }
    })) as unknown as Elysia;
}
