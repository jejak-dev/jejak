import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "../src/server/sessions/session-manager";
import {
  SESSION_TITLE_MAX,
  canMutate,
  filterSessions,
  splitArchived,
  validateTitle,
} from "../src/client/lib/sessions";

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Perbaiki login",
    prompt: "Halo",
    cwd: "/tmp/proyek",
    profileId: "lokal",
    permissionMode: "default",
    status: "selesai",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    eventCount: 0,
    pendingPermissions: 0,
    queued: 0,
    ...overrides,
  };
}

describe("filterSessions", () => {
  test("query kosong mengembalikan sesi tidak terarsip", () => {
    const active = session({ id: "a" });
    const archived = session({ id: "b", archivedAt: "2026-02-01T00:00:00.000Z" });

    expect(filterSessions([active, archived], "")).toEqual([active]);
  });

  test("showArchived menampilkan sesi terarsip", () => {
    const archived = session({ id: "b", archivedAt: "2026-02-01T00:00:00.000Z" });

    expect(filterSessions([archived], "", true)).toEqual([archived]);
  });

  test("query cocok pada judul tanpa peka huruf", () => {
    const match = session({ id: "a", title: "Perbaiki LOGIN" });
    const other = session({ id: "b", title: "Rapikan dokumen" });

    expect(filterSessions([match, other], "login")).toEqual([match]);
  });

  test("query cocok pada cwd", () => {
    const match = session({ id: "a", cwd: "/tmp/kantor/api" });

    expect(filterSessions([match], "KANTOR")).toEqual([match]);
  });

  test("query cocok pada workspaceName", () => {
    const match = session({ id: "a", workspaceName: "Workspace Kantor" });
    const other = session({ id: "b" });

    expect(filterSessions([match, other], "workspace kantor")).toEqual([match]);
  });

  test("query tidak menampilkan sesi terarsip walau cocok", () => {
    const archived = session({
      id: "b",
      title: "Perbaiki login",
      archivedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(filterSessions([archived], "perbaiki")).toEqual([]);
  });

  test("spasi di tepi query diabaikan", () => {
    const match = session({ id: "a", title: "Rapikan" });

    expect(filterSessions([match], "  rapikan  ")).toEqual([match]);
  });
});

describe("splitArchived", () => {
  test("memisahkan sesi aktif dan terarsip dengan urutan tetap", () => {
    const a = session({ id: "a" });
    const b = session({ id: "b", archivedAt: "2026-02-01T00:00:00.000Z" });
    const c = session({ id: "c" });

    expect(splitArchived([a, b, c])).toEqual({ active: [a, c], archived: [b] });
  });

  test("semua aktif menghasilkan archived kosong", () => {
    const a = session({ id: "a" });

    expect(splitArchived([a])).toEqual({ active: [a], archived: [] });
  });
});

describe("validateTitle", () => {
  test("judul sah tidak menghasilkan galat", () => {
    expect(validateTitle("Perbaiki login")).toBeUndefined();
  });

  test("judul kosong atau hanya spasi ditolak", () => {
    expect(validateTitle("")).toBe(`Judul harus 1..${SESSION_TITLE_MAX} karakter.`);
    expect(validateTitle("   ")).toBe(`Judul harus 1..${SESSION_TITLE_MAX} karakter.`);
  });

  test("batas 120 karakter", () => {
    expect(validateTitle("a".repeat(SESSION_TITLE_MAX))).toBeUndefined();
    expect(validateTitle("a".repeat(SESSION_TITLE_MAX + 1))).toBe(
      `Judul harus 1..${SESSION_TITLE_MAX} karakter.`,
    );
  });

  test("karakter kontrol ditolak", () => {
    expect(validateTitle("baris\nbaru")).toBe("Judul tidak boleh memuat karakter kontrol.");
    expect(validateTitle("tab\tjudul")).toBe("Judul tidak boleh memuat karakter kontrol.");
  });
});

describe("canMutate", () => {
  test("sesi berjalan tidak boleh diarsip atau dihapus", () => {
    expect(canMutate(session({ status: "berjalan" }))).toBe(false);
  });

  test("sesi selesai, gagal, dan dibatalkan boleh", () => {
    expect(canMutate(session({ status: "selesai" }))).toBe(true);
    expect(canMutate(session({ status: "gagal" }))).toBe(true);
    expect(canMutate(session({ status: "dibatalkan" }))).toBe(true);
  });
});
