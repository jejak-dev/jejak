import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import { TerminalError, type TerminalManager } from "../src/server/terminal/terminal-manager";

/** Terminal palsu: mencatat create dan write tanpa menjalankan shell. */
class TerminalPalsu {
  readonly dibuat: Array<{ cwd: unknown }> = [];
  readonly ditulis: Array<{ id: string; data: unknown }> = [];
  galat: Error | undefined;

  create(input: { cwd: unknown; cols?: unknown; rows?: unknown }): { id: string; cwd: string } {
    this.dibuat.push({ cwd: input.cwd });
    if (this.galat !== undefined) throw this.galat;
    return { id: `t${this.dibuat.length}`, cwd: String(input.cwd) };
  }

  write(id: string, data: unknown): void {
    this.ditulis.push({ id, data });
  }
}

let dir: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-runner-route-"));
  providersFile = join(dir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://lokal.test",
          apiKey: "sk-rahasia-123",
          models: [{ id: "mock-model" }],
          defaultModel: "mock-model",
        },
      ],
      activeProfileId: "lokal",
    }),
    "utf8",
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { test: "bun test" } }),
    "utf8",
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

interface Setup {
  app: App;
  audit: SqliteAuditStore;
  terminal: TerminalPalsu;
  req: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
}

/** Aplikasi uji dengan satu sesi pada folder `dir` (folder yang diizinkan). */
async function setup(
  options: { terminal?: boolean; auth?: boolean; galatTerminal?: Error } = {},
): Promise<Setup> {
  const audit = new SqliteAuditStore(":memory:");
  const terminal = new TerminalPalsu();
  terminal.galat = options.galatTerminal;
  const app = createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home"), JEJAK_WORKTREES: "0" },
    runner: createMockRunner(),
    audit,
    runnerPath: join(dir, "runner.json"),
    ...(options.terminal === false ? {} : { terminal: terminal as unknown as TerminalManager }),
    ...(options.auth === true ? { auth: { password: "sandi-uji-123", port: 3000 } } : {}),
  });
  const req = (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response> => {
    const merged: Record<string, string> = { host: "127.0.0.1:3000", ...headers };
    const init: RequestInit = { method, headers: merged };
    if (body !== undefined) {
      merged["content-type"] = merged["content-type"] ?? "application/json";
      init.body = JSON.stringify(body);
    }
    return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
  };
  return { app, audit, terminal, req };
}

/** Buat sesi agar folder `dir` menjadi folder yang diizinkan. */
async function buatSesi(app: App, req: Setup["req"]): Promise<void> {
  const res = await req("POST", "/api/sessions", { prompt: "Halo", cwd: dir });
  expect(res.status).toBe(201);
}

describe("rute runner", () => {
  test("daftar perintah folder sesi", async () => {
    const { app, req, audit } = await setup();
    await buatSesi(app, req);

    const res = await req("GET", `/api/runner?cwd=${dir}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      commands: Array<{ id: string; label: string; command: string; source: string; confirmed: boolean }>;
    };
    expect(payload.commands).toHaveLength(1);
    expect(payload.commands[0]?.label).toBe("test");
    expect(payload.commands[0]?.command).toBe("bun run test");
    expect(payload.commands[0]?.source).toBe("package");
    expect(payload.commands[0]?.confirmed).toBe(false);
    audit.close();
  });

  test("tambah, ubah, dan hapus perintah kustom", async () => {
    const { app, req, audit } = await setup();
    await buatSesi(app, req);

    const tambah = await req("POST", "/api/runner/custom", {
      cwd: dir,
      label: "PerBuild",
      command: "bun run build",
      group: "Build",
    });
    expect(tambah.status).toBe(201);
    const dibuat = (await tambah.json()) as { command: { id: string; source: string } };
    expect(dibuat.command.source).toBe("custom");
    expect(dibuat.command.id).toMatch(/^c_[0-9a-f]{8}$/);

    const daftar = await req("GET", `/api/runner?cwd=${dir}`);
    const isi = (await daftar.json()) as { commands: Array<{ id: string; source: string }> };
    expect(isi.commands.map((item) => item.source)).toEqual(["package", "custom"]);

    const ubah = await req("PATCH", `/api/runner/custom/${dibuat.command.id}`, {
      cwd: dir,
      command: "bun run build --watch",
    });
    expect(ubah.status).toBe(200);
    const diubah = (await ubah.json()) as { command: { command: string } };
    expect(diubah.command.command).toBe("bun run build --watch");

    const hapus = await req("DELETE", `/api/runner/custom/${dibuat.command.id}?cwd=${dir}`, {});
    expect(hapus.status).toBe(200);
    const akhir = await req("GET", `/api/runner?cwd=${dir}`);
    const isiAkhir = (await akhir.json()) as { commands: Array<{ source: string }> };
    expect(isiAkhir.commands.map((item) => item.source)).toEqual(["package"]);
    audit.close();
  });

  test("field tak dikenal dan nilai tidak valid menjawab 400", async () => {
    const { app, req, audit } = await setup();
    await buatSesi(app, req);

    const asing = await req("POST", "/api/runner/custom", {
      cwd: dir,
      label: "Uji",
      command: "bun test",
      ekstra: 1,
    });
    expect(asing.status).toBe(400);

    const salah = await req("POST", "/api/runner/custom", {
      cwd: dir,
      label: "Uji",
      command: `bun test${String.fromCharCode(10)}bun build`,
    });
    expect(salah.status).toBe(400);

    const tanpaCwd = await req("POST", "/api/runner/custom", { label: "Uji", command: "bun test" });
    expect(tanpaCwd).toBeDefined();
    expect((await req("GET", "/api/runner")).status).toBe(400);
    audit.close();
  });

  test("folder tak dikenal menjawab 404", async () => {
    const { app, req, audit } = await setup();
    await buatSesi(app, req);

    const res = await req("GET", `/api/runner?cwd=${join(dir, "lain")}`);
    expect(res.status).toBe(404);
    audit.close();
  });

  test("jalankan tanpa konfirmasi menjawab 409, dengan confirm berjalan", async () => {
    const { app, req, terminal, audit } = await setup();
    await buatSesi(app, req);

    const daftar = await req("GET", `/api/runner?cwd=${dir}`);
    const isi = (await daftar.json()) as { commands: Array<{ id: string }> };
    const id = isi.commands[0]!.id;

    const tanpaKonfirmasi = await req("POST", "/api/runner/run", { cwd: dir, id });
    expect(tanpaKonfirmasi.status).toBe(409);
    expect(terminal.dibuat).toHaveLength(0);

    const jalan = await req("POST", "/api/runner/run", { cwd: dir, id, confirm: true });
    expect(jalan.status).toBe(200);
    const hasil = (await jalan.json()) as { terminalId: string };
    expect(hasil.terminalId).toBe("t1");
    expect(terminal.ditulis).toEqual([
      { id: "t1", data: `bun run test${String.fromCharCode(10)}` },
    ]);

    // Konfirmasi tersimpan: jalankan lagi tanpa confirm.
    const kedua = await req("POST", "/api/runner/run", { cwd: dir, id });
    expect(kedua.status).toBe(200);
    audit.close();
  });

  test("rute run menolak field command", async () => {
    const { app, req, terminal, audit } = await setup();
    await buatSesi(app, req);

    const res = await req("POST", "/api/runner/run", {
      cwd: dir,
      id: "c_00000000",
      command: "bun test",
    });
    expect(res.status).toBe(400);
    expect(terminal.dibuat).toHaveLength(0);
    audit.close();
  });

  test("id tak dikenal menjawab 404", async () => {
    const { app, req, audit } = await setup();
    await buatSesi(app, req);

    const res = await req("POST", "/api/runner/run", { cwd: dir, id: "c_00000000" });
    expect(res.status).toBe(404);
    audit.close();
  });

  test("batas terminal menjawab 429", async () => {
    const { app, req, audit } = await setup({
      galatTerminal: new TerminalError("Batas 4 terminal aktif tercapai.", "batas"),
    });
    await buatSesi(app, req);

    const daftar = await req("GET", `/api/runner?cwd=${dir}`);
    const isi = (await daftar.json()) as { commands: Array<{ id: string }> };
    const res = await req("POST", "/api/runner/run", {
      cwd: dir,
      id: isi.commands[0]!.id,
      confirm: true,
    });
    expect(res.status).toBe(429);
    audit.close();
  });

  test("tanpa terminal: daftar tetap jalan, run menjawab 503", async () => {
    const { app, req, audit } = await setup({ terminal: false });
    await buatSesi(app, req);

    const daftar = await req("GET", `/api/runner?cwd=${dir}`);
    expect(daftar.status).toBe(200);

    const isi = (await daftar.json()) as { commands: Array<{ id: string }> };
    const res = await req("POST", "/api/runner/run", {
      cwd: dir,
      id: isi.commands[0]!.id,
      confirm: true,
    });
    expect(res.status).toBe(503);
    const pesan = (await res.json()) as { error: string };
    expect(pesan.error).toBe(
      "Terminal dimatikan. Jalankan Jejak dengan JEJAK_TERMINAL=1 untuk menyalakannya.",
    );
    audit.close();
  });

  test("autentikasi aktif tanpa cookie menjawab 401", async () => {
    const { req, audit } = await setup({ auth: true });
    // Masuk dulu agar sesi boleh dibuat; lalu rute runner diuji tanpa cookie.
    const masuk = await req("POST", "/api/auth/login", { password: "sandi-uji-123" });
    expect(masuk.status).toBe(200);
    const cookie = (masuk.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const sesi = await req("POST", "/api/sessions", { prompt: "Halo", cwd: dir }, { cookie });
    expect(sesi.status).toBe(201);

    const res = await req("GET", `/api/runner?cwd=${dir}`);
    expect(res.status).toBe(401);
    audit.close();
  });

  test("audit mencatat aksi runner dengan teks dipotong", async () => {
    const { app, req, audit } = await setup();
    await buatSesi(app, req);

    const panjang = `echo ${"x".repeat(400)}`;
    const tambah = await req("POST", "/api/runner/custom", {
      cwd: dir,
      label: "Uji",
      command: panjang,
    });
    const dibuat = (await tambah.json()) as { command: { id: string } };

    const daftar = await req("GET", `/api/runner?cwd=${dir}`);
    const isi = (await daftar.json()) as { commands: Array<{ id: string; source: string }> };
    const paket = isi.commands.find((item) => item.source === "package")!;
    await req("POST", "/api/runner/run", { cwd: dir, id: paket.id, confirm: true });

    const entri = audit.list({ kind: "pengaturan", limit: 20 });
    const aksi = entri.map((item) => meta(item)["aksi"]);
    expect(aksi).toContain("runner-tambah");
    expect(aksi).toContain("runner-jalankan");

    const jalankan = entri.find((item) => meta(item)["aksi"] === "runner-jalankan");
    const isiJalankan = meta(jalankan);
    expect(String(isiJalankan["perintah"] ?? "").length).toBeLessThanOrEqual(200);
    expect(String(isiJalankan["hash"] ?? "")).toMatch(/^[0-9a-f]{64}$/);
    expect(isiJalankan["cwd"]).toBe(dir);
    expect(dibuat.command.id).toMatch(/^c_/);
    audit.close();
  });
});

/** Meta audit dibaca sebagai catatan sederhana. */
function meta(entry: unknown): Record<string, unknown> {
  const record = entry as { meta?: Record<string, unknown> };
  return record.meta ?? {};
}
