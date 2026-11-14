import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChecks, type Check, type DoctorContext } from "../src/cli/doctor";
import { runShadowGit } from "../src/server/checkpoints/shadow-git";
import { nativePickerAvailable } from "../src/server/files/native-picker";
import { nullDevice, TERMINAL_UNAVAILABLE_WINDOWS } from "../src/server/platform";
import { terminalRoutes } from "../src/server/routes/terminal";
import { RunnerError, RunnerService } from "../src/server/runner/runner-service";
import { FileRunnerStore } from "../src/server/runner/runner-store";
import { sandboxAvailable } from "../src/server/sandbox/build-options";
import { TerminalError, TerminalManager } from "../src/server/terminal/terminal-manager";

/** CLI `claude` selalu dianggap tidak ada; membuat tes deterministik. */
const CLI_TIDAK_ADA = {
  which: () => null,
  exists: async () => false,
  runVersion: async () => null,
};

const TERMINAL_DISABLED =
  "Terminal dimatikan. Jalankan Jejak dengan JEJAK_TERMINAL=1 untuk menyalakannya.";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-windows-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function baseCtx(ctx: DoctorContext = {}): DoctorContext {
  return {
    sdkRoot: join(dir, "sdk"),
    locate: CLI_TIDAK_ADA,
    env: { HOME: dir, JEJAK_HOME: join(dir, ".jejak") },
    ...ctx,
  };
}

function find(checks: Check[], name: string): Check {
  const check = checks.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`cek "${name}" tidak ditemukan`);
  return check;
}

describe("doctor di Windows", () => {
  test("cek Git dan Git Bash hanya muncul di platform win32", async () => {
    const windows = await collectChecks(
      baseCtx({
        platform: "win32",
        which: () => "C:\\Program Files\\Git\\cmd\\git.exe",
        fileExists: (path) => path === "C:\\Program Files\\Git\\bin\\bash.exe",
      }),
    );
    const git = find(windows, "Git untuk Windows");
    expect(git.status).toBe("ok");
    expect(git.detail).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
    const bash = find(windows, "Git Bash");
    expect(bash.status).toBe("ok");
    expect(bash.detail).toBe("C:\\Program Files\\Git\\bin\\bash.exe");

    const posix = await collectChecks(baseCtx({ platform: "darwin" }));
    expect(posix.map((check) => check.name)).not.toContain("Git untuk Windows");
    expect(posix.map((check) => check.name)).not.toContain("Git Bash");
  });

  test("git dan bash yang tak ada dilaporkan sebagai peringatan", async () => {
    const checks = await collectChecks(
      baseCtx({
        platform: "win32",
        which: () => null,
        fileExists: () => false,
      }),
    );
    const git = find(checks, "Git untuk Windows");
    expect(git.status).toBe("peringatan");
    expect(git.detail).toContain("git-scm.com");
    const bash = find(checks, "Git Bash");
    expect(bash.status).toBe("peringatan");
    expect(bash.detail).toContain("CLAUDE_CODE_GIT_BASH_PATH");
  });

  test("sandbox dinyatakan tak tersedia di Windows", async () => {
    const checks = await collectChecks(baseCtx({ platform: "win32" }));
    const sandbox = find(checks, "Sandbox");
    expect(sandbox.status).toBe("peringatan");
    expect(sandbox.detail).toBe("Sandbox tidak tersedia di Windows.");
  });
});

describe("terminal di Windows", () => {
  test("TerminalManager.create melempar TerminalError yang jelas", () => {
    const manager = new TerminalManager({ platform: "win32", env: {} });
    expect(() => manager.create({ cwd: dir })).toThrow(TerminalError);
    try {
      manager.create({ cwd: dir });
      throw new Error("harusnya melempar TerminalError");
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalError);
      expect((error as TerminalError).message).toContain("Windows");
      expect((error as TerminalError).code).toBe("tidak-valid");
    }
  });

  test("di POSIX galat Windows tidak muncul", () => {
    const manager = new TerminalManager({ platform: "darwin", env: {} });
    // Folder tak ada: galat soal cwd, bukan soal Windows.
    expect(() => manager.create({ cwd: join(dir, "tidak-ada") })).toThrow(
      /cwd tidak ditemukan atau bukan direktori/,
    );
  });

  test("rute terminal tanpa manajer menjawab 503 dengan pesan platform", async () => {
    const windows = terminalRoutes({ platform: "win32" });
    const jawabanWindows = await windows.handle(
      new Request("http://127.0.0.1:3000/api/terminal"),
    );
    expect(jawabanWindows.status).toBe(503);
    expect(await jawabanWindows.json()).toEqual({ error: TERMINAL_UNAVAILABLE_WINDOWS });

    const posix = terminalRoutes({ platform: "darwin" });
    const jawabanPosix = await posix.handle(
      new Request("http://127.0.0.1:3000/api/terminal"),
    );
    expect(jawabanPosix.status).toBe(503);
    expect(await jawabanPosix.json()).toEqual({ error: TERMINAL_DISABLED });
  });

  test("runner tanpa terminal di Windows memakai pesan Windows", () => {
    const layanan = new RunnerService({
      store: new FileRunnerStore(":memory:"),
      allowedCwds: () => [dir],
      platform: "win32",
    });
    const custom = layanan.addCustom({ cwd: dir, label: "Uji", command: "bun test" });
    try {
      layanan.run({ cwd: dir, id: custom.id, confirm: true });
      throw new Error("harusnya ditolak");
    } catch (error) {
      expect(error).toBeInstanceOf(RunnerError);
      expect((error as RunnerError).code).toBe("nonaktif");
      expect((error as RunnerError).message).toBe(TERMINAL_UNAVAILABLE_WINDOWS);
    }
  });

  test("runner tanpa terminal di POSIX memakai pesan terminal dimatikan", () => {
    const layanan = new RunnerService({
      store: new FileRunnerStore(":memory:"),
      allowedCwds: () => [dir],
      platform: "darwin",
    });
    const custom = layanan.addCustom({ cwd: dir, label: "Uji", command: "bun test" });
    try {
      layanan.run({ cwd: dir, id: custom.id, confirm: true });
      throw new Error("harusnya ditolak");
    } catch (error) {
      expect(error).toBeInstanceOf(RunnerError);
      expect((error as RunnerError).code).toBe("nonaktif");
      expect((error as RunnerError).message).toBe(TERMINAL_DISABLED);
    }
  });
});

describe("fitur yang tak ada di Windows", () => {
  test("sandbox tak tersedia di win32", () => {
    expect(sandboxAvailable("win32")).toEqual({
      ok: false,
      detail: "Sandbox tidak tersedia di Windows.",
    });
  });

  test("folder picker native hanya di macOS", () => {
    expect(nativePickerAvailable("win32")).toBe(false);
    expect(nativePickerAvailable("linux")).toBe(false);
    expect(nativePickerAvailable("darwin")).toBe(true);
  });
});

describe("repo bayangan memakai perangkat null dari platform", () => {
  test("hooks path dan config global menunjuk ke perangkat null", async () => {
    const gitDir = join(dir, "shadow.git");
    const init = Bun.spawn(["git", "init", "-q", "--bare", gitDir], { stderr: "ignore" });
    expect(await init.exited).toBe(0);

    // Nilai diambil dari platform.nullDevice(), bukan literal "/dev/null";
    // cabang win32 memakai "NUL" dan tak bisa dijalankan di macOS.
    const hooks = await runShadowGit(
      { gitDir, workTree: dir },
      ["config", "--get", "core.hooksPath"],
    );
    expect(hooks.code).toBe(0);
    expect(hooks.stdout.trim()).toBe(nullDevice());

    // GIT_CONFIG_GLOBAL juga menunjuk ke perangkat null: config global kosong.
    const global = await runShadowGit({ gitDir, workTree: dir }, ["config", "--global", "--list"]);
    expect(global.code).toBe(0);
    expect(global.stdout.trim()).toBe("");
  });
});
