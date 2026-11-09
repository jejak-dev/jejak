import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import type { ResolvedProvider } from "../src/server/provider";
import {
  SessionManager,
  type SequencedEvent,
  type SessionManagerOptions,
} from "../src/server/sessions/session-manager";

const SECRET = "sk-abcdefgh12345678";
const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci-provider-xyz", model: "model-uji" };

let dir: string;
const audits: AuditStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-session-secrets-"));
});

afterEach(async () => {
  for (const audit of audits.splice(0)) audit.close();
  await rm(dir, { recursive: true, force: true });
});

function manager(runner: AgentRunner, extra: Partial<SessionManagerOptions> = {}): SessionManager {
  return new SessionManager({
    runner,
    resolveProvider: async () => PROVIDER,
    ...extra,
  });
}

function memoryAudit(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  audits.push(store);
  return store;
}

function recordingRunner(script: (input: RunInput) => AgentEvent[]): {
  runner: AgentRunner;
  runs: RunInput[];
} {
  const runs: RunInput[] = [];
  return {
    runs,
    runner: {
      async *run(input) {
        runs.push(input);
        for (const event of script(input)) yield event;
      },
    },
  };
}

async function collect(iterable: AsyncIterable<SequencedEvent>): Promise<SequencedEvent[]> {
  const result: SequencedEvent[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

describe("SessionManager penyamaran rahasia", () => {
  test("mode redact menyamarkan event, prompt, dan judul; agent menerima teks asli", async () => {
    const recording = recordingRunner(() => [
      { type: "session", sessionId: "sdk-1" },
      { type: "text", text: `kunci ${SECRET} bocor` },
      { type: "tool_call", id: "t1", name: "Bash", input: { command: `echo ${SECRET}` } },
      { type: "tool_result", id: "t1", output: `hasil ${SECRET}`, isError: false },
      { type: "result", ok: true, summary: `ringkas ${SECRET}` },
    ]);
    const mgr = manager(recording.runner);
    const info = await mgr.create({ prompt: `pakai ${SECRET}`, title: `judul ${SECRET}`, cwd: dir });
    await mgr.done(info.id);

    expect(recording.runs[0]?.prompt).toBe(`pakai ${SECRET}`);
    expect(info.prompt).not.toContain(SECRET);
    expect(info.prompt).toContain("[disembunyikan:kunci API]");
    expect(info.title).not.toContain(SECRET);
    expect(mgr.get(info.id)?.prompt).not.toContain(SECRET);

    const events = await collect(mgr.events(info.id));
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(mgr.get(info.id)?.redactedEvents).toBeGreaterThanOrEqual(1);
  });

  test("user_message susulan tersamarkan tetapi agent menerima teks asli", async () => {
    const recording = recordingRunner(() => [
      { type: "session", sessionId: "sdk-1" },
      { type: "text", text: "selesai" },
      { type: "result", ok: true },
    ]);
    const mgr = manager(recording.runner);
    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);

    expect(await mgr.send(info.id, `lanjut pakai ${SECRET}`)).toEqual({ queued: false });
    await mgr.done(info.id);

    expect(recording.runs[1]?.prompt).toBe(`lanjut pakai ${SECRET}`);
    const events = await collect(mgr.events(info.id));
    const userMessage = events.find((item) => item.event.type === "user_message");
    expect(userMessage?.event.type === "user_message" && userMessage.event.text).not.toContain(SECRET);
  });

  test("mode warn menyimpan teks utuh dan mencatat audit rahasia", async () => {
    const audit = memoryAudit();
    const recording = recordingRunner(() => [
      { type: "text", text: `kunci ${SECRET}` },
      { type: "result", ok: true },
    ]);
    const mgr = manager(recording.runner, { audit, secrets: { mode: "warn" } });
    const info = await mgr.create({ prompt: `prompt ${SECRET}`, cwd: dir });
    await mgr.done(info.id);

    expect(info.prompt).toBe(`prompt ${SECRET}`);
    const events = await collect(mgr.events(info.id));
    expect(JSON.stringify(events)).toContain(SECRET);
    expect(mgr.get(info.id)?.redactedEvents).toBe(1);

    const entries = audit.list({ session: info.id, kind: "rahasia-disamarkan" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary).toContain("tidak disamarkan");
    expect(entries[0]?.meta).toEqual({ eventType: "text", mode: "warn", jenis: "kunci API×1" });
  });

  test("mode off tidak menyamarkan dan tidak mencatat audit rahasia", async () => {
    const audit = memoryAudit();
    const recording = recordingRunner(() => [
      { type: "text", text: `kunci ${SECRET}` },
      { type: "result", ok: true },
    ]);
    const mgr = manager(recording.runner, { audit, secrets: { mode: "off" } });
    const info = await mgr.create({ prompt: `prompt ${SECRET}`, cwd: dir });
    await mgr.done(info.id);

    expect(info.prompt).toBe(`prompt ${SECRET}`);
    const events = await collect(mgr.events(info.id));
    expect(JSON.stringify(events)).toContain(SECRET);
    expect(mgr.get(info.id)?.redactedEvents).toBeUndefined();
    expect(audit.list({ session: info.id, kind: "rahasia-disamarkan" })).toHaveLength(0);
  });

  test("nilai .env dari loadEnvValues disamarkan dan loader dipanggil sekali per sesi", async () => {
    const calls: string[] = [];
    const recording = recordingRunner(() => [
      { type: "text", text: "nilai rahasia-env-1234 terbaca" },
      { type: "text", text: "muncul lagi rahasia-env-1234" },
      { type: "result", ok: true },
    ]);
    const mgr = manager(recording.runner, {
      secrets: { loadEnvValues: (cwd) => (calls.push(cwd), ["rahasia-env-1234"]) },
    });
    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);

    expect(calls).toEqual([dir]);
    const events = await collect(mgr.events(info.id));
    expect(JSON.stringify(events)).not.toContain("rahasia-env-1234");
    expect(mgr.get(info.id)?.redactedEvents).toBe(2);
  });

  test("loader yang melempar tidak merusak sesi", async () => {
    const recording = recordingRunner(() => [
      { type: "text", text: "halo" },
      { type: "result", ok: true },
    ]);
    const mgr = manager(recording.runner, {
      secrets: {
        loadEnvValues: () => {
          throw new Error("gagal baca env");
        },
      },
    });
    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("selesai");
  });

  test("tanpa rahasia event identik secara byte dan redactedEvents tidak ada", async () => {
    const scripts: AgentEvent[] = [
      { type: "session", sessionId: "sdk-1" },
      { type: "text", text: "halo dunia" },
      { type: "thinking", text: "berpikir biasa" },
      { type: "tool_call", id: "t1", name: "Read", input: { file_path: "a.txt" } },
      { type: "tool_result", id: "t1", output: "isi berkas biasa", isError: false },
      { type: "result", ok: true, summary: "ringkas" },
    ];
    const mgr = manager(scriptedRunner(scripts));
    const info = await mgr.create({ prompt: "prompt biasa", cwd: dir });
    await mgr.done(info.id);

    const events = (await collect(mgr.events(info.id))).map((item) => item.event);
    expect(events).toEqual(scripts);
    expect(info.prompt).toBe("prompt biasa");
    expect(mgr.get(info.id)?.redactedEvents).toBeUndefined();
  });
});

function scriptedRunner(events: AgentEvent[]): AgentRunner {
  return {
    async *run() {
      for (const event of events) yield event;
    },
  };
}
