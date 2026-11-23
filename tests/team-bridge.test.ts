import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryBridge, type MemoryBridge } from "../src/server/memory/memory-bridge";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import {
  TeamPortHolder,
  type TeamChildView,
  type TeamPort,
} from "../src/server/team/team-tools";

let dir: string;
let store: FileMemoryStore;
let service: MemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-team-bridge-"));
  store = new FileMemoryStore({ dir: join(dir, "memory") });
  service = new MemoryService({ store, cwd: dir });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

/** Port yang hanya mengizinkan sesi bernama `induk`. */
function fakePort(allowed: string): TeamPort {
  return {
    canSpawn: (sessionId) => sessionId === allowed,
    spawn: async () => ({ id: "s_anak", title: "t", status: "berjalan" }),
    list: (): TeamChildView[] => [],
    status: () => undefined,
    result: () => undefined,
    message: async () => undefined,
    stop: () => undefined,
  };
}

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) payload.params = params;
  return payload;
}

function post(
  routes: { handle: (request: Request) => Promise<Response> },
  token: string,
  body: unknown,
): Promise<Response> {
  return routes.handle(
    new Request("http://127.0.0.1:3000/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

const TEAM_TOOLS = [
  "team_spawn",
  "team_list",
  "team_status",
  "team_result",
  "team_message",
  "team_stop",
];

const TEAM_INDEX_MARK = "membagi pekerjaan ke sesi anak paralel";

describe("createMemoryBridge + team", () => {
  test("tool tim muncul di memory.tools dan tools/list hanya untuk induk", async () => {
    const { bridge, routes } = createMemoryBridge({
      service,
      team: { port: fakePort("s_induk") },
    });

    const induk = await bridge.open({ sessionId: "s_induk", cwd: dir });
    const anak = await bridge.open({ sessionId: "s_anak", cwd: dir });
    try {
      for (const nama of TEAM_TOOLS) {
        expect(induk.memory.tools).toContain(nama);
      }
      expect(anak.memory.tools ?? []).not.toContain("team_spawn");

      const listInduk = (await (
        await post(routes, induk.memory.token!, rpc(1, "tools/list"))
      ).json()) as { result: { tools: Array<{ name: string }> } };
      expect(listInduk.result.tools.map((tool) => tool.name)).toContain("team_spawn");

      const listAnak = (await (
        await post(routes, anak.memory.token!, rpc(1, "tools/list"))
      ).json()) as { result: { tools: Array<{ name: string }> } };
      expect(listAnak.result.tools.map((tool) => tool.name)).not.toContain("team_spawn");
    } finally {
      induk.close();
      anak.close();
    }
  });

  test("indexLine memuat baris tim hanya untuk induk", async () => {
    const { bridge } = createMemoryBridge({
      service,
      team: { port: fakePort("s_induk") },
    });
    const induk = await bridge.open({ sessionId: "s_induk", cwd: dir });
    const anak = await bridge.open({ sessionId: "s_anak", cwd: dir });
    try {
      expect(induk.memory.indexLine).toContain(TEAM_INDEX_MARK);
      expect(anak.memory.indexLine).not.toContain(TEAM_INDEX_MARK);
    } finally {
      induk.close();
      anak.close();
    }
  });

  test("tools/call lewat token sesi anak ditolak", async () => {
    const { bridge, routes } = createMemoryBridge({
      service,
      team: { port: fakePort("s_induk") },
    });
    const anak = await bridge.open({ sessionId: "s_anak", cwd: dir });
    try {
      const res = await post(
        routes,
        anak.memory.token!,
        rpc(2, "tools/call", { name: "team_list", arguments: {} }),
      );
      const body = (await res.json()) as {
        result: { content: Array<{ text: string }>; isError: boolean };
      };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]?.text).toBe("Tool tidak tersedia.");
    } finally {
      anak.close();
    }
  });

  test("tanpa opsi team tak ada tool maupun baris tim", async () => {
    const { bridge } = createMemoryBridge({ service });
    const opened = await bridge.open({ sessionId: "s_induk", cwd: dir });
    try {
      expect(opened.memory.tools ?? []).not.toContain("team_spawn");
      expect(opened.memory.indexLine).not.toContain(TEAM_INDEX_MARK);
    } finally {
      opened.close();
    }
  });

  test("holder yang belum ditautkan: tool tak tampil, call ditolak", async () => {
    const holder = new TeamPortHolder();
    const { bridge } = createMemoryBridge({ service, team: { port: holder } });
    const opened = await bridge.open({ sessionId: "s_induk", cwd: dir });
    try {
      expect(opened.memory.tools ?? []).not.toContain("team_spawn");
      expect(opened.memory.indexLine).not.toContain(TEAM_INDEX_MARK);
      const hasil = await opened.memory.call("team_list", {});
      expect(hasil.isError).toBe(true);
      expect(hasil.text).toBe("Tool tidak tersedia.");
    } finally {
      opened.close();
    }

    holder.attach(fakePort("s_induk"));
    const lagi = await bridge.open({ sessionId: "s_induk", cwd: dir });
    try {
      expect(lagi.memory.tools).toContain("team_spawn");
      expect(lagi.memory.indexLine).toContain(TEAM_INDEX_MARK);
    } finally {
      lagi.close();
    }
  });

  test("bridge sebagai MemoryBridge tetap bisa dipakai manajer", async () => {
    const { bridge } = createMemoryBridge({ service, team: { port: fakePort("s_induk") } });
    const spy: MemoryBridge = bridge;
    expect(typeof spy.open).toBe("function");
  });
});
