import { describe, expect, test } from "bun:test";
import {
  connectTerminal,
  terminalWsUrl,
  type SocketLike,
  type TerminalSocketOptions,
} from "../src/client/lib/terminal-socket";

class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  closed = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emitText(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitBinary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }

  emitClose(): void {
    this.onclose?.({});
  }
}

interface FakeTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  pending: Array<{ handle: number; fn: () => void; ms: number }>;
  runNext: () => void;
  count: () => number;
}

function fakeTimers(): FakeTimers {
  let nextHandle = 1;
  const pending: Array<{ handle: number; fn: () => void; ms: number }> = [];
  return {
    pending,
    setTimer(fn, ms) {
      const handle = nextHandle++;
      pending.push({ handle, fn, ms });
      return handle;
    },
    clearTimer(handle) {
      const index = pending.findIndex((entry) => entry.handle === handle);
      if (index !== -1) pending.splice(index, 1);
    },
    runNext() {
      const entry = pending.shift();
      if (entry === undefined) throw new Error("tidak ada timer tertunda");
      entry.fn();
    },
    count() {
      return pending.length;
    },
  };
}

interface Harness {
  sockets: FakeSocket[];
  timers: FakeTimers;
  resets: number;
  output: Uint8Array[];
  exits: Array<number | null>;
  errors: string[];
  statuses: string[];
  options: TerminalSocketOptions;
}

function harness(overrides: Partial<TerminalSocketOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const timers = fakeTimers();
  const state = {
    resets: 0,
    output: [] as Uint8Array[],
    exits: [] as Array<number | null>,
    errors: [] as string[],
    statuses: [] as string[],
  };
  const options: TerminalSocketOptions = {
    url: "ws://127.0.0.1:7777/api/terminal/t1/ws",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onReset: () => {
      state.resets += 1;
    },
    onOutput: (bytes) => {
      state.output.push(bytes);
    },
    onExit: (code) => {
      state.exits.push(code);
    },
    onError: (message) => {
      state.errors.push(message);
    },
    onStatus: (status) => {
      state.statuses.push(status);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  };
  return {
    sockets,
    timers,
    options,
    get resets() {
      return state.resets;
    },
    get output() {
      return state.output;
    },
    get exits() {
      return state.exits;
    },
    get errors() {
      return state.errors;
    },
    get statuses() {
      return state.statuses;
    },
  };
}

const decoder = new TextDecoder();

describe("connectTerminal", () => {
  test("ready memicu onReset sebelum replay lalu keluaran", () => {
    const h = harness();
    connectTerminal(h.options);
    const socket = h.sockets[0]!;
    expect(socket.binaryType).toBe("arraybuffer");

    const order: string[] = [];
    h.options.onReset = () => order.push("reset");
    h.options.onOutput = (bytes) => order.push(`out:${decoder.decode(bytes)}`);

    socket.emitText({ t: "ready", cols: 80, rows: 24, exited: false, replayBytes: 3 });
    socket.emitBinary(new TextEncoder().encode("old"));
    socket.emitBinary(new TextEncoder().encode("new"));

    expect(order).toEqual(["reset", "out:old", "out:new"]);
    expect(h.statuses).toEqual(["menyambung", "tersambung"]);
  });

  test("putus menyambung ulang dengan backoff dan onReset lagi", () => {
    const h = harness();
    connectTerminal(h.options);
    const first = h.sockets[0]!;
    first.emitText({ t: "ready", cols: 80, rows: 24, exited: false, replayBytes: 0 });
    expect(h.resets).toBe(1);

    first.emitClose();
    expect(h.statuses.at(-1)).toBe("terputus");
    expect(h.timers.pending.map((entry) => entry.ms)).toEqual([250]);

    h.timers.runNext();
    expect(h.sockets).toHaveLength(2);
    expect(h.statuses.at(-1)).toBe("menyambung");

    h.sockets[1]!.emitText({ t: "ready", cols: 80, rows: 24, exited: false, replayBytes: 0 });
    expect(h.resets).toBe(2);

    // Backoff kembali ke indeks 0 setelah ready.
    h.sockets[1]!.emitClose();
    expect(h.timers.pending.map((entry) => entry.ms)).toEqual([250]);
  });

  test("backoff naik bila putus berulang tanpa ready", () => {
    const h = harness();
    connectTerminal(h.options);
    h.sockets[0]!.emitClose();
    h.timers.runNext();
    h.sockets[1]!.emitClose();
    expect(h.timers.pending.map((entry) => entry.ms)).toEqual([500]);
  });

  test("exit menghentikan penyambungan ulang dan tidak menutup paksa", () => {
    const h = harness();
    connectTerminal(h.options);
    const socket = h.sockets[0]!;
    socket.emitText({ t: "ready", cols: 80, rows: 24, exited: false, replayBytes: 0 });
    socket.emitText({ t: "exit", exitCode: 3 });

    expect(h.exits).toEqual([3]);
    expect(socket.closed).toBe(false);

    socket.emitClose();
    expect(h.timers.count()).toBe(0);
  });

  test("error tidak-ditemukan menghentikan penyambungan ulang", () => {
    const h = harness();
    connectTerminal(h.options);
    const socket = h.sockets[0]!;
    socket.emitText({ t: "error", code: "tidak-ditemukan", message: "Terminal tidak ditemukan." });
    expect(h.errors).toEqual(["Terminal tidak ditemukan."]);

    socket.emitClose();
    expect(h.timers.count()).toBe(0);
  });

  test("error lain tetap menyambung ulang", () => {
    const h = harness();
    connectTerminal(h.options);
    const socket = h.sockets[0]!;
    socket.emitText({ t: "error", code: "tidak-valid", message: "Pesan tidak dikenal." });
    expect(h.errors).toEqual(["Pesan tidak dikenal."]);

    socket.emitClose();
    expect(h.timers.count()).toBe(1);
  });

  test("sendInput mengirim biner dan dibuang saat belum tersambung", () => {
    const h = harness();
    const client = connectTerminal(h.options);
    const socket = h.sockets[0]!;

    client.sendInput("sebelum");
    expect(socket.sent).toHaveLength(0);

    socket.emitText({ t: "ready", cols: 80, rows: 24, exited: false, replayBytes: 0 });
    client.sendInput("ls\n");

    expect(socket.sent).toHaveLength(1);
    const sent = socket.sent[0]!;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(decoder.decode(sent as Uint8Array)).toBe("ls\n");
  });

  test("resize disimpan dan dikirim setelah ready", () => {
    const h = harness();
    const client = connectTerminal(h.options);
    const socket = h.sockets[0]!;

    client.resize(100, 40);
    expect(socket.sent).toHaveLength(0);

    socket.emitText({ t: "ready", cols: 80, rows: 24, exited: false, replayBytes: 0 });
    expect(socket.sent).toEqual([JSON.stringify({ t: "resize", cols: 100, rows: 40 })]);

    client.resize(120, 50);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: "resize", cols: 120, rows: 50 }));
  });

  test("close membersihkan timer dan tidak menyambung ulang", () => {
    const h = harness();
    const client = connectTerminal(h.options);
    const socket = h.sockets[0]!;
    socket.emitClose();
    expect(h.timers.count()).toBe(1);

    client.close();
    expect(h.timers.count()).toBe(0);
    expect(socket.closed).toBe(true);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("terminalWsUrl", () => {
  test("http menjadi ws dan https menjadi wss", () => {
    expect(terminalWsUrl("t1", { protocol: "http:", host: "127.0.0.1:7777" })).toBe(
      "ws://127.0.0.1:7777/api/terminal/t1/ws",
    );
    expect(terminalWsUrl("t1", { protocol: "https:", host: "jejak.local" })).toBe(
      "wss://jejak.local/api/terminal/t1/ws",
    );
  });

  test("id di-encode", () => {
    expect(terminalWsUrl("a b/c", { protocol: "http:", host: "h:1" })).toBe(
      "ws://h:1/api/terminal/a%20b%2Fc/ws",
    );
  });
});
