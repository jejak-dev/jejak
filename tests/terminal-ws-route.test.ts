import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { TerminalManager } from "../src/server/terminal/terminal-manager";
import {
  TERMINAL_UPGRADE_HEADER,
  maybeUpgradeTerminal,
  terminalWebsocket,
} from "../src/server/terminal/terminal-ws";

const PASSWORD = "sandi-uji-123";
const HOST = { host: "127.0.0.1:3000" };

let dir: string;
let manager: TerminalManager | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-terminal-ws-route-"));
});

afterEach(async () => {
  manager?.closeAll();
  manager = undefined;
  server?.stop(true);
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

function newManager(): TerminalManager {
  manager = new TerminalManager({ shell: "/bin/sh", env: { PATH: process.env.PATH, HOME: dir } });
  return manager;
}

type App = ReturnType<typeof createApp>;

function makeApp(options: { enabled?: boolean; auth?: boolean } = {}): App {
  const term = options.enabled === false ? undefined : newManager();
  return createApp({
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
    ...(term === undefined ? {} : { terminal: term }),
    ...(options.auth === true ? { auth: { password: PASSWORD, port: 3000 } } : {}),
  });
}

function get(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(
    new Request(`http://127.0.0.1:3000${path}`, { headers: { ...HOST, ...headers } }),
  );
}

async function loginCookie(app: App): Promise<string> {
  const res = await app.handle(
    new Request("http://127.0.0.1:3000/api/auth/login", {
      method: "POST",
      headers: { ...HOST, "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waktu habis menunggu");
    await Bun.sleep(10);
  }
}

describe("GET /api/terminal/:id/ws", () => {
  test("terminal ada + upgrade websocket → 204 dengan header penanda id", async () => {
    const app = makeApp();
    const info = manager!.create({ cwd: dir });
    const res = await get(app, `/api/terminal/${info.id}/ws`, { upgrade: "websocket" });
    expect(res.status).toBe(204);
    expect(res.headers.get(TERMINAL_UPGRADE_HEADER)).toBe(info.id);
  });

  test("tanpa header upgrade → 426 tanpa header penanda", async () => {
    const app = makeApp();
    const info = manager!.create({ cwd: dir });
    const res = await get(app, `/api/terminal/${info.id}/ws`);
    expect(res.status).toBe(426);
    expect(res.headers.get(TERMINAL_UPGRADE_HEADER)).toBeNull();
  });

  test("id tak ada → 404", async () => {
    const app = makeApp();
    const res = await get(app, "/api/terminal/nihil/ws", { upgrade: "websocket" });
    expect(res.status).toBe(404);
  });

  test("fitur mati → 503", async () => {
    const app = makeApp({ enabled: false });
    const res = await get(app, "/api/terminal/nihil/ws", { upgrade: "websocket" });
    expect(res.status).toBe(503);
  });

  test("origin asing ditolak, origin cocok dan tanpa origin lolos", async () => {
    const app = makeApp();
    const info = manager!.create({ cwd: dir });
    const path = `/api/terminal/${info.id}/ws`;

    const asing = await get(app, path, { upgrade: "websocket", origin: "http://evil.example" });
    expect(asing.status).toBe(403);

    const cocok = await get(app, path, { upgrade: "websocket", origin: "http://127.0.0.1:3000" });
    expect(cocok.status).toBe(204);

    const tanpa = await get(app, path, { upgrade: "websocket" });
    expect(tanpa.status).toBe(204);

    const takValid = await get(app, path, { upgrade: "websocket", origin: "nota-url" });
    expect(takValid.status).toBe(403);
  });

  test("auth aktif: tanpa cookie 401, dengan cookie 204", async () => {
    const app = makeApp({ auth: true });
    const info = manager!.create({ cwd: dir });
    const path = `/api/terminal/${info.id}/ws`;

    const tanpa = await get(app, path, { upgrade: "websocket" });
    expect(tanpa.status).toBe(401);

    const cookie = await loginCookie(app);
    expect(cookie).not.toBe("");
    const dengan = await get(app, path, { upgrade: "websocket", cookie });
    expect(dengan.status).toBe(204);
    expect(dengan.headers.get(TERMINAL_UPGRADE_HEADER)).toBe(info.id);
  });
});

describe("server nyata: upgrade lewat maybeUpgradeTerminal", () => {
  test("sambung, kirim input biner, terima keluaran; origin asing tak pernah open", async () => {
    const term = newManager();
    const app = createApp({
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      terminal: term,
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      websocket: terminalWebsocket(() => term),
      fetch: async (request, srv) => maybeUpgradeTerminal(request, await app.handle(request), srv),
    });
    const port = server.port!;
    const info = term.create({ cwd: dir });
    const url = `ws://127.0.0.1:${port}/api/terminal/${info.id}/ws`;

    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const texts: Array<Record<string, unknown>> = [];
    const binaries: Uint8Array[] = [];
    let closed = false;
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") texts.push(JSON.parse(event.data) as Record<string, unknown>);
      else binaries.push(new Uint8Array(event.data as ArrayBuffer));
    });
    ws.addEventListener("close", () => {
      closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("gagal membuka websocket")));
    });

    await waitFor(() => texts.some((text) => text.t === "ready"));
    ws.send(new TextEncoder().encode("echo halo-ws\n"));
    const output = (): string => binaries.map((bytes) => new TextDecoder().decode(bytes)).join("");
    await waitFor(() => output().includes("halo-ws"));
    expect(output()).toContain("halo-ws");

    // Origin asing: upgrade ditolak, soket tak pernah terbuka.
    // Bun menerima opsi `headers` saat runtime; tipe DOM hanya mengenal protokol.
    const evil = new WebSocket(url, {
      headers: { Origin: "http://evil.example" },
    } as unknown as string[]);
    let evilOpened = false;
    let evilSettled = false;
    evil.addEventListener("open", () => {
      evilOpened = true;
    });
    evil.addEventListener("error", () => {
      evilSettled = true;
    });
    evil.addEventListener("close", () => {
      evilSettled = true;
    });
    await waitFor(() => evilSettled);
    expect(evilOpened).toBe(false);
    try {
      evil.close();
    } catch {
      // Sudah tertutup.
    }

    // Menutup soket tidak menutup terminal.
    ws.close();
    await waitFor(() => closed);
    expect(term.list().some((terminal) => terminal.id === info.id)).toBe(true);
  });
});
