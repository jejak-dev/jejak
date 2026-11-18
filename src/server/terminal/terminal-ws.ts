/**
 * Jembatan WebSocket untuk terminal: satu soket per penonton.
 *
 * Protokol (teks = JSON, biner = byte PTY):
 * - server → klien: `ready`, `exit`, `error`; biner = replay lalu keluaran.
 * - klien → server: biner = ketikan; teks `{"t":"resize","cols","rows"}`.
 *
 * Menutup soket tidak menutup terminal: terminal tetap hidup sampai
 * dihapus lewat rute HTTP atau penyapu menganggur.
 */

import type { ServerWebSocket } from "bun";
import { createOutputQueue, type OutputQueue } from "./output-queue";
import { MAX_INPUT_BYTES, type TerminalManager } from "./terminal-manager";

/** Header penanda bahwa respons HTTP harus dinaikkan menjadi WebSocket. */
export const TERMINAL_UPGRADE_HEADER = "x-jejak-ws-upgrade";

export interface TerminalSocketData {
  id: string;
}

interface SocketState {
  unsubscribe: () => void;
  queue: OutputQueue | undefined;
}

const decoder = new TextDecoder();

function sendJson(ws: ServerWebSocket<TerminalSocketData>, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

function sendError(
  ws: ServerWebSocket<TerminalSocketData>,
  code: "tidak-valid" | "tidak-ditemukan",
  message: string,
): void {
  sendJson(ws, { t: "error", code, message });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Handler `websocket` Bun untuk terminal; `getManager` dibaca per soket. */
export function terminalWebsocket(getManager: () => TerminalManager | undefined) {
  const states = new WeakMap<ServerWebSocket<TerminalSocketData>, SocketState>();

  return {
    idleTimeout: 960,
    sendPings: true,

    open(ws: ServerWebSocket<TerminalSocketData>): void {
      const manager = getManager();
      const id = ws.data.id;
      const info = manager?.list().find((terminal) => terminal.id === id);
      if (manager === undefined || info === undefined) {
        sendError(ws, "tidak-ditemukan", "Terminal tidak ditemukan.");
        ws.close();
        return;
      }

      const state: SocketState = { unsubscribe: () => {}, queue: undefined };
      states.set(ws, state);

      let subscription: ReturnType<TerminalManager["subscribe"]>;
      try {
        subscription = manager.subscribe(id, {
          onData: (bytes) => state.queue?.push(bytes),
          onExit: (exitCode) => {
            state.queue?.flush();
            sendJson(ws, { t: "exit", exitCode });
          },
        });
      } catch (error) {
        sendError(ws, "tidak-ditemukan", messageOf(error));
        ws.close();
        return;
      }
      state.unsubscribe = subscription.unsubscribe;

      sendJson(ws, {
        t: "ready",
        cols: info.cols,
        rows: info.rows,
        exited: subscription.exited,
        replayBytes: subscription.replay.length,
      });

      if (subscription.replay.length > 0) {
        if (ws.send(subscription.replay) === 0) {
          ws.close();
          return;
        }
      }

      state.queue = createOutputQueue((frame) => {
        // 0 = antrean penuh (soket lambat); -1 = soket sudah tertutup.
        if (ws.send(frame) === 0) ws.close();
      });

      if (subscription.exited) {
        sendJson(ws, { t: "exit", exitCode: info.exitCode ?? null });
      }
    },

    message(ws: ServerWebSocket<TerminalSocketData>, message: string | Buffer): void {
      const manager = getManager();
      if (manager === undefined) return;
      const id = ws.data.id;

      if (typeof message === "string") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          sendError(ws, "tidak-valid", "Pesan bukan JSON yang valid.");
          return;
        }
        const control = parsed as { t?: unknown; cols?: unknown; rows?: unknown };
        if (control === null || typeof control !== "object" || control.t !== "resize") {
          sendError(ws, "tidak-valid", "Pesan tidak dikenal.");
          return;
        }
        try {
          manager.resize(id, control.cols, control.rows);
        } catch (error) {
          sendError(ws, "tidak-valid", messageOf(error));
        }
        return;
      }

      const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
      if (bytes.length === 0) return;
      if (bytes.length > MAX_INPUT_BYTES) {
        sendError(ws, "tidak-valid", "Input terlalu besar.");
        return;
      }
      try {
        manager.write(id, decoder.decode(bytes));
      } catch (error) {
        sendError(ws, "tidak-valid", messageOf(error));
      }
    },

    close(ws: ServerWebSocket<TerminalSocketData>): void {
      const state = states.get(ws);
      if (state === undefined) return;
      states.delete(ws);
      state.unsubscribe();
      state.queue?.dispose();
    },

    drain(): void {},
  };
}

/**
 * Naikkan respons menjadi WebSocket bila rute menandainya lewat header.
 * Tanpa header, respons diteruskan apa adanya.
 */
export function maybeUpgradeTerminal(
  request: Request,
  response: Response,
  server: { upgrade?(request: Request, options?: unknown): boolean } | undefined,
): Response | undefined {
  const id = response.headers.get(TERMINAL_UPGRADE_HEADER);
  if (id === null) return response;
  if (server?.upgrade?.(request, { data: { id } }) === true) return undefined;
  return new Response(JSON.stringify({ error: "Upgrade WebSocket gagal." }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}
