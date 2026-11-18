import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager } from "../src/server/terminal/terminal-manager";
import {
  TERMINAL_UPGRADE_HEADER,
  maybeUpgradeTerminal,
  terminalWebsocket,
} from "../src/server/terminal/terminal-ws";

interface Client {
  ws: WebSocket;
  texts: Array<Record<string, unknown>>;
  binaries: Uint8Array[];
  closed: boolean;
}

let dir: string;
let manager: TerminalManager;
let server: ReturnType<typeof Bun.serve>;
let port: number;
const clients: Client[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-terminal-ws-"));
  manager = new TerminalManager({ shell: "/bin/sh", env: { PATH: process.env.PATH, HOME: dir } });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    websocket: terminalWebsocket(() => manager),
    fetch(request, srv) {
      const id = new URL(request.url).pathname.split("/")[3] ?? "";
      return maybeUpgradeTerminal(
        request,
        new Response(null, { status: 204, headers: { [TERMINAL_UPGRADE_HEADER]: id } }),
        srv,
      );
    },
  });
  port = server.port!;
});

afterEach(async () => {
  for (const client of clients) {
    try {
      client.ws.close();
    } catch {
      // Sudah tertutup.
    }
  }
  clients.length = 0;
  manager.closeAll();
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waktu habis menunggu pesan websocket");
    await Bun.sleep(10);
  }
}

function connect(id: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/${id}/ws`);
  ws.binaryType = "arraybuffer";
  const client: Client = { ws, texts: [], binaries: [], closed: false };
  clients.push(client);
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      client.texts.push(JSON.parse(event.data) as Record<string, unknown>);
    } else {
      client.binaries.push(new Uint8Array(event.data as ArrayBuffer));
    }
  });
  ws.addEventListener("close", () => {
    client.closed = true;
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(client));
    ws.addEventListener("error", () => reject(new Error("gagal membuka websocket")));
  });
}

function output(client: Client): string {
  return client.binaries.map((bytes) => new TextDecoder().decode(bytes)).join("");
}

function findText(client: Client, type: string): Record<string, unknown> | undefined {
  return client.texts.find((text) => text.t === type);
}

describe("terminalWebsocket", () => {
  test("ready dengan replay kosong", async () => {
    const info = manager.create({ cwd: dir });
    const client = await connect(info.id);
    await waitFor(() => findText(client, "ready") !== undefined);
    expect(findText(client, "ready")).toMatchObject({
      t: "ready",
      cols: 80,
      rows: 24,
      exited: false,
      replayBytes: 0,
    });
    expect(client.binaries).toHaveLength(0);
  });

  test("input biner ditulis ke terminal dan keluarannya dikirim biner", async () => {
    const info = manager.create({ cwd: dir });
    const client = await connect(info.id);
    await waitFor(() => findText(client, "ready") !== undefined);
    client.ws.send(new TextEncoder().encode("echo halo\n"));
    await waitFor(() => output(client).includes("halo"));
    expect(output(client)).toContain("halo");
  });

  test("sambung ulang menerima replay keluaran sebelumnya", async () => {
    const info = manager.create({ cwd: dir });
    const first = await connect(info.id);
    await waitFor(() => findText(first, "ready") !== undefined);
    first.ws.send(new TextEncoder().encode("echo halo\n"));
    await waitFor(() => output(first).includes("halo"));
    first.ws.close();
    await waitFor(() => first.closed);

    const second = await connect(info.id);
    await waitFor(() => findText(second, "ready") !== undefined);
    expect(findText(second, "ready")).toMatchObject({ replayBytes: expect.any(Number) });
    await waitFor(() => output(second).includes("halo"));
    expect(output(second)).toContain("halo");
  });

  test("resize JSON mengubah ukuran di manager", async () => {
    const info = manager.create({ cwd: dir });
    const client = await connect(info.id);
    await waitFor(() => findText(client, "ready") !== undefined);
    client.ws.send(JSON.stringify({ t: "resize", cols: 100, rows: 30 }));
    await waitFor(() => manager.list()[0]?.cols === 100);
    expect(manager.list()[0]).toMatchObject({ cols: 100, rows: 30 });
  });

  test("id tak dikenal mengirim error lalu menutup soket", async () => {
    const client = await connect("nihil");
    await waitFor(() => findText(client, "error") !== undefined);
    expect(findText(client, "error")).toMatchObject({ t: "error", code: "tidak-ditemukan" });
    await waitFor(() => client.closed);
    expect(client.closed).toBe(true);
  });

  test("exit mengirim frame exit dengan kode", async () => {
    const info = manager.create({ cwd: dir });
    const client = await connect(info.id);
    await waitFor(() => findText(client, "ready") !== undefined);
    client.ws.send(new TextEncoder().encode("exit 3\n"));
    await waitFor(() => findText(client, "exit") !== undefined);
    expect(findText(client, "exit")).toMatchObject({ t: "exit", exitCode: 3 });
  });

  test("input melebihi 64 KiB ditolak dan tidak ditulis", async () => {
    const info = manager.create({ cwd: dir });
    const client = await connect(info.id);
    await waitFor(() => findText(client, "ready") !== undefined);
    client.ws.send(new Uint8Array(64 * 1024 + 1).fill(0x78));
    await waitFor(() => findText(client, "error") !== undefined);
    expect(findText(client, "error")).toMatchObject({ t: "error", code: "tidak-valid" });
    // Terminal tetap hidup dan tak menerima gema masukan raksasa itu.
    client.ws.send(new TextEncoder().encode("echo ok\n"));
    await waitFor(() => output(client).includes("ok"));
    expect(output(client)).not.toContain("x".repeat(1000));
  });
});
