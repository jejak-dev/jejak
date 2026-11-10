import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_KINDS,
  auditPath,
  defaultAuditStore,
  SqliteAuditStore,
  type AuditStore,
} from "../src/server/audit/audit-store";

const DAY = 24 * 60 * 60 * 1000;
const stores: AuditStore[] = [];
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

function open(options: { retentionDays?: number } = {}): SqliteAuditStore {
  const store = new SqliteAuditStore(":memory:", options);
  stores.push(store);
  return store;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jejak-audit-"));
  dirs.push(dir);
  return dir;
}

describe("SqliteAuditStore", () => {
  test("append lalu list urut terbaru dulu", () => {
    const store = open();
    store.append({ kind: "sesi-mulai", summary: "pertama" });
    store.append({ kind: "tool", summary: "kedua" });
    const entries = store.list();
    expect(entries.map((entry) => entry.summary)).toEqual(["kedua", "pertama"]);
    expect(entries[0]!.id).toBeGreaterThan(entries[1]!.id);
  });

  test("filter session dan kind", () => {
    const store = open();
    store.append({ kind: "tool", sessionId: "s1", summary: "a" });
    store.append({ kind: "git", sessionId: "s1", summary: "b" });
    store.append({ kind: "tool", sessionId: "s2", summary: "c" });

    expect(store.list({ session: "s1" }).map((e) => e.summary)).toEqual(["b", "a"]);
    expect(store.list({ kind: "tool" }).map((e) => e.summary)).toEqual(["c", "a"]);
    expect(store.list({ session: "s1", kind: "tool" }).map((e) => e.summary)).toEqual(["a"]);
  });

  test("paginasi before dan batas limit", () => {
    const store = open();
    for (let index = 1; index <= 5; index += 1) {
      store.append({ kind: "tool", summary: `entri-${index}` });
    }
    const first = store.list({ limit: 2 });
    expect(first.map((e) => e.summary)).toEqual(["entri-5", "entri-4"]);
    const second = store.list({ limit: 2, before: first[1]!.id });
    expect(second.map((e) => e.summary)).toEqual(["entri-3", "entri-2"]);

    expect(store.list({ limit: 0 }).length).toBe(1);
    for (let index = 0; index < 205; index += 1) {
      store.append({ kind: "tool", summary: `bulk-${index}` });
    }
    expect(store.list({ limit: 999 }).length).toBe(200);
  });

  test("summary 7 hari terakhir dan redactedSessions", () => {
    const store = open();
    const now = new Date();
    store.append({
      kind: "tool",
      sessionId: "s1",
      summary: "baru",
      ts: new Date(now.getTime() - DAY).toISOString(),
    });
    store.append({
      kind: "rahasia-disamarkan",
      sessionId: "s1",
      summary: "disamarkan 1",
      ts: new Date(now.getTime() - 2 * DAY).toISOString(),
    });
    store.append({
      kind: "rahasia-disamarkan",
      sessionId: "s1",
      summary: "disamarkan 2",
      ts: new Date(now.getTime() - 3 * DAY).toISOString(),
    });
    store.append({
      kind: "rahasia-disamarkan",
      sessionId: "s2",
      summary: "disamarkan 3",
      ts: new Date(now.getTime() - 3 * DAY).toISOString(),
    });
    store.append({
      kind: "tool",
      sessionId: "s3",
      summary: "lama",
      ts: new Date(now.getTime() - 8 * DAY).toISOString(),
    });

    const summary = store.summary(now);
    expect(summary.days).toBe(7);
    expect(summary.total).toBe(4);
    expect(summary.byKind).toEqual({ tool: 1, "rahasia-disamarkan": 3 });
    expect(summary.redactedSessions).toBe(2);
  });

  test("prune memakai retensi dan mengembalikan jumlah", () => {
    const store = open({ retentionDays: 2 });
    const now = new Date();
    store.append({
      kind: "tool",
      summary: "tua",
      ts: new Date(now.getTime() - 5 * DAY).toISOString(),
    });
    store.append({
      kind: "tool",
      summary: "muda",
      ts: new Date(now.getTime() - DAY).toISOString(),
    });

    expect(store.prune(now)).toBe(1);
    expect(store.list().map((e) => e.summary)).toEqual(["muda"]);
  });

  test("summary disamarkan dan tidak menyimpan token asli", () => {
    const store = open();
    store.append({
      kind: "tool",
      summary: "Authorization: Bearer abcdefgh12345678",
    });
    const entry = store.list()[0]!;
    expect(entry.summary).not.toContain("abcdefgh12345678");
    expect(entry.summary).toContain("[disembunyikan:token Bearer]");
  });

  test("meta string disamarkan, kunci buruk dibuang, meta besar dipotong", () => {
    const store = open();
    store.append({
      kind: "tool",
      summary: "meta",
      meta: {
        aman: "token=abcdefgh12345678",
        "Nama-Buruk": "x",
        "9awal": "y",
      },
    });
    const entry = store.list()[0]!;
    expect(entry.meta.aman).not.toContain("abcdefgh12345678");
    expect(entry.meta["Nama-Buruk"]).toBeUndefined();
    expect(entry.meta["9awal"]).toBeUndefined();

    const big: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) {
      big[`k${index}`] = "x".repeat(199);
    }
    store.append({ kind: "tool", summary: "besar", meta: big });
    expect(store.list()[0]!.meta).toEqual({ dipotong: true });
  });

  test("summary panjang dipotong tanpa penanda terbuka", () => {
    const store = open();
    const summary = `${"a".repeat(480)} Bearer abcdefgh12345678 ${"b".repeat(200)}`;
    store.append({ kind: "tool", summary });

    const stored = store.list()[0]!.summary;
    expect(stored.length).toBeLessThanOrEqual(500);
    expect(stored).not.toContain("abcdefgh12345678");
    expect(/\[disembunyikan:[^\]]*$/.test(stored)).toBe(false);
  });

  test("kind tak dikenal diabaikan", () => {
    const store = open();
    store.append({ kind: "ngawur" as never, summary: "abaikan" });
    expect(store.list()).toEqual([]);
    expect(AUDIT_KINDS).toContain("tool");
  });

  test("append tidak melempar setelah close", () => {
    const store = open();
    store.close();
    expect(() =>
      store.append({ kind: "tool", summary: "setelah tutup" }),
    ).not.toThrow();
  });

  test("data bertahan setelah berkas ditutup dan dibuka lagi", () => {
    const dir = tempDir();
    const path = join(dir, "audit.db");
    const first = new SqliteAuditStore(path);
    first.append({ kind: "tool", summary: "tahan" });
    first.close();

    const second = new SqliteAuditStore(path);
    stores.push(second);
    expect(second.list().map((e) => e.summary)).toEqual(["tahan"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("defaultAuditStore", () => {
  test("undefined bila JEJAK_AUDIT=0 atau JEJAK_PERSIST=0", () => {
    expect(defaultAuditStore({ JEJAK_AUDIT: "0" })).toBeUndefined();
    expect(defaultAuditStore({ JEJAK_PERSIST: "0" })).toBeUndefined();
  });

  test("membaca JEJAK_AUDIT_DAYS lewat perilaku prune", () => {
    const now = new Date();
    const old = new Date(now.getTime() - 91 * DAY).toISOString();
    const fresh = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();

    const dir = tempDir();
    const store = defaultAuditStore({ JEJAK_HOME: dir, JEJAK_AUDIT_DAYS: "1" });
    expect(store).toBeDefined();
    stores.push(store!);
    store!.append({ kind: "tool", summary: "tua", ts: old });
    store!.append({ kind: "tool", summary: "baru", ts: fresh });
    expect(store!.prune(now)).toBe(1);
    expect(store!.list().map((e) => e.summary)).toEqual(["baru"]);

    const badDir = tempDir();
    const bad = defaultAuditStore({ JEJAK_HOME: badDir, JEJAK_AUDIT_DAYS: "buruk" });
    stores.push(bad!);
    bad!.append({ kind: "tool", summary: "tua", ts: old });
    bad!.append({ kind: "tool", summary: "baru", ts: fresh });
    expect(bad!.prune(now)).toBe(1);
    expect(bad!.list().map((e) => e.summary)).toEqual(["baru"]);
  });

  test("auditPath memakai JEJAK_HOME", () => {
    expect(auditPath({ JEJAK_HOME: "/tmp/jejak-audit-home" })).toBe(
      "/tmp/jejak-audit-home/audit.db",
    );
  });
});
