import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent";
import {
  SqliteAuditStore,
  type AuditEntry,
  type AuditEntryInput,
  type AuditQuery,
  type AuditStore,
  type AuditSummary,
} from "../src/server/audit/audit-store";
import type { ResolvedProvider } from "../src/server/provider";
import { SessionManager, type SessionManagerOptions } from "../src/server/sessions/session-manager";

const SECRET = "sk-sintetis-9f8e7d6c";
const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci-provider", model: "model-uji" };

let dir: string;
const audits: AuditStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-session-audit-"));
});

afterEach(async () => {
  for (const audit of audits.splice(0)) audit.close();
  await rm(dir, { recursive: true, force: true });
});

function memoryAudit(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  audits.push(store);
  return store;
}

function manager(runner: AgentRunner, extra: Partial<SessionManagerOptions> = {}): SessionManager {
  return new SessionManager({
    runner,
    resolveProvider: async () => PROVIDER,
    ...extra,
  });
}

function scriptedRunner(events: AgentEvent[]): AgentRunner {
  return {
    async *run() {
      for (const event of events) yield event;
    },
  };
}

/** Runner yang minta izin sekali, lalu selesaikan sesuai keputusan. */
function askingRunner(input: unknown = { file_path: "a.txt" }): AgentRunner {
  return {
    async *run(runInput: RunInput) {
      await runInput.requestPermission?.(
        { toolUseId: "tu1", name: "Write", input },
        runInput.signal ?? new AbortController().signal,
      );
      yield { type: "result", ok: true };
    },
  };
}

function entriesOf(audit: AuditStore, sessionId: string, kind?: AuditEntry["kind"]): AuditEntry[] {
  const query: AuditQuery = { session: sessionId, limit: 200 };
  if (kind !== undefined) query.kind = kind;
  return audit.list(query);
}

describe("SessionManager audit", () => {
  test("sesi-mulai dicatat sekali dengan meta tanpa prompt/judul/cwd", async () => {
    const audit = memoryAudit();
    const mgr = manager(scriptedRunner([{ type: "result", ok: true }]), { audit });
    const info = await mgr.create({ prompt: `halo ${SECRET}`, cwd: dir });
    await mgr.done(info.id);

    const started = entriesOf(audit, info.id, "sesi-mulai");
    expect(started).toHaveLength(1);
    expect(started[0]?.summary).toBe("Sesi dimulai");
    expect(started[0]?.meta).toEqual({
      permissionMode: "default",
      worktree: false,
      workspace: false,
      model: "model-uji",
    });
    expect(JSON.stringify(entriesOf(audit, info.id))).not.toContain(SECRET);
  });

  test("tool dicatat dengan ringkasan input dan tanpa output", async () => {
    const audit = memoryAudit();
    const mgr = manager(
      scriptedRunner([
        { type: "tool_call", id: "t1", name: "Read", input: { file_path: "src/a b.ts" } },
        { type: "tool_call", id: "t2", name: "Grep", input: { pattern: "  perlu\n  cari " } },
        {
          type: "tool_call",
          id: "t3",
          name: "Bash",
          input: { command: "echo hasil-rahasia-tool" },
          parentToolUseId: "p1",
        },
        { type: "tool_result", id: "t3", output: `keluaran ${SECRET}`, isError: false },
        { type: "result", ok: true },
      ]),
      { audit },
    );
    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);

    const tools = entriesOf(audit, info.id, "tool");
    expect(tools).toHaveLength(3);
    const summaries = tools.map((entry) => entry.summary).reverse();
    expect(summaries).toEqual([
      "Read: src/a b.ts",
      "Grep: perlu cari",
      "Bash: echo hasil-rahasia-tool",
    ]);
    expect(tools.find((entry) => entry.summary.startsWith("Bash"))?.meta).toEqual({
      tool: "Bash",
      sub: true,
    });
    expect(tools.find((entry) => entry.summary.startsWith("Read"))?.meta).toEqual({
      tool: "Read",
      sub: false,
    });
    expect(JSON.stringify(tools)).not.toContain(SECRET);
  });

  test("izin diminta, diizinkan, ditolak, kedaluwarsa, dan dihentikan", async () => {
    const audit = memoryAudit();

    // diminta + diizinkan
    const allow = manager(askingRunner(), { audit });
    const allowed = await allow.create({ prompt: "p", cwd: dir });
    const allowRequestId = await askRequestId(allow, allowed.id);
    const asked = entriesOf(audit, allowed.id, "izin");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      summary: "Izin diminta: Write",
      meta: { tool: "Write", decision: "diminta" },
    });
    allow.resolvePermission(allowed.id, allowRequestId, "allow");
    await allow.done(allowed.id);
    const allowedEntries = entriesOf(audit, allowed.id, "izin");
    expect(allowedEntries.map((entry) => entry.meta.decision).sort()).toEqual([
      "diizinkan",
      "diminta",
    ]);
    expect(allowedEntries.find((entry) => entry.meta.decision === "diizinkan")?.summary).toBe(
      "Izin diizinkan: Write",
    );

    // ditolak
    const deny = manager(askingRunner(), { audit });
    const denied = await deny.create({ prompt: "p", cwd: dir });
    deny.resolvePermission(denied.id, await askRequestId(deny, denied.id), "deny");
    await deny.done(denied.id);
    expect(
      entriesOf(audit, denied.id, "izin").find((entry) => entry.meta.decision === "ditolak")?.summary,
    ).toBe("Izin ditolak: Write");

    // kedaluwarsa
    const expiring = manager(askingRunner(), { audit, permissionTimeoutMs: 10 });
    const expired = await expiring.create({ prompt: "p", cwd: dir });
    await expiring.done(expired.id);
    const expiredEntry = entriesOf(audit, expired.id, "izin").find(
      (entry) => entry.meta.alasan === "kedaluwarsa",
    );
    expect(expiredEntry).toMatchObject({ summary: "Izin ditolak: Write", meta: { decision: "ditolak" } });

    // dihentikan
    const stopping = manager(askingRunner(), { audit });
    const stopped = await stopping.create({ prompt: "p", cwd: dir });
    await askRequestId(stopping, stopped.id);
    stopping.interrupt(stopped.id);
    await stopping.done(stopped.id);
    const stoppedEntry = entriesOf(audit, stopped.id, "izin").find(
      (entry) => entry.meta.alasan === "dihentikan",
    );
    expect(stoppedEntry).toMatchObject({ summary: "Izin ditolak: Write", meta: { decision: "ditolak" } });
  });

  test("sesi-berhenti sekali per giliran dengan status benar", async () => {
    const audit = memoryAudit();
    const runner = scriptedRunner([
      { type: "session", sessionId: "sdk-1" },
      { type: "result", ok: true },
    ]);
    const mgr = manager(runner, { audit });
    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);
    expect(entriesOf(audit, info.id, "sesi-berhenti")).toHaveLength(1);

    await mgr.send(info.id, "lanjut");
    await mgr.done(info.id);
    const stopped = entriesOf(audit, info.id, "sesi-berhenti");
    expect(stopped).toHaveLength(2);
    expect(stopped.every((entry) => entry.meta.status === "selesai")).toBe(true);
    expect(stopped.map((entry) => entry.meta.turns).sort()).toEqual([1, 2]);
  });

  test("tidak ada prompt atau output tool di summary/meta", async () => {
    const audit = memoryAudit();
    const mgr = manager(
      scriptedRunner([
        { type: "text", text: `teks ${SECRET}` },
        { type: "tool_call", id: "t1", name: "Bash", input: { command: `echo ${SECRET}` } },
        { type: "tool_result", id: "t1", output: `keluaran ${SECRET}`, isError: false },
        { type: "result", ok: true, summary: `ringkas ${SECRET}` },
      ]),
      { audit },
    );
    const info = await mgr.create({ prompt: `prompt ${SECRET}`, cwd: dir });
    await mgr.done(info.id);

    const dump = JSON.stringify(entriesOf(audit, info.id));
    expect(dump).not.toContain(SECRET);
  });

  test("manager tanpa audit bekerja normal", async () => {
    const mgr = manager(scriptedRunner([{ type: "result", ok: true }]));
    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("selesai");
  });

  test("audit yang melempar tidak merusak sesi", async () => {
    const throwing: AuditStore = {
      append: (_input: AuditEntryInput) => {
        throw new Error("audit rusak");
      },
      list: (_query?: AuditQuery) => [],
      summary: (_now?: Date): AuditSummary => ({
        days: 7,
        since: "",
        total: 0,
        byKind: {},
        redactedSessions: 0,
      }),
      prune: () => 0,
      close: () => {},
    };
    const mgr = manager(scriptedRunner([{ type: "result", ok: true }]), { audit: throwing });
    const info = await mgr.create({ prompt: "halo", cwd: dir });
    await mgr.done(info.id);
    expect(mgr.get(info.id)?.status).toBe("selesai");
  });
});

/** Ambil id permintaan izin dari buffer lewat SSE sekali baca. */
async function askRequestId(mgr: SessionManager, id: string): Promise<string> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    for await (const item of mgr.events(id, { signal: AbortSignal.timeout(20) })) {
      if (item.event.type === "permission_request") return item.event.id;
    }
  }
  throw new Error("permission_request tidak ditemukan");
}
