import { describe, expect, test } from "bun:test";
import { spawnTransport, type AcpTransport } from "../src/server/acp/acp-client";
import { ACP_AGENTS, getAcpAgent, type AcpAgentDef } from "../src/server/acp/agent-defs";
import {
  probeAgent,
  probeAgentById,
  type ProbeDeps,
} from "../src/server/acp/agent-probe";

const DEF: AcpAgentDef = {
  id: "palsu",
  label: "Palsu",
  command: ["bun", "tests/fixtures/fake-acp-server.ts"],
  installHint: "pasang dulu",
  loginHint: "login dulu",
};

interface Catatan {
  spawn: number;
  kill: number;
}

function catatanBaru(): Catatan {
  return { spawn: 0, kill: 0 };
}

/** Bungkus transport sungguhan agar tes bisa memastikan `kill()` dipanggil. */
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

function depsUntuk(mode: string, catatan: Catatan, tambahan?: Partial<ProbeDeps>): ProbeDeps {
  return {
    which: () => "/usr/bin/bun",
    spawnTransport: pembungkus(catatan),
    env: { FAKE_ACP_MODE: mode },
    ...tambahan,
  };
}

describe("probeAgent dengan agent palsu", () => {
  test("which null: tidak-terpasang tanpa spawn", async () => {
    let dipanggil = 0;
    const status = await probeAgent(DEF, process.cwd(), {
      which: () => null,
      spawnTransport: () => {
        dipanggil += 1;
        throw new Error("spawn tidak boleh dipanggil");
      },
    });
    expect(status.state).toBe("tidak-terpasang");
    expect(status.hint).toBe(DEF.installHint);
    expect(dipanggil).toBe(0);
  });

  test("mode ok: siap tanpa model", async () => {
    const catatan = catatanBaru();
    const status = await probeAgent(DEF, process.cwd(), depsUntuk("ok", catatan));
    expect(status.state).toBe("siap");
    expect(status.models).toBeUndefined();
    expect(catatan.spawn).toBe(1);
    expect(catatan.kill).toBe(1);
  });

  test("mode models: siap dengan jumlah opsi model", async () => {
    const catatan = catatanBaru();
    const status = await probeAgent(DEF, process.cwd(), depsUntuk("models", catatan));
    expect(status.state).toBe("siap");
    expect(status.models).toBe(2);
    expect(catatan.kill).toBe(1);
  });

  test("mode auth: belum-login dengan authMethods dari initialize", async () => {
    const catatan = catatanBaru();
    const status = await probeAgent(DEF, process.cwd(), depsUntuk("auth", catatan));
    expect(status.state).toBe("belum-login");
    expect(status.hint).toBe(DEF.loginHint);
    expect(status.authMethods?.map((m) => m.id)).toContain("oauth-personal");
    expect(catatan.kill).toBe(1);
  });

  test("mode slow: galat batas waktu dan selesai cepat", async () => {
    const catatan = catatanBaru();
    const mulai = Date.now();
    const status = await probeAgent(
      DEF,
      process.cwd(),
      depsUntuk("slow", catatan, { timeoutMs: 200 }),
    );
    expect(Date.now() - mulai).toBeLessThan(2000);
    expect(status.state).toBe("galat");
    expect(status.detail).toContain("batas waktu");
    expect(catatan.kill).toBe(1);
  });

  test("mode exit: agent keluar saat session/new menjadi galat, bukan crash", async () => {
    const catatan = catatanBaru();
    const status = await probeAgent(DEF, process.cwd(), depsUntuk("exit", catatan));
    expect(status.state).toBe("galat");
    expect(status.detail).toContain("keluar");
    expect(catatan.kill).toBe(1);
  });

  test("perintah tak ada di disk: tidak-terpasang walau which lolos", async () => {
    const status = await probeAgent(
      { ...DEF, command: ["perintah-tidak-ada-xyz"] },
      process.cwd(),
      { which: () => "/palsu/perintah-tidak-ada-xyz", timeoutMs: 2000 },
    );
    expect(status.state).toBe("tidak-terpasang");
    expect(status.hint).toBe(DEF.installHint);
  });

  test("detail menyamarkan string mirip rahasia", async () => {
    const catatan = catatanBaru();
    const pesan = "gagal key=ABC123 dan token: XYZ";
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
        const id = record.id;
        const balasan = JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: pesan },
        });
        queueMicrotask(() => onData?.(`${balasan}\n`));
      },
      onData: (cb) => {
        onData = cb;
      },
      onExit: () => {},
      kill: () => {
        catatan.kill += 1;
      },
    };
    const status = await probeAgent(DEF, process.cwd(), {
      which: () => "/usr/bin/bun",
      spawnTransport: () => transport,
      timeoutMs: 2000,
    });
    expect(status.state).toBe("galat");
    expect(status.detail).not.toContain("ABC123");
    expect(status.detail).not.toContain("XYZ");
    expect(status.detail).toContain("disamarkan");
    expect(catatan.kill).toBe(1);
  });
});

describe("close selalu dipanggil (tidak ada proses yatim)", () => {
  test("tiap kasus yang spawn menutup transport tepat sekali", async () => {
    for (const mode of ["ok", "auth", "models", "exit", "slow"] as const) {
      const catatan = catatanBaru();
      const status = await probeAgent(
        DEF,
        process.cwd(),
        depsUntuk(mode, catatan, { timeoutMs: 200 }),
      );
      expect(status.state).not.toBe("tidak-terpasang");
      expect(catatan.spawn).toBe(1);
      expect(catatan.kill).toBe(1);
    }
  });
});

describe("agent-defs", () => {
  test("antigravity terdaftar dengan perintah agy acp", () => {
    const def = getAcpAgent("antigravity");
    expect(def).toEqual(ACP_AGENTS.antigravity);
    expect(def?.command).toEqual(["agy", "acp"]);
  });

  test("id bawaan prototipe tidak bocor", () => {
    expect(getAcpAgent("__proto__")).toBeUndefined();
    expect(getAcpAgent("constructor")).toBeUndefined();
  });

  test("probeAgentById: id tak dikenal mengembalikan undefined", async () => {
    expect(await probeAgentById("tidak-ada", process.cwd())).toBeUndefined();
  });
});
