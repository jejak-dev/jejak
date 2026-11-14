import { BrowserError } from "./browser-error";

/**
 * Transport minimal untuk CDP: kirim dan terima string.
 * Diimplementasikan di atas `WebSocket` bawaan Bun, atau transport palsu
 * pada tes sehingga tidak perlu Chrome sungguhan.
 */
export interface CdpTransport {
  /** Kirim satu pesan (JSON) ke browser. */
  send(data: string): void;
  /** Tutup soket. */
  close(): void;
  /** Daftarkan penerima pesan masuk. */
  setMessageHandler(handler: (data: string) => void): void;
  /** Daftarkan pemicu saat soket ditutup. */
  setCloseHandler(handler: () => void): void;
}

/** Pendengar peristiwa CDP. */
export type CdpEventHandler = (params: unknown, sessionId: string | undefined) => void;

/** Koneksi CDP yang dipakai BrowserManager (implementasi nyata atau palsu). */
export interface CdpConnection {
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
  on(event: string, handler: CdpEventHandler, sessionId?: string): () => void;
  close(): void;
}

export interface CdpClientOptions {
  /** Batas waktu menunggu balasan (ms); bawaan 10 detik. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Pesan CDP masuk (sudah diurai JSON). */
interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
  sessionId?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler = CdpEventHandler;

/**
 * Klien CDP minimal di atas `WebSocket`.
 *
 * - `send` mengembalikan janji yang menolak bila CDP mengirim galat, waktu
 *   habis, atau soket tertutup;
 * - `on` mendaftarkan pendengar peristiwa (bisa dibatasi satu sesi);
 * - pesan JSON tak valid diabaikan.
 */
export class CdpClient implements CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private closed = false;

  constructor(
    private readonly transport: CdpTransport,
    private readonly options: CdpClientOptions = {},
  ) {
    this.transport.setMessageHandler((data) => this.receive(data));
    this.transport.setCloseHandler(() => this.handleClosed());
  }

  /** Hubungkan ke URL WebSocket CDP (wajib `ws://127.0.0.1:...`). */
  static async connect(
    wsUrl: string,
    options: CdpClientOptions = {},
  ): Promise<CdpClient> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.removeEventListener("error", onError);
        resolve();
      };
      const onError = (): void => {
        socket.removeEventListener("open", onOpen);
        reject(new BrowserError("Gagal terhubung ke browser.", "gagal"));
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
    });
    const transport: CdpTransport = {
      send: (data) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data);
      },
      close: () => {
        try {
          socket.close();
        } catch {
          // Soket sudah tertutup.
        }
      },
      setMessageHandler: (handler) => {
        socket.addEventListener("message", (event) => {
          const data = typeof event.data === "string" ? event.data : "";
          if (data !== "") handler(data);
        });
      },
      setCloseHandler: (handler) => {
        socket.addEventListener("close", () => handler(), { once: true });
      },
    };
    return new CdpClient(transport, options);
  }

  /** Kirim perintah CDP dan tunggu balasannya. */
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new BrowserError("Koneksi browser sudah tertutup.", "mati"));
    }
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserError(`Perintah "${method}" melebihi batas waktu.`, "gagal"));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const payload: Record<string, unknown> = { id, method };
      if (params !== undefined) payload.params = params;
      if (sessionId !== undefined) payload.sessionId = sessionId;
      try {
        this.transport.send(JSON.stringify(payload));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new BrowserError(`Gagal mengirim perintah "${method}".`, "gagal"));
      }
    });
  }

  /** Dengarkan peristiwa CDP; kembalikan fungsi unsubscribe. */
  on(
    event: string,
    handler: EventHandler,
    sessionId?: string,
  ): () => void {
    const key = sessionId === undefined ? event : `${event}@${sessionId}`;
    const set = this.handlers.get(key) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(key, set);
    return () => {
      set.delete(handler);
    };
  }

  /** Tutup soket dan tolak semua janji tertunda. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.transport.close();
    } catch {
      // Transport sudah tertutup.
    }
    this.rejectAll(new BrowserError("Koneksi browser sudah tertutup.", "mati"));
  }

  private receive(data: string): void {
    let message: CdpMessage;
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed !== "object" || parsed === null) return;
      message = parsed as CdpMessage;
    } catch {
      // Pesan tak valid diabaikan.
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const detail =
          typeof message.error.message === "string" && message.error.message !== ""
            ? message.error.message
            : "Kesalahan tidak diketahui.";
        pending.reject(new BrowserError(`Browser menolak perintah: ${detail}`, "gagal"));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    const params = message.params ?? {};
    const generic = this.handlers.get(message.method);
    for (const handler of generic ?? []) handler(params, message.sessionId);
    if (message.sessionId !== undefined) {
      const scoped = this.handlers.get(`${message.method}@${message.sessionId}`);
      for (const handler of scoped ?? []) handler(params, message.sessionId);
    }
  }

  private handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new BrowserError("Koneksi browser terputus.", "mati"));
  }

  private rejectAll(error: BrowserError): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
