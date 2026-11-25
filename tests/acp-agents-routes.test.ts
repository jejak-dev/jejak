import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import type { AcpAgentStatus } from "../src/server/acp/agent-probe";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-acp-agents-api-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(
  opts: {
    env?: Record<string, string | undefined>;
    which?: (cmd: string) => string | null;
    probe?: (id: string) => Promise<AcpAgentStatus | undefined>;
  } = {},
) {
  const audit = new SqliteAuditStore(":memory:");
  const app = createApp({
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home"), ...opts.env },
    audit,
    ...(opts.probe === undefined ? {} : { acpProbe: opts.probe }),
    ...(opts.which === undefined ? {} : { acpWhich: opts.which }),
  });
  const req = (method: string, path: string) => {
    const headers: Record<string, string> = { host: "127.0.0.1:3000" };
    const init: RequestInit = { method, headers };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      init.body = "{}";
    }
    return app.handle(new Request(`http://127.0.0.1:3000${path}`, init));
  };
  return { req, audit };
}

interface AgentListBody {
  agents: Array<{
    id: string;
    label: string;
    installed: boolean;
    installHint: string;
    loginHint: string;
  }>;
}

describe("rute agent ACP", () => {
  test("GET memuat antigravity dan tidak memanggil probe", async () => {
    let dipanggil = 0;
    const { req, audit } = setup({
      probe: async () => {
        dipanggil += 1;
        return undefined;
      },
    });
    const jawaban = await req("GET", "/api/acp/agents");
    expect(jawaban.status).toBe(200);
    const isi = (await jawaban.json()) as AgentListBody;
    const antigravity = isi.agents.find((agent) => agent.id === "antigravity");
    expect(antigravity).toBeDefined();
    expect(antigravity?.label).toBe("Antigravity");
    expect(dipanggil).toBe(0);
    audit.close();
  });

  test("installed mengikuti which yang disuntikkan (dua kasus)", async () => {
    const ada = setup({ which: () => "/usr/local/bin/agy" });
    const terpasang = (await (await ada.req("GET", "/api/acp/agents")).json()) as AgentListBody;
    expect(terpasang.agents.find((a) => a.id === "antigravity")?.installed).toBe(true);
    ada.audit.close();

    const tidakAda = setup({ which: () => null });
    const absen = (await (await tidakAda.req("GET", "/api/acp/agents")).json()) as AgentListBody;
    expect(absen.agents.find((a) => a.id === "antigravity")?.installed).toBe(false);
    tidakAda.audit.close();
  });

  test("POST memakai probe palsu dan mengembalikan statusnya", async () => {
    const { req, audit } = setup({
      probe: async (id) => ({ id, label: "Antigravity", state: "siap", models: 3 }),
    });
    const jawaban = await req("POST", "/api/acp/agents/antigravity/probe");
    expect(jawaban.status).toBe(200);
    expect(await jawaban.json()).toEqual({
      id: "antigravity",
      label: "Antigravity",
      state: "siap",
      models: 3,
    });
    audit.close();
  });

  test("id tak dikenal 404, termasuk nama prototipe", async () => {
    const { req, audit } = setup({
      probe: async () => {
        throw new Error("tidak boleh dipanggil");
      },
    });
    for (const id of ["tidak-ada", "__proto__", "constructor"]) {
      const jawaban = await req("POST", `/api/acp/agents/${id}/probe`);
      expect(jawaban.status).toBe(404);
      const isi = (await jawaban.json()) as { error: string };
      expect(isi.error).toContain("tidak dikenal");
    }
    audit.close();
  });

  test("dua POST bersamaan berbagi satu probe; POST berikutnya memanggil lagi", async () => {
    let dipanggil = 0;
    let selesai: (status: AcpAgentStatus) => void = () => {};
    const tunda = new Promise<AcpAgentStatus>((resolve) => {
      selesai = resolve;
    });
    const { req, audit } = setup({
      probe: async (id) => {
        dipanggil += 1;
        return tunda.then((status) => ({ ...status, id }));
      },
    });

    const satu = req("POST", "/api/acp/agents/antigravity/probe");
    const dua = req("POST", "/api/acp/agents/antigravity/probe");
    // Beri kesempatan kedua permintaan mencapai probe sebelum dilepas.
    await Bun.sleep(5);
    expect(dipanggil).toBe(1);
    selesai({ id: "antigravity", label: "Antigravity", state: "siap" });
    const [jawabanSatu, jawabanDua] = await Promise.all([satu, dua]);
    expect(jawabanSatu.status).toBe(200);
    expect(jawabanDua.status).toBe(200);
    expect(dipanggil).toBe(1);

    const lagi = await req("POST", "/api/acp/agents/antigravity/probe");
    expect(lagi.status).toBe(200);
    expect(dipanggil).toBe(2);
    audit.close();
  });

  test("audit tercatat tanpa detail galat", async () => {
    const { req, audit } = setup({
      probe: async (id) => ({
        id,
        label: "Antigravity",
        state: "galat",
        detail: "kunci=rahasia",
      }),
    });
    await req("POST", "/api/acp/agents/antigravity/probe");
    const entri = audit.list({ kind: "pengaturan", limit: 20 });
    const catatan = entri.find((e) => e.meta.aksi === "acp-probe");
    expect(catatan).toBeDefined();
    expect(catatan?.meta.agent).toBe("antigravity");
    expect(catatan?.meta.state).toBe("galat");
    expect(JSON.stringify(catatan)).not.toContain("rahasia");
    audit.close();
  });

  test("mode MOCK tanpa probe suntikan tidak menjalankan agent", async () => {
    // Probe bawaan mode MOCK selalu menjawab "tidak-terpasang" tanpa spawn,
    // jadi statusnya tak bergantung pada ada-tidaknya perintah di PATH.
    const { req, audit } = setup({ env: { MOCK: "true" }, which: () => "/bin/agy" });
    const jawaban = await req("POST", "/api/acp/agents/antigravity/probe");
    expect(jawaban.status).toBe(200);
    const isi = (await jawaban.json()) as AcpAgentStatus;
    expect(isi.state).toBe("tidak-terpasang");
    audit.close();
  });
});
