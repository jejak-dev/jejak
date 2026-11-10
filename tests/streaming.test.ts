import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner } from "../src/server/agent";
import type { ResolvedProvider } from "../src/server/provider";
import { SessionManager } from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "sk-uji-1", model: "model-uji" };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-stream-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runnerOf(events: AgentEvent[]): AgentRunner {
  return {
    async *run() {
      for (const event of events) yield event;
    },
  };
}

describe("teks mengalir", () => {
  test("text_delta disiarkan lalu dibuang setelah teks final; tidak dihitung", async () => {
    const mgr = new SessionManager({
      runner: runnerOf([
        { type: "text_delta", text: "ha" },
        { type: "text_delta", text: "lo" },
        { type: "text", text: "halo" },
        { type: "result", ok: true },
      ]),
      resolveProvider: async () => PROVIDER,
    });
    const info = await mgr.create({ prompt: "p", cwd: dir });
    await mgr.done(info.id);

    const types: string[] = [];
    for await (const item of mgr.events(info.id)) types.push(item.event.type);
    expect(types).not.toContain("text_delta");
    expect(types.filter((t) => t === "text")).toHaveLength(1);
    expect(types.at(-1)).toBe("result");
    // delta tidak menambah hitungan event tersimpan
    expect(mgr.get(info.id)?.eventCount).toBe(types.length);
  });

  test("pelanggan langsung menerima delta selagi sesi berjalan", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mgr = new SessionManager({
      runner: {
        async *run() {
          yield { type: "text_delta", text: "sedang" } satisfies AgentEvent;
          await gate;
          yield { type: "text", text: "sedang mengalir" } satisfies AgentEvent;
          yield { type: "result", ok: true } satisfies AgentEvent;
        },
      },
      resolveProvider: async () => PROVIDER,
    });
    const info = await mgr.create({ prompt: "p", cwd: dir });

    const seen: string[] = [];
    const reader = (async () => {
      for await (const item of mgr.events(info.id)) {
        seen.push(item.event.type);
        if (item.event.type === "text_delta") release();
      }
    })();
    await mgr.done(info.id);
    await reader;
    expect(seen).toContain("text_delta");
    expect(seen).toContain("text");
  });
});
