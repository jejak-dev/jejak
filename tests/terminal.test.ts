import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import { checkSecretAccess } from "../src/server/security/secret-paths";
import { TerminalError, TerminalManager, scrubEnv } from "../src/server/terminal/terminal-manager";

let dir: string;
let manager: TerminalManager | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-terminal-"));
});

afterEach(async () => {
  manager?.closeAll();
  manager = undefined;
  await rm(dir, { recursive: true, force: true });
});

function newManager(options: ConstructorParameters<typeof TerminalManager>[0] = {}): TerminalManager {
  manager = new TerminalManager({ shell: "/bin/sh", env: { PATH: process.env.PATH, HOME: dir }, ...options });
  return manager;
}

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waktu habis menunggu keluaran");
    await Bun.sleep(25);
  }
}

describe("scrubEnv", () => {
  test("membuang kunci internal dan rahasia, mempertahankan PATH, mengatur TERM", () => {
    const env = scrubEnv({
      PATH: "/usr/bin",
      HOME: "/h",
      ANTHROPIC_AUTH_TOKEN: "a",
      JEJAK_API_KEY: "b",
      CLAUDE_CODE_OAUTH_TOKEN: "c",
      GITHUB_TOKEN: "d",
      DB_PASSWORD: "e",
      LANG: "id_ID.UTF-8",
      KOSONG: undefined,
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "TERM"]);
    expect(env.TERM).toBe("xterm-256color");
  });
});

describe("TerminalManager (PTY nyata)", () => {
  test("membuat shell, menulis perintah, membaca keluaran dan replay", async () => {
    const m = newManager();
    const info = m.create({ cwd: dir });
    expect(info.cols).toBe(80);
    let text = "";
    const sub = m.subscribe(info.id, {
      onData: (bytes) => (text += new TextDecoder().decode(bytes)),
      onExit: () => {},
    });
    m.write(info.id, "echo halo-$((20+22))\n");
    await waitFor(() => text.includes("halo-42"));
    sub.unsubscribe();
    const again = m.subscribe(info.id, { onData: () => {}, onExit: () => {} });
    expect(new TextDecoder().decode(again.replay)).toContain("halo-42");
    expect(m.list()).toHaveLength(1);
  });

  test("shell memakai cwd yang diminta dan env tersaring", async () => {
    const m = newManager({ env: { PATH: process.env.PATH, HOME: dir, JEJAK_API_KEY: "rahasia-uji" } });
    const info = m.create({ cwd: dir });
    let text = "";
    m.subscribe(info.id, { onData: (b) => (text += new TextDecoder().decode(b)), onExit: () => {} });
    m.write(info.id, "pwd; echo kunci=[$JEJAK_API_KEY]\n");
    // Gema perintah memuat "kunci=[$JEJAK_API_KEY]"; tunggu hasil sebenarnya, bukan gema.
    await waitFor(() => text.replace(/\r/g, "").includes("kunci=[]"));
    expect(text.replace(/\r/g, "")).toContain("kunci=[]");
    expect(text).not.toContain("rahasia-uji");
  });

  test("resize, exit, dan close", async () => {
    const m = newManager();
    const info = m.create({ cwd: dir, cols: 100, rows: 30 });
    expect(m.resize(info.id, 120, 40)).toMatchObject({ cols: 120, rows: 40 });
    expect(() => m.resize(info.id, 5, 40)).toThrow(TerminalError);
    let exitCode: number | null | undefined;
    m.subscribe(info.id, { onData: () => {}, onExit: (code) => (exitCode = code) });
    m.write(info.id, "exit 3\n");
    await waitFor(() => exitCode !== undefined);
    expect(exitCode).toBe(3);
    expect(() => m.write(info.id, "x")).toThrow(/selesai/);
    m.close(info.id);
    expect(m.list()).toHaveLength(0);
    expect(() => m.close(info.id)).toThrow(/tidak ditemukan/);
  });

  test("validasi: cwd, ukuran, input, batas jumlah, penyapu idle", async () => {
    let now = 1_000_000;
    const m = newManager({ maxTerminals: 2, idleMs: 60_000, now: () => now });
    expect(() => m.create({ cwd: "relatif" })).toThrow(TerminalError);
    expect(() => m.create({ cwd: join(dir, "nihil") })).toThrow(TerminalError);
    expect(() => m.create({ cwd: dir, cols: 5 })).toThrow(TerminalError);
    const a = m.create({ cwd: dir });
    m.create({ cwd: dir });
    expect(() => m.create({ cwd: dir })).toThrow(/Batas 2/);
    expect(() => m.write(a.id, "")).toThrow(TerminalError);
    expect(() => m.write(a.id, "x".repeat(64 * 1024 + 1))).toThrow(/terlalu besar/);
    expect(() => m.write("nihil", "x")).toThrow(/tidak ditemukan/);
    now += 61_000;
    m.sweep();
    expect(m.list()).toHaveLength(0);
  });
});

describe("rute", () => {
  function setup(enabled = true) {
    const audit = new SqliteAuditStore(":memory:");
    const term = enabled ? newManager() : undefined;
    const app = createApp({
      env: { MOCK: "true", JEJAK_HOME: join(dir, "home") },
      audit,
      ...(term === undefined ? {} : { terminal: term }),
    });
    const req = (method: string, path: string, body?: unknown, signal?: AbortSignal) => {
      const headers: Record<string, string> = { host: "127.0.0.1:3000" };
      const init: RequestInit = { method, headers, ...(signal === undefined ? {} : { signal }) };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
    };
    return { req, audit, term };
  }

  test("alur: buka, tulis dan baca lewat manager, ubah ukuran, tutup, audit", async () => {
    const { req, audit, term } = setup();
    const created = await req("POST", "/api/terminal", { cwd: dir });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    let text = "";
    const sub = term!.subscribe(id, {
      onData: (bytes) => (text += new TextDecoder().decode(bytes)),
      onExit: () => {},
    });
    term!.write(id, "echo sse-ok\n");
    await waitFor(() => text.includes("sse-ok"));
    sub.unsubscribe();
    expect(term!.resize(id, 90, 30)).toMatchObject({ cols: 90, rows: 30 });
    expect((await req("DELETE", `/api/terminal/${id}`, {})).status).toBe(200);
    expect((await req("DELETE", `/api/terminal/${id}`, {})).status).toBe(404);
    const summaries = audit.list({ kind: "pengaturan", limit: 10 }).map((e) => e.summary);
    expect(summaries).toContain("Terminal dibuka");
    expect(summaries).toContain("Terminal ditutup");
    // Isi ketikan tidak pernah masuk audit.
    expect(JSON.stringify(audit.list({ limit: 50 }))).not.toContain("sse-ok");
    audit.close();
  });

  test("galat dan mati secara default (503)", async () => {
    const { req, audit } = setup();
    expect((await req("POST", "/api/terminal", { cwd: "relatif" })).status).toBe(400);
    expect((await req("POST", "/api/terminal", { cwd: dir, x: 1 })).status).toBe(400);
    expect((await req("GET", "/api/terminal/nihil/ws")).status).toBe(404);
    audit.close();
    const off = setup(false);
    expect((await off.req("GET", "/api/terminal")).status).toBe(503);
    expect((await off.req("POST", "/api/terminal", { cwd: dir })).status).toBe(503);
    off.audit.close();
  });
});

test("Bash yang menyebut /api/terminal diblokir", () => {
  const verdict = checkSecretAccess({
    toolName: "Bash",
    toolInput: { command: "curl -X POST http://127.0.0.1:3000/api/terminal -d '{}'" },
    cwd: "/proyek/uji",
    home: "/rumah/uji",
  });
  expect(verdict.blocked).toBe(true);
  expect(verdict.rule).toBe("terminal-api");
});
