import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultUsageLedger,
  SqliteUsageLedger,
  usagePath,
  type UsageLedger,
} from "../src/server/budget/usage-ledger";

const stores: UsageLedger[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // sudah ditutup di tes
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function open(path: string = ":memory:", retentionDays?: number): SqliteUsageLedger {
  const store = new SqliteUsageLedger(path, retentionDays === undefined ? {} : { retentionDays });
  stores.push(store);
  return store;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jejak-usage-"));
  dirs.push(dir);
  return dir;
}

const ENTRY = {
  ts: "2026-11-10T03:00:00.000Z",
  sessionId: "s_1",
  profileId: "lokal",
  model: "model-uji",
  costUsd: 0.5,
  inputTokens: 10,
  outputTokens: 20,
};

describe("SqliteUsageLedger", () => {
  test("record lalu sum per sesi dan sejak waktu", () => {
    const ledger = open();
    ledger.record(ENTRY);
    ledger.record({ ...ENTRY, sessionId: "s_2", ts: "2026-11-10T04:00:00.000Z", costUsd: 0.25 });

    expect(ledger.sumForSession("s_1")).toBe(0.5);
    expect(ledger.sumForSession("s_2")).toBe(0.25);
    expect(ledger.sumForSession("tidak-ada")).toBe(0);
    expect(ledger.sumSince("2026-11-10T00:00:00.000Z")).toBe(0.75);
    expect(ledger.sumSince("2026-11-10T03:30:00.000Z")).toBe(0.25);
  });

  test("entri tidak valid diabaikan tanpa melempar", () => {
    const ledger = open();
    expect(() =>
      ledger.record({ ...ENTRY, costUsd: Number.NaN }),
    ).not.toThrow();
    expect(() => ledger.record({ ...ENTRY, costUsd: -1 })).not.toThrow();
    expect(() => ledger.record({ ...ENTRY, costUsd: Number.POSITIVE_INFINITY })).not.toThrow();
    expect(() =>
      ledger.record({ ...ENTRY, sessionId: "" }),
    ).not.toThrow();
    expect(ledger.sumForSession("s_1")).toBe(0);
  });

  test("prune menghapus entri lebih lama dari retensi", () => {
    const ledger = open(":memory:", 90);
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const twoDays = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    ledger.record({ ...ENTRY, ts: old, costUsd: 1 });
    ledger.record({ ...ENTRY, ts: recent, costUsd: 2 });
    ledger.record({ ...ENTRY, ts: twoDays, costUsd: 4 });

    ledger.prune();
    expect(ledger.sumForSession("s_1")).toBe(6);
    ledger.prune(1);
    expect(ledger.sumForSession("s_1")).toBe(2);
  });

  test("prune saat dibuka memakai retensi", () => {
    const dir = tempDir();
    const path = join(dir, "usage.db");
    const first = open(path, 90);
    first.record({ ...ENTRY, ts: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString() });
    first.close();

    const second = open(path, 90);
    expect(second.sumForSession("s_1")).toBe(0);
  });

  test("berkas 0600 dan direktori dibuat", () => {
    const dir = tempDir();
    const path = join(dir, "rumah", "usage.db");
    const ledger = open(path);
    ledger.record(ENTRY);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("defaultUsageLedger menghormati JEJAK_PERSIST dan JEJAK_BUDGET", () => {
    const dir = tempDir();
    const path = usagePath({ JEJAK_HOME: dir });
    expect(path).toBe(join(dir, "usage.db"));

    const ledger = defaultUsageLedger({ JEJAK_HOME: dir });
    expect(ledger).toBeDefined();
    ledger!.close();

    expect(defaultUsageLedger({ JEJAK_HOME: dir, JEJAK_PERSIST: "0" })).toBeUndefined();
    expect(defaultUsageLedger({ JEJAK_HOME: dir, JEJAK_BUDGET: "0" })).toBeUndefined();
  });
});
