import { afterEach, describe, expect, test } from "bun:test";
import { spawnTransport, type AcpTransport } from "../src/server/acp/acp-client";
import type { AcpAgentDef } from "../src/server/acp/agent-defs";
import { createAcpRunner, type AcpRunner, type AcpRunnerDeps } from "../src/server/acp/acp-runner";
import type { AgentEvent, PermissionDecision, RunInput } from "../src/server/agent/events";

const FIXTURE = "tests/fixtures/fake-acp-server.ts";

const DEF: AcpAgentDef = {
  id: "palsu",
  label: "Palsu",
  command: ["bun", FIXTURE],
  installHint: "pasang dulu",
  loginHint: "login dulu",
};

const runnerAktif: AcpRunner[] = [];

function buatRunner(deps?: AcpRunnerDeps): AcpRunner {
  const runner = createAcpRunner(DEF, deps);
  runnerAktif.push(runner);
  return runner;
}

afterEach(() => {
  for (const runner of runnerAktif.splice(0, runnerAktif.length)) runner.dispose();
});

function depsUntuk(mode: string, tambahan?: Partial<AcpRunnerDeps>): AcpRunnerDeps {
  return { env: { FAKE_ACP_MODE: mode }, ...tambahan };
}

function masukan(tambahan?: Partial<RunInput>): RunInput {
  return {
    prompt: "halo",
    cwd: process.cwd(),
    provider: { profileId: "uji" },
    ...tambahan,
  };
}

async function kumpulkan(runner: AcpRunner, input: RunInput): Promise<AgentEvent[]> {
  const hasil: AgentEvent[] = [];
  for await (const ev of runner.run(input)) hasil.push(ev);
  return hasil;
}

function hanya<T extends AgentEvent["type"]>(
  events: AgentEvent[],
  tipe: T,
): Extract<AgentEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === tipe);
}

/** Pid yang dibawa teks `giliran-<n>:<pid>`. */
function pidDari(events: AgentEvent[]): number {
  const teks = hanya(events, "text")
    .map((e) => e.text)
    .join("");
  const cocok = /giliran-\d+:(\d+)/.exec(teks);
  return cocok === null ? -1 : Number(cocok[1]);
}

interface Catatan {
  spawn: number;
  kill: number;
}

/** Bungkus transport agar tes bisa memastikan proses ditutup. */
function pembungkus(catatan: Catatan): typeof spawnTransport {
  return (command: string[], cwd: string, env?: Record<string, string>): AcpTransport => {
    catatan.spawn += 1;
    const asli = spawnTransport(command, cwd, env);
    return {
      write: (line: string) => asli.write(line),
      onData: (cb: (chunk: string) => void) => asli.onData(cb),
      onExit: (cb: (code: number | null) => void) => asli.onExit(cb),
      kill: () => {
        catatan.kill += 1;
        asli.kill();
      },
    };
  };
}

const IZINKAN: () => Promise<PermissionDecision> = async () => ({
  behavior: "allow",
});
const TOLAK: () => Promise<PermissionDecision> = async () => ({
  behavior: "deny",
  message: "tidak",
});

describe("AcpRunner mode rich", () => {
  test("urutan event lengkap dan allow_once dipilih (bukan allow_always)", async () => {
    const runner = buatRunner(depsUntuk("rich"));
    const events = await kumpulkan(runner, masukan({ requestPermission: IZINKAN }));

    const urutan = events.map((e) => e.type);
    expect(urutan).toEqual([
      "session",
      "thinking",
      "text_delta",
      "text_delta",
      "text",
      "tool_call",
      "tool_result",
      "context",
      "text_delta",
      "text",
      "result",
    ]);

    expect(hanya(events, "thinking")[0]?.text).toBe("pikir");
    expect(hanya(events, "text_delta").map((e) => e.text)).toEqual([
      "ha",
      "lo",
      "dipilih:ya-sekali",
    ]);
    expect(hanya(events, "text").map((e) => e.text)).toEqual(["halo", "dipilih:ya-sekali"]);

    const call = hanya(events, "tool_call")[0];
    expect(call).toMatchObject({ id: "t1", name: "Edit a.txt", input: { path: "a.txt" } });
    const result = hanya(events, "tool_result")[0];
    expect(result).toMatchObject({ id: "t1", output: "selesai", isError: false });
    expect(hanya(events, "context")[0]).toMatchObject({ tokens: 120, window: 1000 });
    expect(hanya(events, "result")[0]).toMatchObject({ ok: true, summary: "dipilih:ya-sekali" });
  });

  test("deny: agent menerima opsi reject_once", async () => {
    const runner = buatRunner(depsUntuk("rich"));
    const events = await kumpulkan(runner, masukan({ requestPermission: TOLAK }));
    expect(hanya(events, "text").map((e) => e.text)).toContain("dipilih:tidak");
  });

  test("tanpa handler izin: aksi ditolak (tidak)", async () => {
    const runner = buatRunner(depsUntuk("rich"));
    const events = await kumpulkan(runner, masukan());
    expect(hanya(events, "text").map((e) => e.text)).toContain("dipilih:tidak");
  });

  test("mode plan: handler tidak dipanggil, ditolak, ada notice", async () => {
    const runner = buatRunner(depsUntuk("rich"));
    let dipanggil = 0;
    const events = await kumpulkan(
      runner,
      masukan({
        permissionMode: "plan",
        requestPermission: async () => {
          dipanggil += 1;
          return { behavior: "allow" };
        },
      }),
    );
    expect(dipanggil).toBe(0);
    expect(hanya(events, "text").map((e) => e.text)).toContain("dipilih:tidak");
    expect(hanya(events, "notice").some((e) => e.text.includes("Mode rencana"))).toBe(true);
  });

  test("mode acceptEdits: kind edit diizinkan tanpa handler", async () => {
    const runner = buatRunner(depsUntuk("rich"));
    let dipanggil = 0;
    const events = await kumpulkan(
      runner,
      masukan({
        permissionMode: "acceptEdits",
        requestPermission: async () => {
          dipanggil += 1;
          return { behavior: "allow" };
        },
      }),
    );
    expect(dipanggil).toBe(0);
    expect(hanya(events, "text").map((e) => e.text)).toContain("dipilih:ya-sekali");
  });

  test("mode bypassPermissions: handler tetap dipanggil", async () => {
    const runner = buatRunner(depsUntuk("rich"));
    let dipanggil = 0;
    await kumpulkan(
      runner,
      masukan({
        permissionMode: "bypassPermissions",
        requestPermission: async () => {
          dipanggil += 1;
          return { behavior: "allow" };
        },
      }),
    );
    expect(dipanggil).toBe(1);
  });
});

describe("AcpRunner sesi", () => {
  test("resume memakai proses yang sama; tanpa resume memakai proses baru", async () => {
    const catatan: Catatan = { spawn: 0, kill: 0 };
    const runner = buatRunner(depsUntuk("multi", { spawnTransport: pembungkus(catatan) }));

    const giliran1 = await kumpulkan(runner, masukan());
    const sesi = hanya(giliran1, "session")[0]?.sessionId;
    expect(sesi).toBeDefined();
    const pid1 = pidDari(giliran1);
    expect(pid1).toBeGreaterThan(0);

    const giliran2 = await kumpulkan(
      runner,
      masukan({ resumeSessionId: sesi, prompt: "lagi" }),
    );
    expect(hanya(giliran2, "text").map((e) => e.text).join("")).toContain("giliran-2");
    expect(pidDari(giliran2)).toBe(pid1);
    expect(catatan.spawn).toBe(1);

    const giliran3 = await kumpulkan(runner, masukan({ prompt: "baru" }));
    expect(pidDari(giliran3)).not.toBe(pid1);
    expect(catatan.spawn).toBe(2);
  });

  test("release lalu giliran dengan id lama: proses baru + notice warn", async () => {
    const catatan: Catatan = { spawn: 0, kill: 0 };
    const runner = buatRunner(depsUntuk("multi", { spawnTransport: pembungkus(catatan) }));
    const giliran1 = await kumpulkan(runner, masukan());
    const sesi = hanya(giliran1, "session")[0]?.sessionId ?? "";
    runner.release(sesi);

    const giliran2 = await kumpulkan(runner, masukan({ resumeSessionId: sesi, prompt: "lagi" }));
    expect(catatan.spawn).toBe(2);
    const notice = hanya(giliran2, "notice").find((e) => e.level === "warn");
    expect(notice?.text).toContain("konteks percakapan dimulai ulang");
    expect(hanya(giliran2, "text").map((e) => e.text).join("")).toContain("giliran-1");
  });

  test("idleMs menutup proses setelah jeda", async () => {
    const catatan: Catatan = { spawn: 0, kill: 0 };
    const runner = buatRunner(
      depsUntuk("multi", { spawnTransport: pembungkus(catatan), idleMs: 150 }),
    );
    await kumpulkan(runner, masukan());
    await Bun.sleep(400);
    expect(catatan.kill).toBe(1);
  });
});

describe("AcpRunner galat dan batal", () => {
  test("mode auth: error memuat loginHint dan proses ditutup", async () => {
    const catatan: Catatan = { spawn: 0, kill: 0 };
    const runner = buatRunner(depsUntuk("auth", { spawnTransport: pembungkus(catatan) }));
    const events = await kumpulkan(runner, masukan());
    expect(hanya(events, "result")).toHaveLength(0);
    expect(hanya(events, "error")[0]?.message).toContain(DEF.loginHint);
    expect(catatan.kill).toBe(1);
  });

  test("perintah tak ada: error memuat installHint", async () => {
    const runner = buatRunner(depsUntuk("ok"));
    const defTakAda: AcpAgentDef = { ...DEF, command: ["perintah-tidak-ada-xyz"] };
    const lain = createAcpRunner(defTakAda, depsUntuk("ok"));
    runnerAktif.push(lain);
    const events = await kumpulkan(lain, masukan());
    expect(hanya(events, "error")[0]?.message).toContain(DEF.installHint);
    expect(events.some((e) => e.type === "result")).toBe(false);
    void runner;
  });

  test("hang + abort: result dibatalkan, cepat, proses ditutup", async () => {
    const catatan: Catatan = { spawn: 0, kill: 0 };
    const runner = buatRunner(depsUntuk("hang", { spawnTransport: pembungkus(catatan) }));
    const kontrol = new AbortController();
    setTimeout(() => kontrol.abort(), 100);
    const mulai = Date.now();
    const events = await kumpulkan(runner, masukan({ signal: kontrol.signal }));
    expect(Date.now() - mulai).toBeLessThan(5_000);
    const result = hanya(events, "result");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ok: false, error: "dibatalkan" });
    expect(events[events.length - 1]?.type).toBe("result");
    expect(catatan.kill).toBe(1);
  });

  test("signal sudah abort sebelum run: dibatalkan tanpa spawn", async () => {
    let dipanggil = 0;
    const runner = buatRunner(
      depsUntuk("ok", {
        spawnTransport: () => {
          dipanggil += 1;
          throw new Error("spawn tidak boleh dipanggil");
        },
      }),
    );
    const kontrol = new AbortController();
    kontrol.abort();
    const events = await kumpulkan(runner, masukan({ signal: kontrol.signal }));
    expect(events).toEqual([{ type: "result", ok: false, error: "dibatalkan" }]);
    expect(dipanggil).toBe(0);
  });

  test("galat disamarkan: key=ABC123 tidak bocor", async () => {
    let onData: ((chunk: string) => void) | undefined;
    const transport: AcpTransport = {
      write: (line: string): void => {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof msg !== "object" || msg === null) return;
        const record = msg as Record<string, unknown>;
        if (record.method !== "initialize" || typeof record.id !== "number") return;
        const balasan = JSON.stringify({
          jsonrpc: "2.0",
          id: record.id,
          error: { code: -32603, message: "gagal key=ABC123" },
        });
        queueMicrotask(() => onData?.(`${balasan}\n`));
      },
      onData: (cb) => {
        onData = cb;
      },
      onExit: () => {},
      kill: () => {},
    };
    const runner = buatRunner(
      depsUntuk("ok", { spawnTransport: () => transport, requestTimeoutMs: 2000 }),
    );
    const events = await kumpulkan(runner, masukan());
    const pesan = hanya(events, "error")[0]?.message ?? "";
    expect(pesan).not.toContain("ABC123");
    expect(pesan).toContain("disamarkan");
  });
});
