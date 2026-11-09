import { describe, expect, test } from "bun:test";
import type {
  AuditEntry,
  AuditEntryInput,
  AuditQuery,
  AuditStore,
  AuditSummary,
} from "../src/server/audit/audit-store";
import { recordAudit } from "../src/server/audit/record";

class FakeStore implements AuditStore {
  readonly entries: AuditEntryInput[] = [];
  throwOnAppend = false;

  append(input: AuditEntryInput): void {
    if (this.throwOnAppend) throw new Error("gagal");
    this.entries.push(input);
  }

  list(_query?: AuditQuery): AuditEntry[] {
    return [];
  }

  summary(_now?: Date): AuditSummary {
    return { days: 7, since: "", total: 0, byKind: {}, redactedSessions: 0 };
  }

  prune(): number {
    return 0;
  }

  close(): void {}
}

const ENTRY: AuditEntryInput = {
  kind: "berkas",
  sessionId: "s_1",
  summary: "Berkas disimpan lewat editor",
  meta: { path: "a.txt", aksi: "simpan" },
};

describe("recordAudit", () => {
  test("no-op tanpa store", () => {
    expect(() => recordAudit(undefined, ENTRY)).not.toThrow();
  });

  test("tidak melempar bila store melempar", () => {
    const store = new FakeStore();
    store.throwOnAppend = true;
    expect(() => recordAudit(store, ENTRY)).not.toThrow();
  });

  test("meneruskan entri apa adanya", () => {
    const store = new FakeStore();
    recordAudit(store, ENTRY);
    expect(store.entries).toEqual([ENTRY]);
  });
});
