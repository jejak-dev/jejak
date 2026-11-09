import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, RunInput } from "../src/server/agent";
import { SqliteAuditStore, type AuditEntry, type AuditStore } from "../src/server/audit/audit-store";
import type { WorktreeService } from "../src/server/git/worktree-service";
import type { ResolvedProvider } from "../src/server/provider";
import { FileSecretAllowStore } from "../src/server/security/secret-allow-store";
import { SessionManager, type SessionManagerOptions } from "../src/server/sessions/session-manager";

const PROVIDER: ResolvedProvider = { profileId: "lokal", apiKey: "kunci", model: "model-uji" };

let root: string;
let project: string;
let worktree: string;
let audits: AuditStore[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "jejak-session-allow-")));
  project = join(root, "repo");
  worktree = join(root, "worktrees", "s_1");
  await mkdir(project, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(project, ".env"), "TOKEN=sintetis\n");
  await writeFile(join(project, ".env.local"), "TOKEN=sintetis\n");
  await writeFile(join(worktree, ".env"), "TOKEN=sintetis\n");
  await writeFile(join(worktree, ".env.local"), "TOKEN=sintetis\n");
});

afterEach(async () => {
  for (const store of audits) store.close();
  audits = [];
  await rm(root, { recursive: true, force: true });
});

function auditStore(): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:");
  audits.push(store);
  return store;
}

interface GuardResult {
  reason: string;
  rule?: string;
}

function guardingRunner(
  calls: Array<{ toolName: string; toolInput: unknown }>,
  results: Array<GuardResult | undefined>,
): AgentRunner {
  return {
    async *run(input: RunInput) {
      const guard = input.secretGuard;
      for (let index = 0; index < calls.length; index += 1) {
        const result = guard?.(calls[index]!);
        results[index] = result;
      }
      yield { type: "result", ok: true } as AgentEvent;
    },
  };
}

/** Cukup untuk `manager.create({ worktree: true })` di tes ini. */
function stubWorktreeService(shortId: () => string): WorktreeService {
  return {
    async create(input: { sessionId: string }) {
      return {
        info: {
          repoRoot: project,
          path: worktree,
          branch: `jejak/${input.sessionId}`,
          baseCommit: "0".repeat(40),
        },
        dirtyInSource: false,
      };
    },
  } as unknown as WorktreeService;
}

function manager(runner: AgentRunner, extra: Partial<SessionManagerOptions> = {}): SessionManager {
  return new SessionManager({
    runner,
    resolveProvider: async () => PROVIDER,
    ...extra,
  });
}

function blockedAudits(audit: AuditStore, sessionId: string): AuditEntry[] {
  return audit.list({ session: sessionId, kind: "rahasia-diblokir", limit: 200 });
}

describe("SessionManager memakai daftar izin rahasia", () => {
  test("terdaftar di store yang sama -> .env tidak diblokir, .env.local tetap", async () => {
    const audit = auditStore();
    const allow = new FileSecretAllowStore(":memory:");
    allow.add(project, ".env");
    const results: Array<GuardResult | undefined> = [];
    const mgr = manager(
      guardingRunner(
        [
          { toolName: "Read", toolInput: { file_path: join(project, ".env") } },
          { toolName: "Read", toolInput: { file_path: join(project, ".env.local") } },
        ],
        results,
      ),
      { audit, secrets: { allow } },
    );

    const info = await mgr.create({ prompt: "p", cwd: project });
    await mgr.done(info.id);

    expect(results[0]).toBeUndefined();
    expect(results[1]?.rule).toBe(".env.*");
    const entries = blockedAudits(audit, info.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.meta).toMatchObject({ tool: "Read", aturan: ".env.*" });
  });

  test("tanpa entri -> .env diblokir lalu setelah add tidak diblokir lagi", async () => {
    const audit = auditStore();
    const allow = new FileSecretAllowStore(":memory:");
    const first: Array<GuardResult | undefined> = [];
    const mgr = manager(
      guardingRunner([{ toolName: "Read", toolInput: { file_path: join(project, ".env") } }], first),
      { audit, secrets: { allow } },
    );

    const info = await mgr.create({ prompt: "p", cwd: project });
    await mgr.done(info.id);
    expect(first[0]?.rule).toBe(".env");
    const before = blockedAudits(audit, info.id).length;
    expect(before).toBe(1);

    allow.add(mgr.secretProjectRoot(info.id), ".env");

    const second: Array<GuardResult | undefined> = [];
    const mgr2 = manager(
      guardingRunner([{ toolName: "Read", toolInput: { file_path: join(project, ".env") } }], second),
      { audit, secrets: { allow } },
    );
    const info2 = await mgr2.create({ prompt: "p", cwd: project });
    await mgr2.done(info2.id);

    expect(second[0]).toBeUndefined();
    expect(blockedAudits(audit, info2.id)).toHaveLength(0);
    expect(blockedAudits(audit, info.id)).toHaveLength(before);
  });

  test("session worktree memakai akar repo asli", async () => {
    const audit = auditStore();
    const allow = new FileSecretAllowStore(":memory:");
    const results: Array<GuardResult | undefined> = [];
    const mgr = manager(
      guardingRunner(
        [{ toolName: "Read", toolInput: { file_path: join(worktree, ".env") } }],
        results,
      ),
      {
        audit,
        worktrees: stubWorktreeService(() => "s_1"),
        secrets: { allow },
      },
    );

    const info = await mgr.create({ prompt: "p", cwd: project, worktree: true });
    await mgr.done(info.id);

    expect(info.worktree?.path).toBe(worktree);
    expect(mgr.secretProjectRoot(info.id)).toBe(project);
    expect(allow.add(mgr.secretProjectRoot(info.id), ".env")).toEqual({
      path: ".env",
      rule: ".env",
    });
    expect(allow.list(project)).toEqual([".env"]);
    // Berkas fisik di worktree bukan jalur persis di dalam akar proyek, jadi
    // kebijakan isAllowed tidak melonggarkannya (lihat catatan laporan).
    expect(results[0]?.rule).toBe(".env");
  });

  test("sesi tak ada -> SessionError tidak-ditemukan", () => {
    const mgr = manager(guardingRunner([], []));
    expect(() => mgr.secretProjectRoot("tidak-ada")).toThrow("tidak ditemukan");
  });
});
