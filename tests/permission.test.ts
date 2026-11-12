import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import type { AgentEvent, AgentRunner, PermissionDecision, RunInput } from "../src/server/agent";
import { createSdkRunner, type SdkModule } from "../src/server/agent/sdk-runner";
import type { ResolvedProvider } from "../src/server/provider";
import { createApiClient } from "../src/client/lib/api";
import {
  SessionError,
  SessionManager,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";

const KEY = "sk-rahasia-123";
const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: KEY, model: "model-uji" };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-permission-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function manager(runner: AgentRunner, extra: Partial<SessionManagerOptions> = {}): SessionManager {
  return new SessionManager({ runner, resolveProvider: async () => PROVIDER, ...extra });
}

/** Runner palsu: minta izin satu kali, lalu laporkan keputusannya sebagai teks. */
function askingRunner(input: unknown = { file_path: "a.txt" }): AgentRunner {
  return {
    async *run(runInput: RunInput) {
      const decision = await runInput.requestPermission?.(
        { toolUseId: "tu1", name: "Write", input },
        runInput.signal ?? new AbortController().signal,
      );
      yield { type: "text", text: `keputusan:${decision?.behavior}:${(decision as { message?: string })?.message ?? ""}` };
      yield { type: "result", ok: true };
    },
  };
}

async function waitFor(check: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("waitFor melewati batas waktu");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function eventsOf(mgr: SessionManager, id: string): Promise<AgentEvent[]> {
  await mgr.done(id);
  return (await collect(mgr.events(id))).map((item) => item.event);
}

function requestIdOf(mgr: SessionManager, id: string): Promise<string> {
  return (async () => {
    let found = "";
    await waitFor(() => mgr.get(id)?.pendingPermissions === 1);
    for await (const item of mgr.events(id, { signal: AbortSignal.timeout(50) })) {
      if (item.event.type === "permission_request") {
        found = item.event.id;
        break;
      }
    }
    return found;
  })();
}

describe("sdk-runner: canUseTool", () => {
  function sdkWith(capture: (options: Record<string, unknown> | undefined) => void): SdkModule {
    return {
      query(args) {
        capture(args.options);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", is_error: false, result: "ok" };
          },
        };
      },
    };
  }

  type CanUseTool = (
    name: string,
    input: unknown,
    ctx?: { signal?: AbortSignal; toolUseID?: string },
  ) => Promise<Record<string, unknown>>;

  async function run(handler: RunInput["requestPermission"]): Promise<CanUseTool | undefined> {
    let captured: Record<string, unknown> | undefined;
    const runner = createSdkRunner({ load: async () => sdkWith((o) => (captured = o)), baseEnv: {} });
    await collect(
      runner.run({
        prompt: "x",
        cwd: "/tmp",
        provider: PROVIDER,
        ...(handler === undefined ? {} : { requestPermission: handler }),
      }),
    );
    return captured?.canUseTool as CanUseTool | undefined;
  }

  test("sdk-runner meneruskan updatedInput dari keputusan", async () => {
    const canUseTool = await run(async () => ({ behavior: "allow", updatedInput: { a: 1 } }));
    expect(await canUseTool?.("AskUserQuestion", { q: 1 })).toEqual({
      behavior: "allow",
      updatedInput: { a: 1 },
    });
  });

  test("tanpa handler, canUseTool tidak dipasang", async () => {
    expect(await run(undefined)).toBeUndefined();
  });

  test("allow memetakan ke behavior allow dengan updatedInput asli", async () => {
    const seen: unknown[] = [];
    const canUseTool = await run(async (request) => {
      seen.push(request);
      return { behavior: "allow" };
    });
    const input = { file_path: "a.txt" };
    const result = await canUseTool?.("Write", input, { toolUseID: "tu9" });
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
    expect(seen).toEqual([{ toolUseId: "tu9", name: "Write", input }]);
  });

  test("deny meneruskan pesan", async () => {
    const canUseTool = await run(async () => ({ behavior: "deny", message: "tidak boleh" }));
    expect(await canUseTool?.("Bash", {})).toEqual({ behavior: "deny", message: "tidak boleh" });
  });

  test("handler melempar menjadi deny tanpa membocorkan galat", async () => {
    const canUseTool = await run(async () => {
      throw new Error("rahasia internal");
    });
    expect(await canUseTool?.("Bash", {})).toEqual({
      behavior: "deny",
      message: "izin gagal diproses",
    });
  });
});

describe("session-manager: izin", () => {
  test("permintaan menahan run sampai diputuskan (allow)", async () => {
    const mgr = manager(askingRunner());
    const info = await mgr.create({ prompt: "p", cwd: dir });
    const requestId = await requestIdOf(mgr, info.id);
    expect(mgr.get(info.id)?.pendingPermissions).toBe(1);
    expect(mgr.get(info.id)?.status).toBe("berjalan");

    mgr.resolvePermission(info.id, requestId, "allow");
    const events = await eventsOf(mgr, info.id);

    expect(mgr.get(info.id)?.pendingPermissions).toBe(0);
    expect(events.find((e) => e.type === "permission_resolved")).toEqual({
      type: "permission_resolved",
      id: requestId,
      decision: "allow",
    });
    expect(events).toContainEqual({ type: "text", text: "keputusan:allow:" });
  });

  test("deny memakai pesan bawaan dan memotong pesan panjang", async () => {
    const mgr = manager(askingRunner());
    const a = await mgr.create({ prompt: "p", cwd: dir });
    mgr.resolvePermission(a.id, await requestIdOf(mgr, a.id), "deny");
    expect(await eventsOf(mgr, a.id)).toContainEqual({
      type: "text",
      text: "keputusan:deny:ditolak pengguna",
    });

    const b = await mgr.create({ prompt: "p", cwd: dir });
    mgr.resolvePermission(b.id, await requestIdOf(mgr, b.id), "deny", `${"x ".repeat(300)}`);
    const resolved = (await eventsOf(mgr, b.id)).find((e) => e.type === "permission_resolved");
    expect(resolved?.type === "permission_resolved" && (resolved.message?.length ?? 0)).toBeLessThanOrEqual(200);
  });

  test("id tak dikenal dan resolve ganda memunculkan SessionError", async () => {
    const mgr = manager(askingRunner());
    const info = await mgr.create({ prompt: "p", cwd: dir });
    const requestId = await requestIdOf(mgr, info.id);

    expect(() => mgr.resolvePermission("nihil", requestId, "allow")).toThrow(SessionError);
    expect(() => mgr.resolvePermission(info.id, "nihil", "allow")).toThrow(SessionError);
    mgr.resolvePermission(info.id, requestId, "allow");
    expect(() => mgr.resolvePermission(info.id, requestId, "allow")).toThrow(SessionError);
    await mgr.done(info.id);
  });

  test("interrupt menolak semua izin yang menunggu", async () => {
    const mgr = manager(askingRunner());
    const info = await mgr.create({ prompt: "p", cwd: dir });
    await requestIdOf(mgr, info.id);

    mgr.interrupt(info.id);
    const events = await eventsOf(mgr, info.id);

    expect(mgr.get(info.id)?.pendingPermissions).toBe(0);
    const resolved = events.find((e) => e.type === "permission_resolved");
    expect(resolved).toMatchObject({ decision: "deny", message: "sesi dihentikan" });
  });

  test("waktu tunggu habis menolak izin", async () => {
    const mgr = manager(askingRunner(), { permissionTimeoutMs: 20 });
    const info = await mgr.create({ prompt: "p", cwd: dir });
    const events = await eventsOf(mgr, info.id);

    expect(events.find((e) => e.type === "permission_resolved")).toMatchObject({
      decision: "deny",
      message: "waktu izin habis",
    });
    expect(mgr.get(info.id)?.pendingPermissions).toBe(0);
  });

  test("permission_request memuat expiresAt sesuai batas waktu", async () => {
    const fixed = new Date("2026-11-08T10:00:00.000Z");
    const mgr = manager(askingRunner(), { permissionTimeoutMs: 20, now: () => fixed });
    const info = await mgr.create({ prompt: "p", cwd: dir });
    const events = await eventsOf(mgr, info.id);
    const request = events.find((e) => e.type === "permission_request");
    expect(request?.type === "permission_request" && request.expiresAt).toBe("2026-11-08T10:00:00.020Z");
  });

  test("key provider pada input tool disamarkan di event", async () => {
    const mgr = manager(askingRunner({ command: `curl -H "x: ${KEY}"` }), { permissionTimeoutMs: 20 });
    const info = await mgr.create({ prompt: "p", cwd: dir });
    const events = await eventsOf(mgr, info.id);
    const request = events.find((e) => e.type === "permission_request");
    expect(JSON.stringify(request)).not.toContain(KEY);
    expect(JSON.stringify(request)).toContain("***");
  });
});

describe("rute izin", () => {
  async function makeApp(runner: AgentRunner) {
    const providersPath = join(dir, "providers.json");
    await writeFile(
      providersPath,
      JSON.stringify({
        profiles: [
          {
            id: "lokal",
            name: "Lokal",
            baseUrl: "https://lokal.test",
            apiKey: KEY,
            models: [{ id: "m" }],
            defaultModel: "m",
          },
        ],
        activeProfileId: "lokal",
      }),
    );
    const sessions = new SessionManager({
      runner,
      resolveProvider: async () => PROVIDER,
    });
    return { app: createApp({ providersPath, env: { MOCK: "true" }, runner, sessions }), sessions };
  }

  function post(app: ReturnType<typeof createApp>, path: string, body: unknown): Promise<Response> {
    return app.handle(
      new Request(`http://127.0.0.1:3000${path}`, {
        method: "POST",
        headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  test("200 untuk keputusan sah, 400 untuk keputusan salah, 404 untuk id tak dikenal", async () => {
    const { app, sessions } = await makeApp(askingRunner());
    const info = await sessions.create({ prompt: "p", cwd: dir });
    const requestId = await requestIdOf(sessions, info.id);
    const base = `/api/sessions/${info.id}/permissions`;

    expect((await post(app, `${base}/${requestId}`, { decision: "mungkin" })).status).toBe(400);
    expect((await post(app, `${base}/nihil`, { decision: "allow" })).status).toBe(404);

    const ok = await post(app, `${base}/${requestId}`, { decision: "allow" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    await sessions.done(info.id);

    expect((await post(app, `${base}/${requestId}`, { decision: "allow" })).status).toBe(404);
  });
});

describe("mock-runner: [todo]", () => {
  test("mengirim TodoWrite dengan tiga langkah lalu hasil", async () => {
    const events = await collect(
      createMockRunner({ delayMs: 0 }).run({ prompt: "isi [todo]", cwd: dir, provider: PROVIDER }),
    );
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({ name: "TodoWrite" });
    const todos = (call as { input: { todos: unknown[] } }).input.todos;
    expect(todos).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("result");
  });
});

describe("mock-runner: [izin]", () => {
  async function run(prompt: string, decision: PermissionDecision) {
    let calls = 0;
    const events = await collect(
      createMockRunner({ delayMs: 0 }).run({
        prompt,
        cwd: dir,
        provider: PROVIDER,
        requestPermission: async () => {
          calls += 1;
          return decision;
        },
      }),
    );
    return { events, calls };
  }

  test("allow melanjutkan alur mock normal", async () => {
    const { events, calls } = await run("tolong [izin]", { behavior: "allow" });
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    expect(events.at(-1)?.type).toBe("result");
  });

  test("deny berhenti dengan pesan penolakan", async () => {
    const { events, calls } = await run("tolong [izin]", { behavior: "deny", message: "no" });
    expect(calls).toBe(1);
    expect(events).toEqual([
      { type: "text", text: "Izin ditolak, aksi dibatalkan." },
      // Hasil mock memakai jangkar percakapan sintetis.
      { type: "result", ok: true, anchorUuid: "mock-anchor-1" },
    ]);
  });

  test("tanpa [izin] handler tidak dipanggil", async () => {
    const { calls } = await run("halo", { behavior: "allow" });
    expect(calls).toBe(0);
  });
});

describe("klien: decidePermission", () => {
  test("POST ke path ter-encode dengan body JSON", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const api = createApiClient({ fetch: fetchImpl });

    await api.decidePermission("s 1", "r/2", "deny", "nanti");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/sessions/s%201/permissions/r%2F2");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ decision: "deny", message: "nanti" });
  });
});

describe("AskUserQuestion: jawaban kembali ke SDK", () => {
  function questionRunner(seen: { decision?: PermissionDecision }): AgentRunner {
    return {
      async *run(runInput: RunInput) {
        seen.decision = await runInput.requestPermission?.(
          {
            toolUseId: "tu-q",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Lanjut?", options: [{ label: "Ya" }] }] },
          },
          runInput.signal ?? new AbortController().signal,
        );
        yield { type: "result", ok: true };
      },
    };
  }

  test("allow dengan answers -> updatedInput memuat pertanyaan asli + answers", async () => {
    const seen: { decision?: PermissionDecision } = {};
    const mgr = manager(questionRunner(seen));
    const info = await mgr.create({ prompt: "p", cwd: dir });
    const requestId = await requestIdOf(mgr, info.id);
    mgr.resolvePermission(info.id, requestId, "allow", undefined, { "Lanjut?": "Ya" });
    await eventsOf(mgr, info.id);
    expect(seen.decision).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [{ question: "Lanjut?", options: [{ label: "Ya" }] }],
        answers: { "Lanjut?": "Ya" },
      },
    });
  });

  test("event permission_resolved membawa answers agar riwayat bisa menampilkannya", async () => {
    const seen: { decision?: PermissionDecision } = {};
    const mgr = manager(questionRunner(seen));
    const info = await mgr.create({ prompt: "p", cwd: dir });
    const requestId = await requestIdOf(mgr, info.id);
    mgr.resolvePermission(info.id, requestId, "allow", undefined, { "Lanjut?": "Ya" });
    const events = await eventsOf(mgr, info.id);
    expect(events).toContainEqual({
      type: "permission_resolved",
      id: requestId,
      decision: "allow",
      answers: { "Lanjut?": "Ya" },
    });
  });

  test("tool lain mengabaikan answers", async () => {
    const seen: { decision?: PermissionDecision } = {};
    const mgr = manager(askingRunner());
    const info = await mgr.create({ prompt: "p", cwd: dir });
    const requestId = await requestIdOf(mgr, info.id);
    mgr.resolvePermission(info.id, requestId, "allow", undefined, { x: "y" });
    const events = await eventsOf(mgr, info.id);
    expect(events).toContainEqual({ type: "text", text: "keputusan:allow:" });
    expect(seen.decision).toBeUndefined();
  });
});
