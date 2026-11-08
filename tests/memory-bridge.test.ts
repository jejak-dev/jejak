import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent/events";
import { createMemoryBridge, type MemoryBridge } from "../src/server/memory/memory-bridge";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import type { ProviderSelection, ResolvedProvider } from "../src/server/provider";
import { SessionManager } from "../src/server/sessions/session-manager";

let dir: string;
let store: FileMemoryStore;
let service: MemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-memory-bridge-"));
  store = new FileMemoryStore({ dir: join(dir, "memory") });
  service = new MemoryService({ store, cwd: dir });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function provider(selection: ProviderSelection): ResolvedProvider {
  return { profileId: selection.profileId ?? "lokal", apiKey: "sk-uji" };
}

function manager(runner: AgentRunner, memoryBridge?: MemoryBridge): SessionManager {
  const options = {
    runner,
    resolveProvider: async (selection: ProviderSelection) => provider(selection),
  };
  return new SessionManager(
    memoryBridge === undefined ? options : { ...options, memoryBridge },
  );
}

function captureRunner(events: AgentEvent[] = [{ type: "result", ok: true }]): {
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

function abortingRunner(inputs: RunInput[]): AgentRunner {
  return {
    async *run(input) {
      inputs.push(input);
      yield { type: "text", text: "menunggu" };
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted === true) {
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "result", ok: false, error: "dibatalkan" };
    },
  };
}

describe("createMemoryBridge", () => {
  test("token berbeda per giliran dan token lama dicabut", async () => {
    const { bridge, routes } = createMemoryBridge({ service, mcpUrl: "http://127.0.0.1:1/mcp" });
    expect(routes).toBeDefined();

    const first = await bridge.open({ sessionId: "s_1", cwd: dir });
    const second = await bridge.open({ sessionId: "s_1", cwd: dir });
    expect(first.memory.token).not.toBe(second.memory.token);
    expect(first.memory.url).toBe("http://127.0.0.1:1/mcp");
    expect(typeof first.memory.indexLine).toBe("string");
    expect(typeof first.memory.call).toBe("function");

    first.close();
    // Setelah dicabut, token tidak lagi valid: panggilan lewat rute 401.
    const call = async (token: string) =>
      routes.handle(
        new Request("http://127.0.0.1:1/mcp", {
          method: "POST",
          headers: {
            host: "127.0.0.1:1",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
      );
    expect((await call(first.memory.token!)).status).toBe(401);
    expect((await call(second.memory.token!)).status).toBe(200);

    second.close();
  });

  test("tanpa mcpUrl RunMemory tidak punya url", async () => {
    const { bridge } = createMemoryBridge({ service });
    const opened = await bridge.open({ sessionId: "s_2", cwd: dir });
    expect(opened.memory.url).toBeUndefined();
    expect(opened.memory.token).toBeTruthy();
    opened.close();
  });
});

describe("SessionManager + memoryBridge", () => {
  test("sesi berjalan memberi runner input.memory", async () => {
    const { bridge } = createMemoryBridge({ service, mcpUrl: "http://127.0.0.1:1/mcp" });
    const capture = captureRunner();
    const mgr = manager(capture.runner, bridge);

    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);

    expect(capture.inputs).toHaveLength(1);
    const memory = capture.inputs[0]?.memory;
    expect(memory).toBeDefined();
    expect(typeof memory?.indexLine).toBe("string");
    expect(typeof memory?.token).toBe("string");
  });

  test("tanpa bridge input.memory undefined", async () => {
    const capture = captureRunner();
    const mgr = manager(capture.runner);
    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);

    expect(capture.inputs[0]?.memory).toBeUndefined();
  });

  test("token dicabut setelah selesai, gagal, dan interrupt", async () => {
    const { bridge, routes } = createMemoryBridge({ service });
    const tokens: string[] = [];

    const ping = async (token: string): Promise<number> => {
      const res = await routes.handle(
        new Request("http://127.0.0.1:1/mcp", {
          method: "POST",
          headers: {
            host: "127.0.0.1:1",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
      );
      return res.status;
    };

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const startInputs: RunInput[] = [];
    const gatedRunner: AgentRunner = {
      async *run(input) {
        startInputs.push(input);
        started = true;
        await gate;
        yield { type: "result", ok: true };
      },
    };
    const ok = manager(gatedRunner, bridge);
    const okInfo = await ok.create({ prompt: "halo", cwd: dir });
    while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
    tokens.push(startInputs[0]?.memory?.token ?? "");
    expect(await ping(tokens[0]!)).toBe(200);
    release();
    await ok.done(okInfo.id);

    const failing = captureRunner([{ type: "result", ok: false, error: "meledak" }]);
    const fail = manager(failing.runner, bridge);
    const failInfo = await fail.create({ prompt: "halo", cwd: dir });
    await fail.done(failInfo.id);
    tokens.push(failing.inputs[0]?.memory?.token ?? "");

    const inputs: RunInput[] = [];
    const interrupted = manager(abortingRunner(inputs), bridge);
    const intInfo = await interrupted.create({ prompt: "tunggu", cwd: dir });
    while (inputs.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    tokens.push(inputs[0]?.memory?.token ?? "");
    interrupted.interrupt(intInfo.id);
    await interrupted.done(intInfo.id);

    expect(tokens.every((token) => token !== "")).toBe(true);
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens) {
      expect(await ping(token)).toBe(401);
    }
  });

  test("open yang melempar tidak menggagalkan sesi dan console.warn paling banyak sekali", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const broken: MemoryBridge = {
      open: async () => {
        throw new Error("indeks memory rusak");
      },
    };
    const capture = captureRunner();
    const mgr = manager(capture.runner, broken);

    const first = await mgr.create({ prompt: "satu", cwd: dir });
    await mgr.done(first.id);
    const second = await mgr.create({ prompt: "dua", cwd: dir });
    await mgr.done(second.id);

    expect(mgr.get(first.id)?.status).toBe("selesai");
    expect(mgr.get(second.id)?.status).toBe("selesai");
    expect(capture.inputs.every((input) => input.memory === undefined)).toBe(true);
    expect(warn.mock.calls.length).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("indeks memory rusak");
    warn.mockRestore();
  });
});
