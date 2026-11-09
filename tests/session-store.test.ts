import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SqliteSessionStore, defaultSessionStore, sessionsPath } from "../src/server/sessions/session-store";
import type { SequencedEvent, SessionInfo } from "../src/server/sessions/session-manager";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-session-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function info(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  const createdAt = overrides.createdAt ?? "2026-01-01T00:00:00.000Z";
  return {
    id,
    title: `Judul ${id}`,
    prompt: `Prompt ${id}`,
    cwd: "/tmp",
    profileId: "lokal",
    model: "model-uji",
    permissionMode: "default",
    status: "selesai",
    createdAt,
    updatedAt: createdAt,
    eventCount: 2,
    pendingPermissions: 0,
    queued: 0,
    ...overrides,
  };
}

function event(seq: number, text: string): SequencedEvent {
  return { seq, event: { type: "text", text } };
}

describe("SqliteSessionStore", () => {
  test("round-trip sesi dan event", () => {
    const store = new SqliteSessionStore(":memory:");
    store.saveSession(info("s_1", { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, estimatedCostUsd: 0.5 } }), "sdk-1");
    store.appendEvent("s_1", event(1, "satu"));
    store.appendEvent("s_1", event(2, "dua"));

    const sessions = store.loadSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.info.id).toBe("s_1");
    expect(sessions[0]?.info.usage?.inputTokens).toBe(10);
    expect(sessions[0]?.sdkSessionId).toBe("sdk-1");
    expect(sessions[0]?.nextSeq).toBe(3);

    const events = store.loadEvents("s_1");
    expect(events).toEqual([event(1, "satu"), event(2, "dua")]);
    store.close();
  });

  test("loadSessions urut createdAt naik dan loadEvents urut seq naik", () => {
    const store = new SqliteSessionStore(":memory:");
    store.saveSession(info("s_lama", { createdAt: "2026-01-01T00:00:00.000Z" }), undefined);
    store.saveSession(info("s_baru", { createdAt: "2026-02-01T00:00:00.000Z" }), undefined);
    store.appendEvent("s_lama", event(3, "c"));
    store.appendEvent("s_lama", event(1, "a"));
    store.appendEvent("s_lama", event(2, "b"));

    expect(store.loadSessions().map((item) => item.info.id)).toEqual(["s_lama", "s_baru"]);
    expect(store.loadEvents("s_lama").map((item) => item.seq)).toEqual([1, 2, 3]);
    store.close();
  });

  test("trimEvents menghapus seq di bawah batas", () => {
    const store = new SqliteSessionStore(":memory:");
    store.saveSession(info("s_1"), undefined);
    for (let seq = 1; seq <= 5; seq += 1) {
      store.appendEvent("s_1", event(seq, `e${seq}`));
    }

    store.trimEvents("s_1", 3);
    expect(store.loadEvents("s_1").map((item) => item.seq)).toEqual([3, 4, 5]);
    store.close();
  });

  test("deleteSession menghapus sesi dan event-nya", () => {
    const store = new SqliteSessionStore(":memory:");
    store.saveSession(info("s_1"), undefined);
    store.appendEvent("s_1", event(1, "a"));
    store.deleteSession("s_1");

    expect(store.loadSessions()).toHaveLength(0);
    expect(store.loadEvents("s_1")).toHaveLength(0);
    store.close();
  });

  test("saveSession adalah upsert dan tidak menurunkan nextSeq", () => {
    const store = new SqliteSessionStore(":memory:");
    store.saveSession(info("s_1", { title: "Lama" }), undefined);
    store.appendEvent("s_1", event(5, "a"));
    store.saveSession(info("s_1", { title: "Baru", eventCount: 1 }), "sdk-9");

    const sessions = store.loadSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.info.title).toBe("Baru");
    expect(sessions[0]?.sdkSessionId).toBe("sdk-9");
    expect(sessions[0]?.nextSeq).toBe(6);
    store.close();
  });

  test("worktree bertahan lewat penyimpanan ulang", () => {
    const store = new SqliteSessionStore(":memory:");
    const worktree = {
      repoRoot: "/tmp/repo",
      path: "/tmp/home/worktrees/s_1",
      branch: "jejak/uji-s_1",
      baseCommit: "a".repeat(40),
      subdir: "paket",
      removed: true,
    };
    store.saveSession(info("s_1", { cwd: worktree.path, worktree }), undefined);
    const loaded = store.loadSessions()[0]?.info.worktree;
    expect(loaded).toEqual(worktree);
    store.close();
  });

  test("workspaceId dan workspaceName bertahan lewat penyimpanan ulang", () => {
    const store = new SqliteSessionStore(":memory:");
    store.saveSession(info("s_1", { workspaceId: "ws-1", workspaceName: "Kantor" }), undefined);
    store.saveSession(info("s_1", { workspaceId: "ws-1", workspaceName: "Kantor", title: "Ubah" }), undefined);

    const sessions = store.loadSessions();
    expect(sessions[0]?.info.workspaceId).toBe("ws-1");
    expect(sessions[0]?.info.workspaceName).toBe("Kantor");
    expect(sessions[0]?.info.title).toBe("Ubah");
    store.close();
  });

  test("archivedAt bertahan lewat penyimpanan ulang dan bisa dihapus", () => {
    const store = new SqliteSessionStore(":memory:");
    store.saveSession(info("s_1", { archivedAt: "2026-03-01T00:00:00.000Z" }), undefined);

    const archived = store.loadSessions();
    expect(archived[0]?.info.archivedAt).toBe("2026-03-01T00:00:00.000Z");

    const { archivedAt: _dibuang, ...tanpaArsip } = archived[0]!.info;
    store.saveSession(tanpaArsip as SessionInfo, undefined);
    expect(store.loadSessions()[0]?.info.archivedAt).toBeUndefined();

    // Sesi lama yang ditulis sebelum field ini ada tetap termuat.
    store.saveSession(info("s_lama"), undefined);
    const lama = store.loadSessions().find((item) => item.info.id === "s_lama");
    expect(lama?.info.archivedAt).toBeUndefined();
    expect(lama?.info.title).toBe("Judul s_lama");
    store.close();
  });

  test("sesi lama tanpa field workspace tetap termuat", () => {
    const store = new SqliteSessionStore(":memory:");
    store.saveSession(info("s_lama"), undefined);

    const sessions = store.loadSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.info.workspaceId).toBeUndefined();
    expect(sessions[0]?.info.workspaceName).toBeUndefined();
    store.close();
  });

  test("baris JSON rusak dilewati tanpa menggagalkan seluruhnya", async () => {
    const path = join(dir, "sessions.db");
    const store = new SqliteSessionStore(path);
    store.saveSession(info("s_1"), undefined);
    store.saveSession(info("s_2"), undefined);
    store.appendEvent("s_1", event(1, "a"));
    store.appendEvent("s_1", event(2, "b"));
    store.close();

    const raw = new Database(path);
    raw.run("UPDATE sessions SET data = '{rusak' WHERE id = 's_1'");
    raw.run("UPDATE events SET data = 'bukan json' WHERE session_id = 's_1' AND seq = 1");
    raw.close();

    const reopened = new SqliteSessionStore(path);
    expect(reopened.loadSessions().map((item) => item.info.id)).toEqual(["s_2"]);
    expect(reopened.loadEvents("s_1").map((item) => item.seq)).toEqual([2]);
    reopened.close();
  });

  test("versi skema lebih baru ditolak tanpa menimpa", async () => {
    const path = join(dir, "sessions.db");
    const store = new SqliteSessionStore(path);
    store.close();

    const raw = new Database(path);
    raw.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    raw.close();

    expect(() => new SqliteSessionStore(path)).toThrow(/lebih baru/);
    const check = new Database(path);
    expect((check.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe("999");
    check.close();
  });

  test("berkas 0600 dan direktori 0700 untuk jalur berkas", async () => {
    const target = join(dir, "home");
    await mkdir(target, { recursive: true, mode: 0o755 });
    await chmod(target, 0o755);
    const path = join(target, "nested", "sessions.db");

    const store = new SqliteSessionStore(path);
    store.saveSession(info("s_1"), undefined);
    store.appendEvent("s_1", event(1, "a"));

    const fileInfo = await stat(path);
    const dirInfo = await stat(join(target, "nested"));
    expect(fileInfo.mode & 0o777).toBe(0o600);
    expect(dirInfo.mode & 0o777).toBe(0o700);
    store.close();
  });

  test("defaultSessionStore menghormati JEJAK_PERSIST dan JEJAK_HOME", async () => {
    expect(defaultSessionStore({ JEJAK_PERSIST: "0" })).toBeUndefined();

    const home = join(dir, "home");
    const store = defaultSessionStore({ JEJAK_HOME: home });
    expect(store).toBeDefined();
    store?.close();

    expect(sessionsPath({ JEJAK_HOME: home })).toBe(join(home, "sessions.db"));
    const fileInfo = await stat(join(home, "sessions.db"));
    expect(fileInfo.mode & 0o777).toBe(0o600);
  });

  test("berkas tidak dibuka ulang saat JEJAK_PERSIST=0", async () => {
    const home = join(dir, "kosong");
    expect(defaultSessionStore({ JEJAK_HOME: home, JEJAK_PERSIST: "0" })).toBeUndefined();
    await expect(readFile(join(home, "sessions.db"))).rejects.toThrow();
  });
});

describe("createApp tanpa store", () => {
  test("createApp() tanpa opsi tidak membuat berkas di JEJAK_HOME", async () => {
    const { createApp } = await import("../src/server/index");
    const home = join(dir, "home-tanpa-opsi");
    await createApp({ env: { JEJAK_HOME: home } });
    await expect(stat(join(home, "sessions.db"))).rejects.toThrow();
  });
});
