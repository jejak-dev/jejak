import { afterEach, describe, expect, test } from "bun:test";
import type { SessionInfo } from "../src/server/sessions/session-manager";
import { detectEvents, notificationSupport, parseNotifyPrefs } from "../src/client/lib/notify";

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    title: "Perbaiki login",
    prompt: "Halo",
    cwd: "/tmp/proyek",
    profileId: "lokal",
    permissionMode: "default",
    status: "berjalan",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    eventCount: 0,
    pendingPermissions: 0,
    queued: 0,
    ...overrides,
  };
}

const ARCHIVED = "2026-02-01T00:00:00.000Z";

describe("parseNotifyPrefs", () => {
  test("null jatuh ke bawaan mati", () => {
    expect(parseNotifyPrefs(null)).toEqual({ enabled: false, sound: false });
  });

  test("JSON rusak jatuh ke bawaan", () => {
    expect(parseNotifyPrefs("{rusak")).toEqual({ enabled: false, sound: false });
  });

  test("bentuk asing jatuh ke bawaan", () => {
    expect(parseNotifyPrefs("42")).toEqual({ enabled: false, sound: false });
    expect(parseNotifyPrefs("[]")).toEqual({ enabled: false, sound: false });
    expect(parseNotifyPrefs('{"enabled":"ya","sound":1}')).toEqual({ enabled: false, sound: false });
  });

  test("bentuk valid dibaca", () => {
    expect(parseNotifyPrefs('{"enabled":true,"sound":true}')).toEqual({ enabled: true, sound: true });
    expect(parseNotifyPrefs('{"enabled":true}')).toEqual({ enabled: true, sound: false });
  });
});

describe("detectEvents", () => {
  test("tanpa daftar sebelumnya tidak ada peristiwa", () => {
    expect(detectEvents(undefined, [session({ pendingPermissions: 2 })])).toEqual([]);
  });

  test("izin naik 0->1 dan 1->2 memicu", () => {
    const prev = [session({ pendingPermissions: 0 })];
    expect(detectEvents(prev, [session({ pendingPermissions: 1 })])).toEqual([
      { sessionId: "s1", title: "Perbaiki login", kind: "izin" },
    ]);
    expect(detectEvents([session({ pendingPermissions: 1 })], [session({ pendingPermissions: 2 })])).toEqual([
      { sessionId: "s1", title: "Perbaiki login", kind: "izin" },
    ]);
  });

  test("izin turun tidak memicu", () => {
    expect(detectEvents([session({ pendingPermissions: 2 })], [session({ pendingPermissions: 0 })])).toEqual([]);
  });

  test("berjalan -> selesai memicu", () => {
    expect(detectEvents([session({ status: "berjalan" })], [session({ status: "selesai" })])).toEqual([
      { sessionId: "s1", title: "Perbaiki login", kind: "selesai" },
    ]);
  });

  test("berjalan -> gagal memicu", () => {
    expect(detectEvents([session({ status: "berjalan" })], [session({ status: "gagal" })])).toEqual([
      { sessionId: "s1", title: "Perbaiki login", kind: "gagal" },
    ]);
  });

  test("berjalan -> dibatalkan tidak memicu", () => {
    expect(detectEvents([session({ status: "berjalan" })], [session({ status: "dibatalkan" })])).toEqual([]);
  });

  test("selesai -> selesai tidak memicu", () => {
    expect(detectEvents([session({ status: "selesai" })], [session({ status: "selesai" })])).toEqual([]);
  });

  test("sesi baru tidak memicu", () => {
    const baru = session({ id: "s2", pendingPermissions: 1, status: "selesai" });
    expect(detectEvents([session()], [session(), baru])).toEqual([]);
  });

  test("sesi arsip diabaikan", () => {
    const prev = [session({ archivedAt: ARCHIVED, status: "berjalan" })];
    const next = [session({ archivedAt: ARCHIVED, status: "selesai", pendingPermissions: 1 })];
    expect(detectEvents(prev, next)).toEqual([]);
  });

  test("beberapa sesi sekaligus", () => {
    const prev = [
      session({ id: "a", status: "berjalan" }),
      session({ id: "b", status: "berjalan", pendingPermissions: 0 }),
    ];
    const next = [
      session({ id: "a", status: "selesai" }),
      session({ id: "b", status: "berjalan", pendingPermissions: 1 }),
    ];
    expect(detectEvents(prev, next)).toEqual([
      { sessionId: "a", title: "Perbaiki login", kind: "selesai" },
      { sessionId: "b", title: "Perbaiki login", kind: "izin" },
    ]);
  });
});

describe("notificationSupport", () => {
  const original = globalThis.Notification;

  afterEach(() => {
    globalThis.Notification = original;
  });

  test("tanpa Notification global", () => {
    // @ts-expect-error sengaja menghapus global untuk tes.
    delete globalThis.Notification;
    expect(notificationSupport()).toBe("tidak-ada");
  });

  test("izin belum diminta", () => {
    globalThis.Notification = { permission: "default" } as unknown as typeof Notification;
    expect(notificationSupport()).toBe("belum");
  });

  test("ditolak", () => {
    globalThis.Notification = { permission: "denied" } as unknown as typeof Notification;
    expect(notificationSupport()).toBe("ditolak");
  });

  test("diizinkan", () => {
    globalThis.Notification = { permission: "granted" } as unknown as typeof Notification;
    expect(notificationSupport()).toBe("diizinkan");
  });
});
