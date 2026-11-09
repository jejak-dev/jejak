import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import type { ResolvedProvider } from "../src/server/provider";
import { SessionManager, type SessionManagerOptions } from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };

let dir: string;
const audits: AuditStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-session-block-"));
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

interface GuardResult {
  reason: string;
  rule?: string;
}

/** Runner yang memanggil secretGuard seperti sdk-runner, lalu menyelesaikan. */
function guardingRunner(
  calls: Array<{ toolName: string; toolInput: unknown; agentId?: string }>,
  results: Array<GuardResult | undefined>,
): AgentRunner {
  return {
    async *run(input: RunInput) {
      const guard = input.secretGuard;
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index]!;
        const result = guard?.(call);
        results[index] = result;
        if (result !== undefined) {
          yield { type: "error", message: `PreToolUse:${call.toolName} hook error: ${result.reason}` };
        }
      }
      yield { type: "result", ok: true } as AgentEvent;
    },
  };
}

function entriesOf(audit: AuditStore, sessionId: string): AuditEntry[] {
  return audit.list({ session: sessionId, kind: "rahasia-diblokir", limit: 200 });
}

describe("SessionManager penolakan berkas rahasia", () => {
  test("diblokir -> tepat satu audit tanpa jalur lengkap/command", async () => {
    const audit = memoryAudit();
    const results: Array<GuardResult | undefined> = [];
    const mgr = manager(
      guardingRunner(
        [
          {
            toolName: "Read",
            toolInput: { file_path: join(dir, ".env") },
            agentId: "sub-1",
          },
        ],
        results,
      ),
      { audit },
    );

    const info = await mgr.create({ prompt: "p", cwd: dir });
    await mgr.done(info.id);

    expect(results[0]?.rule).toBe(".env");
    expect(results[0]?.reason).toContain("diblokir kebijakan rahasia");

    const entries = entriesOf(audit, info.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      summary: "Akses ke berkas rahasia diblokir: Read",
      meta: { tool: "Read", aturan: ".env", sub: true },
    });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("file_path");
    expect(serialized).not.toContain("command");
  });

  test("tidak diblokir -> tanpa entri audit", async () => {
    const audit = memoryAudit();
    const results: Array<GuardResult | undefined> = [];
    const mgr = manager(
      guardingRunner(
        [{ toolName: "Read", toolInput: { file_path: join(dir, ".env.example") } }],
        results,
      ),
      { audit },
    );

    const info = await mgr.create({ prompt: "p", cwd: dir });
    await mgr.done(info.id);

    expect(results[0]).toBeUndefined();
    expect(entriesOf(audit, info.id)).toHaveLength(0);
  });

  test("blockPaths:false atau mode off -> secretGuard tidak diberikan", async () => {
    for (const extra of [
      { secrets: { blockPaths: false } },
      { secrets: { mode: "off" as const } },
    ]) {
      let guardSeen: unknown = "belum";
      const runner: AgentRunner = {
        async *run(input: RunInput) {
          guardSeen = input.secretGuard;
          yield { type: "result", ok: true } as AgentEvent;
        },
      };
      const mgr = manager(runner, { secrets: extra.secrets });
      const info = await mgr.create({ prompt: "p", cwd: dir });
      await mgr.done(info.id);
      expect(guardSeen).toBeUndefined();
    }
  });

  test("tanpa audit store tetap menolak tanpa melempar", async () => {
    const results: Array<GuardResult | undefined> = [];
    const mgr = manager(
      guardingRunner([{ toolName: "Bash", toolInput: { command: "cat .env" } }], results),
    );
    const info = await mgr.create({ prompt: "p", cwd: dir });
    await mgr.done(info.id);
    expect(results[0]?.rule).toBe(".env");
  });
});
