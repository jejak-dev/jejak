import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChecks, type Check, type DoctorContext } from "../src/cli/doctor";
import { runShadowGit } from "../src/server/checkpoints/shadow-git";
import { nativePickerAvailable, pickFolderNative } from "../src/server/files/native-picker";
import { nullDevice } from "../src/server/platform";
import { terminalRoutes } from "../src/server/routes/terminal";
import {
  commandTerminator,
  RunnerError,
  RunnerService,
  type RunnerTerminal,
} from "../src/server/runner/runner-service";
import { FileRunnerStore } from "../src/server/runner/runner-store";
import { quoteScriptName } from "../src/server/runner/package-scripts";
import { sandboxAvailable } from "../src/server/sandbox/build-options";
import {
  resolveTerminalShell,
  TerminalManager,
  terminalKillPlan,
  terminalShellArgs,
} from "../src/server/terminal/terminal-manager";

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
  test("shell Windows diambil dari COMSPEC tanpa argumen", () => {
    const resolved = resolveTerminalShell({
      env: { COMSPEC: "C:\\Windows\\system32\\cmd.exe" },
      platform: "win32",
    });
    expect(resolved).toEqual({
      shell: "C:\\Windows\\system32\\cmd.exe",
      args: [],
    });
  });

  test("shell Windows jatuh ke cmd.exe bila COMSPEC tak ada", () => {
    expect(resolveTerminalShell({ env: {}, platform: "win32" })).toEqual({
      shell: "cmd.exe",
      args: [],
    });
  });

  test("shell POSIX tetap $SHELL absolut atau /bin/sh dengan argumen -l", () => {
    expect(resolveTerminalShell({ env: { SHELL: "/bin/zsh" }, platform: "darwin" })).toEqual({
      shell: "/bin/zsh",
      args: ["-l"],
    });
    expect(resolveTerminalShell({ env: {}, platform: "linux" })).toEqual({
      shell: "/bin/sh",
      args: ["-l"],
    });
    // $SHELL tak absolut tak dipercaya (bisa Resolution PATH).
    expect(resolveTerminalShell({ env: { SHELL: "zsh" }, platform: "darwin" }).shell).toBe("/bin/sh");
  });

  test("pilihan shell eksplisit menang di semua platform", () => {
    expect(resolveTerminalShell({ shell: "/custom/sh", env: { COMSPEC: "cmd.exe" }, platform: "win32" })).toEqual({
      shell: "/custom/sh",
      args: [],
    });
    expect(terminalShellArgs("win32")).toEqual([]);
    expect(terminalShellArgs("darwin")).toEqual(["-l"]);
  });

  test("kill Windows tanpa nama sinyal lalu taskkill, POSIX SIGHUP lalu SIGKILL", () => {
    expect(terminalKillPlan("win32")).toEqual({ fallback: "taskkill" });
    expect(terminalKillPlan("darwin")).toEqual({ signal: "SIGHUP", fallback: "SIGKILL" });
  });

  test("di POSIX galat cwd tetap muncul", () => {
    const manager = new TerminalManager({ platform: "darwin", env: {} });
    // Folder tak ada: galat soal cwd, bukan soal Windows.
    expect(() => manager.create({ cwd: join(dir, "tidak-ada") })).toThrow(
      /cwd tidak ditemukan atau bukan direktori/,
    );
  });

  test("rute terminal tanpa manajer menjawab 503 dengan pesan terminal dimatikan", async () => {
    const rute = terminalRoutes();
    const jawaban = await rute.handle(new Request("http://127.0.0.1:3000/api/terminal"));
    expect(jawaban.status).toBe(503);
    expect(await jawaban.json()).toEqual({ error: TERMINAL_DISABLED });
  });

  test("runner tanpa terminal memakai pesan terminal dimatikan di semua platform", () => {
    for (const platform of ["win32", "darwin"] as const) {
      const layanan = new RunnerService({
        store: new FileRunnerStore(":memory:"),
        allowedCwds: () => [dir],
        platform,
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
    }
  });
});

describe("perintah di shell Windows", () => {
  test("penanda akhir baris memakai CR di cmd.exe dan LF di POSIX", () => {
    expect(commandTerminator("win32")).toBe("\r");
    expect(commandTerminator("darwin")).toBe("\n");
  });

  test("perintah dikirim ke terminal dengan CR di Windows", () => {
    const ditulis: unknown[] = [];
    const palsu: RunnerTerminal = {
      create: () => ({ id: "t1", cwd: dir }),
      write: (_id: string, data: unknown) => {
        ditulis.push(data);
      },
    };
    const layanan = new RunnerService({
      store: new FileRunnerStore(":memory:"),
      terminal: palsu,
      allowedCwds: () => [dir],
      platform: "win32",
    });
    const custom = layanan.addCustom({ cwd: dir, label: "Uji", command: "bun test" });
    layanan.run({ cwd: dir, id: custom.id, confirm: true });
    expect(ditulis).toEqual(["bun test\r"]);
  });

  test("nama script di-quote gaya cmd.exe di Windows", () => {
    expect(quoteScriptName("biasa", "win32")).toBe("biasa");
    expect(quoteScriptName("dua kata", "win32")).toBe('"dua kata"');
    expect(quoteScriptName("dua kata", "darwin")).toBe("'dua kata'");
  });
});

describe("fitur yang tak ada di Windows", () => {
  test("sandbox tak tersedia di win32", () => {
    expect(sandboxAvailable("win32")).toEqual({
      ok: false,
      detail: "Sandbox tidak tersedia di Windows.",
    });
  });

  test("folder picker native hanya di macOS dan Windows", () => {
    expect(nativePickerAvailable("win32")).toBe(true);
    expect(nativePickerAvailable("linux")).toBe(false);
    expect(nativePickerAvailable("darwin")).toBe(true);
  });
});

describe("dialog folder native Windows", () => {
  test("memanggil PowerShell dengan folder awal lewat env, bukan skrip", async () => {
    let seen: { cmd: string[]; env?: Record<string, string> } | undefined;
    const hasil = await pickFolderNative("C:\\Development\\proyek", {
      platform: "win32",
      run: async (cmd, env) => {
        seen = { cmd, ...(env === undefined ? {} : { env }) };
        return { code: 0, stdout: "C:\\Development\\pilihan\r\n" };
      },
    });
    expect(hasil).toEqual({ path: "C:\\Development\\pilihan" });
    expect(seen?.cmd[0]).toBe("powershell.exe");
    expect(seen?.cmd.join(" ")).not.toContain("Development");
    expect(seen?.env).toEqual({ JEJAK_PICK_START: "C:\\Development\\proyek" });
  });

  test("dibatalkan (kode keluar bukan 0) mengembalikan objek kosong", async () => {
    const hasil = await pickFolderNative(undefined, {
      platform: "win32",
      run: async () => ({ code: 1, stdout: "" }),
    });
    expect(hasil).toEqual({});
  });
});

describe("dialog folder native macOS", () => {
  test("pembatalan (-128) tidak memicu dialog kedua", async () => {
    let skrip = "";
    const hasil = await pickFolderNative("/Users/x", {
      platform: "darwin",
      run: async (cmd) => {
        skrip = cmd.join("\n");
        return { code: 1, stdout: "" };
      },
    });
    expect(hasil).toEqual({});
    expect(skrip).toContain("on error errMsg number errNum");
    expect(skrip).toContain("if errNum is -128 then error number -128");
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
