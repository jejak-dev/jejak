import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { TerminalTab } from "../src/client/components/TerminalTab";
import type { ApiClient } from "../src/client/lib/api";
import type { TerminalSocket, TerminalSocketOptions } from "../src/client/lib/terminal-socket";
import type { TerminalEngine } from "../src/client/lib/xterm-engine";
import { asElement, FakeNode, findAll, fire, installDom } from "./helpers/dom";

let bersihkan: (() => void) | undefined;
let pulihkanLocation: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
  const globals = globalThis as Record<string, unknown>;
  const sebelumnya = globals["location"];
  globals["location"] = { protocol: "http:", host: "localhost:7777" };
  pulihkanLocation = () => {
    globals["location"] = sebelumnya;
  };
  // Komponen memasang ResizeObserver; di DOM tiruan cukup stub kosong.
  globals["ResizeObserver"] = class {
    observe(): void {}
    disconnect(): void {}
  };
});

afterAll(() => {
  bersihkan?.();
  pulihkanLocation?.();
});

/* ---------- Bantuan ---------- */

interface EngineLog {
  writes: Uint8Array[];
  resets: number;
  fits: number;
  focuses: number;
  disposed: number;
  data: Array<(text: string) => void>;
}

function enginePalsu(): { factory: (container: HTMLElement) => Promise<TerminalEngine>; log: EngineLog } {
  const log: EngineLog = { writes: [], resets: 0, fits: 0, focuses: 0, disposed: 0, data: [] };
  const engine: TerminalEngine = {
    cols: 100,
    rows: 28,
    write(bytes) {
      log.writes.push(bytes);
    },
    reset() {
      log.resets += 1;
    },
    fit() {
      log.fits += 1;
    },
    focus() {
      log.focuses += 1;
    },
    onData(cb) {
      log.data.push(cb);
    },
    dispose() {
      log.disposed += 1;
    },
  };
  return { factory: async () => engine, log };
}

interface SocketLog {
  options: TerminalSocketOptions[];
  inputs: string[];
  resizes: Array<[number, number]>;
  closed: number;
}

function connectPalsu(): { connect: (options: TerminalSocketOptions) => TerminalSocket; log: SocketLog } {
  const log: SocketLog = { options: [], inputs: [], resizes: [], closed: 0 };
  return {
    log,
    connect(options) {
      log.options.push(options);
      return {
        sendInput(text) {
          log.inputs.push(text);
        },
        resize(cols, rows) {
          log.resizes.push([cols, rows]);
        },
        close() {
          log.closed += 1;
        },
      };
    },
  };
}

function apiPalsu() {
  const calls: string[] = [];
  const api = {
    createTerminal: async () => {
      calls.push("create");
      return { id: "t1" };
    },
    closeTerminal: async () => {
      calls.push("close");
    },
    getFeatures: async () => ({ terminal: { enabled: true, locked: false } }),
  } as unknown as ApiClient;
  return { api, calls };
}

function tombol(root: FakeNode): FakeNode[] {
  return findAll(root, (node) => node.localName === "button");
}

function teksTombol(root: FakeNode, teks: string): FakeNode | undefined {
  return tombol(root).find((node) => node.textContent.trim() === teks);
}

/** Tunggu sampai kondisi benar; gagal setelah ±2 detik. */
async function tunggu(kondisi: () => boolean): Promise<void> {
  const batas = Date.now() + 2000;
  while (!kondisi()) {
    if (Date.now() > batas) throw new Error("kondisi tidak tercapai");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pasang(props: Record<string, unknown>): { root: FakeNode; lepas: () => void } {
  const root = asElement(new FakeNode("div"));
  render(h(TerminalTab, props as never), root as unknown as HTMLElement);
  return { root, lepas: () => render(null, root as unknown as HTMLElement) };
}

/* ---------- Tes ---------- */

describe("TerminalTab dengan mesin xterm", () => {
  test("buka otomatis: createTerminal memakai ukuran mesin, connect ke URL soket", async () => {
    const { api, calls } = apiPalsu();
    const { factory, log: engineLog } = enginePalsu();
    const { connect, log: socketLog } = connectPalsu();
    const { lepas } = pasang({ api, cwd: "/tmp/proyek", engineFactory: factory, connect });

    await tunggu(() => socketLog.options.length === 1);
    expect(calls.filter((c) => c === "create")).toHaveLength(1);
    expect(socketLog.options[0]?.url).toBe("ws://localhost:7777/api/terminal/t1/ws");
    expect(engineLog.fits).toBeGreaterThan(0);
    lepas();
  });

  test("onOutput menulis ke mesin, onReset mereset layar", async () => {
    const { api } = apiPalsu();
    const { factory, log: engineLog } = enginePalsu();
    const { connect, log: socketLog } = connectPalsu();
    const { lepas } = pasang({ api, cwd: "/tmp/proyek", engineFactory: factory, connect });

    await tunggu(() => socketLog.options.length === 1);
    const options = socketLog.options[0] as TerminalSocketOptions;
    options.onOutput(new Uint8Array([104, 105]));
    options.onReset();
    expect(engineLog.writes).toHaveLength(1);
    expect(engineLog.resets).toBe(1);
    lepas();
  });

  test("onExit menampilkan status Selesai", async () => {
    const { api } = apiPalsu();
    const { factory } = enginePalsu();
    const { connect, log: socketLog } = connectPalsu();
    const { root, lepas } = pasang({ api, cwd: "/tmp/proyek", engineFactory: factory, connect });

    await tunggu(() => socketLog.options.length === 1);
    socketLog.options[0]?.onExit(0);
    await tunggu(() => root.textContent.includes("Selesai"));
    expect(root.textContent).toContain("Selesai");
    lepas();
  });

  test("onStatus terputus menampilkan Menyambung ulang", async () => {
    const { api } = apiPalsu();
    const { factory } = enginePalsu();
    const { connect, log: socketLog } = connectPalsu();
    const { root, lepas } = pasang({ api, cwd: "/tmp/proyek", engineFactory: factory, connect });

    await tunggu(() => socketLog.options.length === 1);
    socketLog.options[0]?.onStatus?.("terputus");
    await tunggu(() => root.textContent.includes("Menyambung ulang"));
    expect(root.textContent).toContain("Menyambung ulang");
    lepas();
  });

  test("klik Ctrl+C mengirim \\x03 lewat soket", async () => {
    const { api } = apiPalsu();
    const { factory } = enginePalsu();
    const { connect, log: socketLog } = connectPalsu();
    const { root, lepas } = pasang({ api, cwd: "/tmp/proyek", engineFactory: factory, connect });

    await tunggu(() => teksTombol(root, "Ctrl+C") !== undefined);
    const tombolCtrlC = teksTombol(root, "Ctrl+C") as FakeNode;
    fire(tombolCtrlC, "click");
    expect(socketLog.inputs).toEqual(["\x03"]);
    lepas();
  });

  test("unmount menutup soket, membuang mesin, dan menutup terminal", async () => {
    const { api, calls } = apiPalsu();
    const { factory, log: engineLog } = enginePalsu();
    const { connect, log: socketLog } = connectPalsu();
    const { lepas } = pasang({ api, cwd: "/tmp/proyek", engineFactory: factory, connect });

    await tunggu(() => socketLog.options.length === 1);
    lepas();
    await tunggu(() => calls.includes("close"));
    expect(socketLog.closed).toBe(1);
    expect(engineLog.disposed).toBe(1);
    expect(calls).toContain("close");
  });

  test("attachId: tidak membuat terminal dan tidak menutupnya saat unmount", async () => {
    const { api, calls } = apiPalsu();
    const { factory } = enginePalsu();
    const { connect, log: socketLog } = connectPalsu();
    const { lepas } = pasang({ api, cwd: "/tmp/proyek", attachId: "t9", engineFactory: factory, connect });

    await tunggu(() => socketLog.options.length === 1);
    expect(socketLog.options[0]?.url).toBe("ws://localhost:7777/api/terminal/t9/ws");
    expect(calls).not.toContain("create");
    lepas();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).not.toContain("close");
  });
});
