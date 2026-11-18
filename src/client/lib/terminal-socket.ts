/**
 * Klien soket terminal: murni, tanpa DOM/xterm.
 *
 * Protokol (lihat src/server/terminal/terminal-ws.ts):
 * - server → klien: teks JSON `ready`, `exit`, `error`; biner = replay lalu keluaran.
 * - klien → server: biner = ketikan; teks `{"t":"resize","cols","rows"}`.
 *
 * Setiap sambungan baru mengirim `ready` lebih dulu, jadi `onReset` selalu
 * dipanggil sebelum replay agar layar tidak menampilkan keluaran ganda.
 */

export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface TerminalSocketOptions {
  url: string;
  createSocket?: (url: string) => SocketLike;
  onReset: () => void;
  onOutput: (bytes: Uint8Array) => void;
  onExit: (exitCode: number | null) => void;
  onError: (message: string) => void;
  onStatus?: (status: "menyambung" | "tersambung" | "terputus") => void;
  backoffMs?: number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface TerminalSocket {
  sendInput(text: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

const DEFAULT_BACKOFF_MS = [250, 500, 1000, 2000, 4000];

const encoder = new TextEncoder();

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

export function connectTerminal(options: TerminalSocketOptions): TerminalSocket {
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url) as SocketLike);

  let socket: SocketLike | undefined;
  let timer: unknown;
  let retryIndex = 0;
  let connected = false;
  let stopped = false;
  let exited = false;
  let lastSize: { cols: number; rows: number } | undefined;

  const status = (value: "menyambung" | "tersambung" | "terputus"): void => {
    options.onStatus?.(value);
  };

  const clearPending = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const sendResize = (cols: number, rows: number): void => {
    socket?.send(JSON.stringify({ t: "resize", cols, rows }));
  };

  const handleText = (raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const frame = parsed as { t?: unknown; exitCode?: unknown; code?: unknown; message?: unknown };

    if (frame.t === "ready") {
      retryIndex = 0;
      connected = true;
      options.onReset();
      status("tersambung");
      if (lastSize !== undefined) sendResize(lastSize.cols, lastSize.rows);
      return;
    }

    if (frame.t === "exit") {
      exited = true;
      connected = false;
      clearPending();
      const code = typeof frame.exitCode === "number" ? frame.exitCode : null;
      options.onExit(code);
      return;
    }

    if (frame.t === "error") {
      const message = typeof frame.message === "string" ? frame.message : "Galat terminal.";
      options.onError(message);
      if (frame.code === "tidak-ditemukan") {
        stopped = true;
        connected = false;
        clearPending();
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || exited) return;
    const index = Math.min(retryIndex, backoff.length - 1);
    const delay = backoff.length === 0 ? 0 : (backoff[index] ?? 0);
    retryIndex += 1;
    timer = setTimer(() => {
      timer = undefined;
      open();
    }, delay);
  };

  const open = (): void => {
    if (stopped || exited) return;
    status("menyambung");
    const next = createSocket(options.url);
    next.binaryType = "arraybuffer";
    socket = next;

    next.onopen = () => {};
    next.onmessage = (event) => {
      if (socket !== next) return;
      const data = event.data;
      if (typeof data === "string") {
        handleText(data);
        return;
      }
      const bytes = toBytes(data);
      if (bytes !== undefined) options.onOutput(bytes);
    };
    next.onclose = () => {
      if (socket !== next) return;
      connected = false;
      if (stopped || exited) return;
      status("terputus");
      scheduleReconnect();
    };
    next.onerror = () => {};
  };

  open();

  return {
    sendInput(text: string): void {
      if (!connected || socket === undefined) return;
      socket.send(encoder.encode(text));
    },
    resize(cols: number, rows: number): void {
      lastSize = { cols, rows };
      if (!connected || socket === undefined) return;
      sendResize(cols, rows);
    },
    close(): void {
      stopped = true;
      connected = false;
      clearPending();
      const current = socket;
      socket = undefined;
      current?.close();
    },
  };
}

export function terminalWsUrl(
  id: string,
  location?: { protocol: string; host: string },
): string {
  const loc = location ?? globalThis.location;
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/api/terminal/${encodeURIComponent(id)}/ws`;
}
