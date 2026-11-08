import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../src/server";
import type { AgentRunner } from "../src/server/agent";
import { resolveProvider as resolveRegistryProvider } from "../src/server/provider";
import { loadRegistry } from "../src/server/provider-store";
import { SessionManager } from "../src/server/sessions/session-manager";

let dir: string;
let undoDir: string;
let providersFile: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-revert-api-"));
  undoDir = await mkdtemp(join(tmpdir(), "jejak-revert-api-undo-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-revert-api-outside-"));
  const configDir = await mkdtemp(join(tmpdir(), "jejak-revert-api-config-"));
  providersFile = join(configDir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://lokal.test",
          apiKey: "sk-rahasia",
          models: [{ id: "mock-model" }],
          defaultModel: "mock-model",
        },
      ],
      activeProfileId: "lokal",
    }),
    "utf8",
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(undoDir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function completedRunner(): AgentRunner {
  return {
    async *run() {
      yield { type: "session", sessionId: "sdk-1", model: "mock-model" };
      yield { type: "result", ok: true };
    },
  };
}

function hangingRunner(): AgentRunner {
  return {
    async *run() {
      await new Promise<void>(() => {});
    },
  };
}

type App = ReturnType<typeof createApp>;

interface Harness {
  app: App;
  manager: SessionManager;
}

function makeApp(runner: AgentRunner): Harness {
  const manager = new SessionManager({
    runner,
    resolveProvider: async (selection) =>
      resolveRegistryProvider(await loadRegistry(providersFile, { MOCK: "true" }), selection),
  });
  const options: CreateAppOptions = {
    providersPath: providersFile,
    env: { MOCK: "true" },
    sessions: manager,
    undoDir,
  };
  return { app: createApp(options), manager };
}

function req(app: App, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { host: "127.0.0.1:3000" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
}

async function createSession(harness: Harness, cwd = dir): Promise<string> {
  const created = await harness.app.handle(
    new Request("http://127.0.0.1:3000/api/sessions", {
      method: "POST",
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Halo", cwd }),
    }),
  );
  expect(created.status).toBe(201);
  const data = (await created.json()) as { session: { id: string } };
  return data.session.id;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} gagal`);
  return out;
}

async function initRepo(): Promise<void> {
  await git(dir, ["init", "-q", "."]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "awal"]);
}

async function commitAll(message = "ubah"): Promise<void> {
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
}

interface ChangesBody {
  isRepo: boolean;
  files: Array<{
    path: string;
    status: string;
    diffId: string;
    binary: boolean;
    hunks: Array<{ id: string; header: string }>;
  }>;
  truncated: boolean;
}

async function changesFor(app: App, id: string, path: string) {
  const res = await req(app, "GET", `/api/sessions/${id}/changes`);
  const body = (await res.json()) as ChangesBody;
  return body.files.find((file) => file.path === path);
}

async function reject(app: App, id: string, body: unknown): Promise<Response> {
  return req(app, "POST", `/api/sessions/${id}/changes/reject`, body);
}

async function undo(app: App, id: string, body: unknown): Promise<Response> {
  return req(app, "POST", `/api/sessions/${id}/changes/undo`, body);
}

describe("POST changes/reject", () => {
  test("tolak hunk dan berkas lewat API pada sesi selesai", async () => {
    await initRepo();
    const lines = Array.from({ length: 60 }, (_, index) => `baris ${index + 1}`);
    await writeFile(join(dir, "multi.txt"), `${lines.join("\n")}\n`);
    await writeFile(join(dir, "lain.txt"), "awal\n");
    await commitAll("isi");
    const changed = [...lines];
    changed[5] = "baris 6 diubah";
    changed[25] = "baris 26 diubah";
    changed[45] = "baris 46 diubah";
    await writeFile(join(dir, "multi.txt"), `${changed.join("\n")}\n`);
    await writeFile(join(dir, "lain.txt"), "berubah\n");

    const harness = makeApp(completedRunner());
    const id = await createSession(harness);
    await harness.manager.done(id);
    expect(harness.manager.get(id)?.status).toBe("selesai");

    const multi = await changesFor(harness.app, id, "multi.txt");
    expect(multi?.hunks).toHaveLength(3);
    const res = await reject(harness.app, id, {
      path: "multi.txt",
      scope: "hunk",
      hunkId: multi!.hunks[1]!.id,
      diffId: multi!.diffId,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; undoId: string; path: string; scope: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe("multi.txt");
    expect(body.scope).toBe("hunk");
    expect(body.undoId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readFile(join(dir, "multi.txt"), "utf8")).toContain("baris 26\n");

    const lain = await changesFor(harness.app, id, "lain.txt");
    const fileRes = await reject(harness.app, id, {
      path: "lain.txt",
      scope: "file",
      diffId: lain!.diffId,
    });
    expect(fileRes.status).toBe(200);
    expect(await readFile(join(dir, "lain.txt"), "utf8")).toBe("awal\n");
  });

  test("body bukan objek atau tipe salah 400", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");

    const harness = makeApp(completedRunner());
    const id = await createSession(harness);
    await harness.manager.done(id);
    const diff = await changesFor(harness.app, id, "a.txt");

    const cases: unknown[] = [
      "[1,2]",
      {},
      { path: "a.txt", scope: "halaman", diffId: diff!.diffId },
      { path: "a.txt", scope: "file" },
      { path: 5, scope: "file", diffId: diff!.diffId },
      { path: "a.txt", scope: "hunk", diffId: diff!.diffId },
      { path: "a.txt", scope: "file", diffId: "bukan-hex" },
    ];
    for (const body of cases) {
      const res = await reject(harness.app, id, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("berubah\n");
  });

  test("diffId basi 409 dan berkas tidak berubah", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "satu\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "dua\n");

    const harness = makeApp(completedRunner());
    const id = await createSession(harness);
    await harness.manager.done(id);
    const stale = await changesFor(harness.app, id, "a.txt");

    await writeFile(join(dir, "a.txt"), "tiga\n");
    const bytes = await readFile(join(dir, "a.txt"));

    const res = await reject(harness.app, id, {
      path: "a.txt",
      scope: "file",
      diffId: stale!.diffId,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Berkas berubah sejak diff ditampilkan. Muat ulang perubahan.",
    );
    expect(await readFile(join(dir, "a.txt"))).toEqual(bytes);
  });

  test("status A/U/R/biner 400 tanpa perubahan", async () => {
    await initRepo();
    await writeFile(join(dir, "pindah.txt"), "isi\n");
    await writeFile(join(dir, "biner.bin"), Buffer.from([0x61, 0x00, 0x62]));
    await commitAll("isi");

    await writeFile(join(dir, "baru.txt"), "baru\n");
    await git(dir, ["add", "baru.txt"]);
    await git(dir, ["mv", "pindah.txt", "tujuan.txt"]);
    await writeFile(join(dir, "tak.txt"), "tak terlacak\n");
    await writeFile(join(dir, "biner.bin"), Buffer.from([0x61, 0x00, 0x63]));

    const harness = makeApp(completedRunner());
    const id = await createSession(harness);
    await harness.manager.done(id);

    for (const path of ["baru.txt", "tujuan.txt", "tak.txt", "biner.bin"]) {
      const file = await changesFor(harness.app, id, path);
      const res = await reject(harness.app, id, { path, scope: "file", diffId: file!.diffId });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "Jenis perubahan ini belum bisa ditolak lewat Jejak.",
      );
    }
    expect(existsSync(join(dir, "baru.txt"))).toBe(true);
    expect(existsSync(join(dir, "tak.txt"))).toBe(true);
  });

  test("keamanan path 400 tanpa memuat path absolut", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");
    await writeFile(join(outside, "rahasia.txt"), "rahasia\n");
    await symlink(join(outside, "rahasia.txt"), join(dir, "keluar-link"));
    await symlink(dir, join(dir, "dalam-dir-root"));

    const harness = makeApp(completedRunner());
    const id = await createSession(harness);
    await harness.manager.done(id);
    const diff = await changesFor(harness.app, id, "a.txt");

    for (const path of ["../x", "/etc/passwd", "a\0b", ".git/config", "..", "keluar-link"]) {
      const res = await reject(harness.app, id, { path, scope: "file", diffId: diff!.diffId });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toContain("/tmp");
      expect(body.error).not.toContain(outside);
    }
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("berubah\n");
    expect(await readFile(join(outside, "rahasia.txt"), "utf8")).toBe("rahasia\n");
  });

  test("sesi berjalan 409 untuk reject dan undo", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");

    const harness = makeApp(hangingRunner());
    const id = await createSession(harness);
    expect(harness.manager.get(id)?.status).toBe("berjalan");

    const res = await reject(harness.app, id, { path: "a.txt", scope: "file", diffId: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Sesi sedang berjalan. Tunggu selesai atau hentikan dulu.",
    );
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("berubah\n");

    const undoRes = await undo(harness.app, id, { undoId: "00000000-0000-4000-8000-000000000000" });
    expect(undoRes.status).toBe(409);
    harness.manager.interrupt(id);
  });

  test("sesi tidak ada 404", async () => {
    const harness = makeApp(completedRunner());
    const res = await reject(harness.app, "s_tidakada", {
      path: "a.txt",
      scope: "file",
      diffId: "0".repeat(64),
    });
    expect(res.status).toBe(404);
    const undoRes = await undo(harness.app, "s_tidakada", {
      undoId: "00000000-0000-4000-8000-000000000000",
    });
    expect(undoRes.status).toBe(404);
  });
});

describe("POST changes/undo", () => {
  test("reject lalu undo memulihkan berkas; undo kedua 404", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");
    const original = await readFile(join(dir, "a.txt"));

    const harness = makeApp(completedRunner());
    const id = await createSession(harness);
    await harness.manager.done(id);
    const diff = await changesFor(harness.app, id, "a.txt");

    const rejected = await reject(harness.app, id, {
      path: "a.txt",
      scope: "file",
      diffId: diff!.diffId,
    });
    const { undoId } = (await rejected.json()) as { undoId: string };
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("awal\n");
    expect(existsSync(join(undoDir, id, undoId))).toBe(true);

    const undoRes = await undo(harness.app, id, { undoId });
    expect(undoRes.status).toBe(200);
    expect((await undoRes.json()) as { ok: boolean; path: string }).toEqual({
      ok: true,
      path: "a.txt",
    });
    expect(await readFile(join(dir, "a.txt"))).toEqual(original);
    expect(existsSync(join(undoDir, id, undoId))).toBe(false);

    const again = await undo(harness.app, id, { undoId });
    expect(again.status).toBe(404);
  });

  test("undoId tidak valid atau traversal 400, undoId sesi lain 404", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");

    const harness = makeApp(completedRunner());
    const id = await createSession(harness);
    const other = await createSession(harness, outside);
    await harness.manager.done(id);
    await harness.manager.done(other);
    const diff = await changesFor(harness.app, id, "a.txt");
    const { undoId } = (await (
      await reject(harness.app, id, { path: "a.txt", scope: "file", diffId: diff!.diffId })
    ).json()) as { undoId: string };

    for (const bad of ["../../x", "bukan-uuid", "00000000-0000-0000-0000-000000000000", ""]) {
      const res = await undo(harness.app, id, { undoId: bad });
      expect(res.status).toBe(400);
    }

    const wrongSession = await undo(harness.app, other, { undoId });
    expect(wrongSession.status).toBe(404);
  });

  test("undo setelah berkas diubah lagi 409 tanpa menimpa", async () => {
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    await writeFile(join(dir, "a.txt"), "berubah\n");

    const harness = makeApp(completedRunner());
    const id = await createSession(harness);
    await harness.manager.done(id);
    const diff = await changesFor(harness.app, id, "a.txt");
    const { undoId } = (await (
      await reject(harness.app, id, { path: "a.txt", scope: "file", diffId: diff!.diffId })
    ).json()) as { undoId: string };

    await writeFile(join(dir, "a.txt"), "diubah user\n");
    const bytes = await readFile(join(dir, "a.txt"));

    const res = await undo(harness.app, id, { undoId });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Berkas berubah setelah ditolak; tidak bisa diurungkan otomatis.",
    );
    expect(await readFile(join(dir, "a.txt"))).toEqual(bytes);
  });

  test("body undo bukan objek 400", async () => {
    const harness = makeApp(completedRunner());
    await initRepo();
    await writeFile(join(dir, "a.txt"), "awal\n");
    await commitAll("isi");
    const id = await createSession(harness);
    await harness.manager.done(id);

    for (const body of ["[1]", {}, { undoId: 5 }]) {
      const res = await undo(harness.app, id, body);
      expect(res.status).toBe(400);
    }
  });
});

describe("guard pada rute revert", () => {
  test("Host evil.test ditolak 403", async () => {
    const harness = makeApp(completedRunner());
    const res = await harness.app.handle(
      new Request("http://127.0.0.1:3000/api/sessions/s_x/changes/reject", {
        method: "POST",
        headers: { host: "evil.test", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "host tidak diizinkan" });
  });

  test("tanpa content-type JSON ditolak 415", async () => {
    const harness = makeApp(completedRunner());
    const res = await harness.app.handle(
      new Request("http://127.0.0.1:3000/api/sessions/s_x/changes/undo", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "text/plain" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(415);
  });
});
