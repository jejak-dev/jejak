import { afterEach, describe, expect, test } from "bun:test";
import {
  AcpClient,
  AcpError,
  spawnTransport,
  type AcpTransport,
  type AcpUpdate,
  type PermissionRequest,
} from "../src/server/acp/acp-client";

const FIXTURE = "tests/fixtures/fake-acp-server.ts";

/** Proses anak yang dibuka tes; ditutup di afterEach agar tak ada yatim. */
const terbuka: AcpClient[] = [];

function buat(mode: string, opts?: ConstructorParameters<typeof AcpClient>[1]): AcpClient {
  const transport = spawnTransport(["bun", FIXTURE], process.cwd(), { FAKE_ACP_MODE: mode });
  const client = new AcpClient(transport, opts);
  terbuka.push(client);
  return client;
}

afterEach(() => {
  for (const client of terbuka.splice(0, terbuka.length)) client.close();
});

describe("AcpClient dengan agent palsu", () => {
  test("alur ok: initialize, newSession, prompt, update, dan izin sampai ke agent", async () => {
    const update: AcpUpdate[] = [];
    const diminta: PermissionRequest[] = [];
    const client = buat("ok", {
      onUpdate: (u) => update.push(u),
      onPermission: async (params) => {
        diminta.push(params);
        return { optionId: "allow-once" };
      },
    });

    const init = await client.initialize();
    expect(init.protocolVersion).toBe(1);
    expect(init.authMethods).toEqual([{ id: "oauth-personal", name: "Google" }]);
    expect(typeof init.agentCapabilities).toBe("object");

    const sesi = await client.newSession(process.cwd());
    expect(sesi.sessionId).toBe("s1");

    const hasil = await client.prompt(sesi.sessionId, "halo");
    expect(hasil.stopReason).toBe("end_turn:allow-once");
    expect(update.some((u) => u.kind === "agent_message_chunk")).toBe(true);
    expect(update[0]?.sessionId).toBe("s1");
    expect(diminta).toHaveLength(1);
    expect(diminta[0]?.options.map((o) => o.optionId)).toEqual(["allow-once", "reject-once"]);
  });

  test("tanpa onPermission agent menerima outcome cancelled", async () => {
    const client = buat("ok");
    await client.initialize();
    const sesi = await client.newSession(process.cwd());
    const hasil = await client.prompt(sesi.sessionId, "halo");
    expect(hasil.stopReason).toBe("cancelled");
  });

  test("mode auth: AcpError -32000 dengan needsAuth", async () => {
    const client = buat("auth");
    await client.initialize();
    let galat: unknown;
    try {
      await client.newSession(process.cwd());
    } catch (error) {
      galat = error;
    }
    expect(galat).toBeInstanceOf(AcpError);
    const acpError = galat as AcpError;
    expect(acpError.code).toBe(-32000);
    expect(acpError.needsAuth).toBe(true);
  });

  test("mode noisy: log non-JSON tidak menghalangi initialize", async () => {
    const client = buat("noisy");
    const init = await client.initialize();
    expect(init.authMethods[0]?.id).toBe("oauth-personal");
  });

  test("mode slow: batas waktu menolak request dengan pesan jelas", async () => {
    const client = buat("slow", { requestTimeoutMs: 200 });
    await client.initialize();
    const mulai = Date.now();
    let galat: unknown;
    try {
      await client.newSession(process.cwd());
    } catch (error) {
      galat = error;
    }
    expect(Date.now() - mulai).toBeLessThan(2000);
    expect(galat).toBeInstanceOf(Error);
    expect((galat as Error).message).toContain("batas waktu");
  });

  test("mode exit: request tertunda ditolak dan onExit menerima kode 3", async () => {
    let kodeKeluar: number | null | undefined;
    const client = buat("exit", {
      onExit: (code) => {
        kodeKeluar = code;
      },
    });
    await client.initialize();
    let galat: unknown;
    try {
      await client.newSession(process.cwd());
    } catch (error) {
      galat = error;
    }
    expect(galat).toBeInstanceOf(Error);
    expect((galat as Error).message).toContain("3");
    expect(kodeKeluar).toBe(3);
  });

  test("mode unknown-method: agent menerima error -32601", async () => {
    const client = buat("unknown-method");
    await client.initialize();
    const sesi = await client.newSession(process.cwd());
    const hasil = await client.prompt(sesi.sessionId, "halo");
    expect(hasil.stopReason).toBe("end_turn:-32601");
  });
});

describe("AcpClient.close", () => {
  test("dipanggil dua kali tidak melempar dan menolak request tertunda", async () => {
    const client = buat("slow", { requestTimeoutMs: 30_000 });
    await client.initialize();
    const tertunda = client.newSession(process.cwd());
    client.close();
    expect(() => client.close()).not.toThrow();
    let galat: unknown;
    try {
      await tertunda;
    } catch (error) {
      galat = error;
    }
    expect(galat).toBeInstanceOf(Error);
  });
});

describe("spawnTransport", () => {
  test("perintah tidak ada memanggil onExit non-nol tanpa crash", async () => {
    const transport = spawnTransport(["jejak-perintah-yang-tidak-ada-xyz"], process.cwd());
    const kode = await new Promise<number | null>((resolve) => transport.onExit(resolve));
    expect(kode).not.toBeNull();
    expect(kode).not.toBe(0);
    expect(() => transport.kill()).not.toThrow();
  });

  test("perintah kosong melempar Error", () => {
    expect(() => spawnTransport([], process.cwd())).toThrow();
  });
});

/** Transport di memori: tanpa proses, untuk memeriksa bentuk pesan. */
function transportPalsu(): {
  transport: AcpTransport;
  ditulis: string[];
  kirim: (chunk: string) => void;
} {
  const ditulis: string[] = [];
  const dataHandlers: Array<(chunk: string) => void> = [];
  return {
    ditulis,
    kirim: (chunk) => {
      for (const handler of dataHandlers) handler(chunk);
    },
    transport: {
      write: (line) => {
        ditulis.push(line);
      },
      onData: (cb) => {
        dataHandlers.push(cb);
      },
      onExit: () => {},
      kill: () => {},
    },
  };
}

describe("AcpClient dengan transport palsu", () => {
  test("cancel menulis tepat satu baris JSON tanpa field id", () => {
    const { transport, ditulis } = transportPalsu();
    const client = new AcpClient(transport);
    client.cancel("s1");
    expect(ditulis).toHaveLength(1);
    const pesan = JSON.parse(ditulis[0] ?? "") as Record<string, unknown>;
    expect(pesan.method).toBe("session/cancel");
    expect(pesan.params).toEqual({ sessionId: "s1" });
    expect("id" in pesan).toBe(false);
    client.close();
  });

  test("galat di onUpdate tidak menghentikan pembacaan pesan berikutnya", async () => {
    const { transport, kirim } = transportPalsu();
    const client = new AcpClient(transport, {
      onUpdate: () => {
        throw new Error("callback rusak");
      },
    });
    const hasil = client.prompt("s1", "halo");
    kirim(
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk"}}}\n',
    );
    kirim('{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}\n');
    expect(await hasil).toEqual({ stopReason: "end_turn" });
    client.close();
  });
});
