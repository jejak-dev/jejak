import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent";
import { createApp } from "../src/server";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import { WorktreeService } from "../src/server/git/worktree-service";
import type { ProviderSelection, ResolvedProvider } from "../src/server/provider";
import { FileSandboxStore } from "../src/server/sandbox/sandbox-config";
import {
  SessionError,
  SessionManager,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";

const HOME = "/rumah/uji";

let root: string;
let repo: string;
let project: string;
const audits: AuditStore[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-sesi-sandbox-"));
  repo = join(root, "repo");
  project = join(root, "proyek");
  await mkdir(repo, { recursive: true });
  await mkdir(project, { recursive: true });
  project = await realpath(project);
});

afterEach(async () => {
  for (const audit of audits.splice(0)) audit.close();
  await rm(root, { recursive: true, force: true });
});

function provider(selection: ProviderSelection): ResolvedProvider {
  return {
    profileId: selection.profileId ?? "lokal",
    apiKey: "kunci",
    model: "model-uji",
    baseUrl: "https://api.provider.test/v1",
  };
}

function captureRunner(
  events: AgentEvent[] = [
    { type: "session", sessionId: "sdk-uji" },
    { type: "result", ok: true },
  ],
): {
  runner: AgentRunner;
  inputs: RunInput[];
} {
  const inputs: RunInput[] = [];
  return {
    inputs,
    runner: {
      async *run(input) {
        inputs.push(input);
        for (const event of events) yield event;
      },
    },
  };
}

function manager(runner: AgentRunner, extra: Partial<SessionManagerOptions> = {}): SessionManager {
  return new SessionManager({
    runner,
    resolveProvider: async (selection) => provider(selection),
    home: HOME,
    ...extra,
  });
}

function sandboxStore(): FileSandboxStore {
  return new FileSandboxStore(":memory:");
}

function memoryAudit(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  audits.push(store);
  return store;
}

type SandboxOptions = {
  enabled: boolean;
  filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] };
  network: { allowedDomains: string[]; strictAllowlist: boolean };
};

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} gagal: ${err}`);
  return out;
}

async function initRepo(): Promise<void> {
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", "t"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await writeFile(join(repo, "awal.txt"), "awal\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "awal"]);
}

describe("SessionManager + sandbox", () => {
  test("default standar meneruskan opsi sandbox ke runner", async () => {
    const capture = captureRunner();
    const mgr = manager(capture.runner, {
      sandbox: { store: sandboxStore(), home: HOME },
    });
    const info = await mgr.create({ prompt: "Halo", cwd: project });
    await mgr.done(info.id);

    const sandbox = capture.inputs[0]?.sandbox as SandboxOptions;
    expect(sandbox).toBeDefined();
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.network.strictAllowlist).toBe(true);
    // Folder kerja biasa tidak perlu allowWrite tambahan (sudah cwd SDK).
    expect(sandbox.filesystem.allowWrite).toEqual([]);
    expect(sandbox.filesystem.denyWrite).toContain(join(project, ".git", "hooks"));
    expect(sandbox.network.allowedDomains).toContain("api.provider.test");
  });

  test("di Windows tanpa pilihan eksplisit sesi dibuat tanpa sandbox", async () => {
    const asli = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const capture = captureRunner();
      const mgr = manager(capture.runner, {
        sandbox: { store: sandboxStore(), home: HOME },
      });
      const info = await mgr.create({ prompt: "Halo", cwd: project });
      await mgr.done(info.id);
      expect(info.sandbox).toBe("mati");
      expect(capture.inputs[0]?.sandbox).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", asli);
    }
  });

  test("sesi bermode mati tidak mengisi input.sandbox", async () => {
    const capture = captureRunner();
    const mgr = manager(capture.runner, {
      sandbox: { store: sandboxStore(), home: HOME },
    });
    const info = await mgr.create({ prompt: "Halo", cwd: project, sandbox: "mati" });
    await mgr.done(info.id);

    expect(info.sandbox).toBe("mati");
    expect(capture.inputs[0]?.sandbox).toBeUndefined();
  });

  test("mode global berubah tidak mengubah sesi lama", async () => {
    const store = sandboxStore();
    const capture = captureRunner();
    const mgr = manager(capture.runner, { sandbox: { store, home: HOME } });
    const info = await mgr.create({ prompt: "Halo", cwd: project });
    await mgr.done(info.id);
    expect(info.sandbox).toBe("standar");

    store.set({ mode: "mati" });
    const follow = await mgr.send(info.id, "Lagi");
    expect(follow.queued).toBe(false);
    await mgr.done(info.id);

    expect(capture.inputs[1]?.sandbox).toBeDefined();
  });

  test("sesi baru mengikuti mode global terbaru", async () => {
    const store = sandboxStore();
    store.set({ mode: "mati" });
    const capture = captureRunner();
    const mgr = manager(capture.runner, { sandbox: { store, home: HOME } });
    const info = await mgr.create({ prompt: "Halo", cwd: project });
    await mgr.done(info.id);
    expect(info.sandbox).toBe("mati");
    expect(capture.inputs[0]?.sandbox).toBeUndefined();
  });

  test("host profil cadangan ikut masuk allowlist jaringan Bash", async () => {
    const capture = captureRunner();
    const mgr = manager(capture.runner, {
      sandbox: { store: sandboxStore(), home: HOME },
      fallback: async () => ({ profileId: "cadangan", baseUrl: "https://cadangan.example.net/v1" }),
    });
    const info = await mgr.create({ prompt: "Halo", cwd: project });
    await mgr.done(info.id);
    const sandbox = capture.inputs[0]?.sandbox as SandboxOptions;
    expect(sandbox.network.allowedDomains).toContain("cadangan.example.net");
  });

  test("worktree memuat repoRoot dan worktree di allowWrite serta denyWrite", async () => {
    await initRepo();
    const capture = captureRunner();
    const mgr = manager(capture.runner, {
      sandbox: { store: sandboxStore(), home: HOME },
      worktrees: new WorktreeService({ root: join(root, "worktrees") }),
    });
    const info = await mgr.create({ prompt: "Halo", cwd: repo, worktree: true });
    await mgr.done(info.id);

    const sandbox = capture.inputs[0]?.sandbox as SandboxOptions;
    const repoRoot = info.worktree!.repoRoot;
    expect(sandbox.filesystem.allowWrite).toContain(repoRoot);
    expect(sandbox.filesystem.denyWrite).toContain(join(repoRoot, ".git", "hooks"));
    expect(sandbox.filesystem.denyWrite).toContain(join(info.worktree!.path, ".git", "hooks"));
  });

  test("gagal membangun opsi -> giliran gagal tertutup, runner tidak dipanggil", async () => {
    const capture = captureRunner();
    const broken = {
      get() {
        throw new Error("store rusak");
      },
      set() {
        throw new Error("store rusak");
      },
    };
    const mgr = manager(capture.runner, {
      sandbox: { store: broken, home: HOME },
    });
    // Mode tak diketahui (get melempar) dianggap standar -> coba bangun opsi.
    const info = await mgr.create({ prompt: "Halo", cwd: project });
    await mgr.done(info.id);

    expect(capture.inputs).toHaveLength(0);
    const view = mgr.get(info.id);
    expect(view?.status).toBe("gagal");
    const events = [];
    for await (const item of mgr.events(info.id)) events.push(item.event);
    expect(events.some((event) => event.type === "error" && event.message.includes("Sandbox"))).toBe(
      true,
    );
  });

  test("audit sesi tanpa sandbox", async () => {
    const audit = memoryAudit();
    const capture = captureRunner();
    const mgr = manager(capture.runner, {
      sandbox: { store: sandboxStore(), home: HOME },
      audit,
    });
    const info = await mgr.create({ prompt: "Halo", cwd: project, sandbox: "mati" });
    await mgr.done(info.id);

    const entries = audit.list({ session: info.id, kind: "pengaturan", limit: 50 });
    const entry = entries.find((item) => item.summary === "Sesi dibuat tanpa sandbox");
    expect(entry?.meta).toEqual({ aksi: "sandbox-mati" });
  });

  test("audit sandbox dari hasil tool yang memuat pelanggaran", async () => {
    const audit = memoryAudit();
    const capture = captureRunner([
      { type: "tool_call", id: "t1", name: "Bash", input: { command: "curl https://example.org" } },
      {
        type: "tool_result",
        id: "t1",
        isError: true,
        output:
          "gagal\n<sandbox_violations>\ndeny network-outbound example.org:443 (host is not on the allow list)\n</sandbox_violations>",
      },
      { type: "result", ok: true },
    ]);
    const mgr = manager(capture.runner, {
      sandbox: { store: sandboxStore(), home: HOME },
      audit,
    });
    const info = await mgr.create({ prompt: "Halo", cwd: project });
    await mgr.done(info.id);

    const entries = audit.list({ session: info.id, kind: "sandbox", limit: 50 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary).toBe("Sandbox menolak: deny network-outbound example.org:443 (host is not on the allow list)");
    expect(entries[0]?.meta).toEqual({ jumlah: 1 });
    expect(entries[0]?.summary).not.toContain("<sandbox_violations>");
  });

  test("petunjuk galat ditambahkan saat pesan menyebut sandbox", async () => {
    const capture = captureRunner([
      { type: "error", message: "sandbox gagal dijalankan" },
      { type: "result", ok: false, error: "sandbox gagal dijalankan" },
    ]);
    const mgr = manager(capture.runner, {
      sandbox: { store: sandboxStore(), home: HOME },
    });
    const info = await mgr.create({ prompt: "Halo", cwd: project });
    await mgr.done(info.id);

    const events = [];
    for await (const item of mgr.events(info.id)) events.push(item.event);
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" ? error.message : "").toContain("jejak doctor");
  });

  test("tanpa store sandbox tidak ada opsi dan field sandbox ditolak", async () => {
    const capture = captureRunner();
    const mgr = manager(capture.runner);
    const info = await mgr.create({ prompt: "Halo", cwd: project });
    await mgr.done(info.id);
    expect(info.sandbox).toBeUndefined();
    expect(capture.inputs[0]?.sandbox).toBeUndefined();

    await expect(
      mgr.create({ prompt: "Halo", cwd: project, sandbox: "standar" }),
    ).rejects.toThrow(SessionError);
  });

  test("nilai sandbox tak dikenal ditolak", async () => {
    const capture = captureRunner();
    const mgr = manager(capture.runner, { sandbox: { store: sandboxStore(), home: HOME } });
    await expect(
      mgr.create({
        prompt: "Halo",
        cwd: project,
        sandbox: "nyala" as unknown as "standar",
      }),
    ).rejects.toThrow('Field sandbox hanya "standar" atau "mati".');
    expect(capture.inputs).toHaveLength(0);
  });
});

describe("POST /api/sessions field sandbox", () => {
  function app(store: FileSandboxStore | undefined): ReturnType<typeof createApp> {
    return createApp({
      env: { MOCK: "true", JEJAK_HOME: join(root, "jejak-home") },
      ...(store === undefined ? {} : { sandbox: store }),
    });
  }

  function post(target: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
    return target.handle(
      new Request("http://127.0.0.1:3000/api/sessions", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  test("field sandbox tersimpan di SessionInfo; nilai lain 400", async () => {
    const target = app(sandboxStore());
    const res = await post(target, { prompt: "Halo", cwd: project, sandbox: "mati" });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { session: { sandbox?: string } };
    expect(payload.session.sandbox).toBe("mati");

    const bad = await post(target, { prompt: "Halo", cwd: project, sandbox: "nyala" });
    expect(bad.status).toBe(400);
  });

  test("tanpa store field sandbox eksplisit ditolak 400 Sandbox dimatikan.", async () => {
    const target = app(undefined);
    const res = await post(target, { prompt: "Halo", cwd: project, sandbox: "standar" });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("Sandbox dimatikan.");
  });
});
