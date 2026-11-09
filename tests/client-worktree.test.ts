import { describe, expect, test } from "bun:test";
import type { WorktreeInfo, WorktreeInspect } from "../src/server/git/worktree-service";
import {
  canSendToSession,
  dirtyWarning,
  mergeCommands,
  removeConfirmText,
  shellQuote,
  worktreeBadge,
} from "../src/client/lib/worktree";

function info(patch: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    repoRoot: "/tmp/repo",
    path: "/tmp/home/worktrees/s1",
    branch: "jejak/tugas-s1",
    baseCommit: "a".repeat(40),
    ...patch,
  };
}

function inspect(patch: Partial<WorktreeInspect> = {}): WorktreeInspect {
  return { exists: true, dirtyFiles: 0, commitsAhead: 0, branchExists: true, ...patch };
}

describe("worktreeBadge", () => {
  test("undefined untuk sesi tanpa worktree", () => {
    expect(worktreeBadge({})).toBeUndefined();
  });

  test("label membuang awalan jejak/ dan title memuat cabang penuh + path", () => {
    const badge = worktreeBadge({ worktree: info() });
    expect(badge?.label).toBe("tugas-s1");
    expect(badge?.tone).toBe("");
    expect(badge?.title).toContain("jejak/tugas-s1");
    expect(badge?.title).toContain("/tmp/home/worktrees/s1");
  });

  test("tone warn dan label (folder hilang) saat missing", () => {
    const badge = worktreeBadge({ worktree: info({ missing: true }) });
    expect(badge?.label).toBe("tugas-s1 (folder hilang)");
    expect(badge?.tone).toBe("warn");
  });

  test("tone bad dan label (dihapus) saat removed, mengalahkan missing", () => {
    const badge = worktreeBadge({ worktree: info({ removed: true, missing: true }) });
    expect(badge?.label).toBe("tugas-s1 (dihapus)");
    expect(badge?.tone).toBe("bad");
  });

  test("label panjang dipotong 28 karakter", () => {
    const branch = `jejak/${"x".repeat(50)}`;
    const badge = worktreeBadge({ worktree: info({ branch }) });
    expect(badge?.label.length).toBe(28);
    expect(badge?.label.endsWith("…")).toBe(true);
  });

  test("cabang tanpa awalan jejak/ dipakai apa adanya", () => {
    expect(worktreeBadge({ worktree: info({ branch: "fitur/a" }) })?.label).toBe("fitur/a");
  });
});

describe("shellQuote", () => {
  test("nilai aman tidak dibungkus", () => {
    expect(shellQuote("/tmp/repo")).toBe("/tmp/repo");
    expect(shellQuote("jejak/tugas-s1")).toBe("jejak/tugas-s1");
  });

  test("spasi dan karakter khusus dibungkus petik tunggal", () => {
    expect(shellQuote("/tmp/dir a")).toBe("'/tmp/dir a'");
    expect(shellQuote("/tmp/a&b")).toBe("'/tmp/a&b'");
  });

  test("petik tunggal di dalam dilepas dengan aman", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("/tmp/o'brien x")).toBe("'/tmp/o'\\''brien x'");
  });

  test("string kosong dibungkus", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("mergeCommands", () => {
  test("baris berurutan: cd, merge, cherry-pick rentang", () => {
    const commands = mergeCommands(info());
    expect(commands).toEqual([
      "cd /tmp/repo",
      "git merge jejak/tugas-s1",
      `git cherry-pick ${"a".repeat(40)}..jejak/tugas-s1`,
    ]);
  });

  test("path dan cabang dengan karakter khusus dikutip", () => {
    const commands = mergeCommands(
      info({ repoRoot: "/tmp/dir a", branch: "jejak/o'brien" }),
    );
    expect(commands[0]).toBe("cd '/tmp/dir a'");
    expect(commands[1]).toBe("git merge 'jejak/o'\\''brien'");
    expect(commands[2]).toBe(`git cherry-pick ${"a".repeat(40)}..'jejak/o'\\''brien'`);
  });
});

describe("removeConfirmText", () => {
  test("bersih: konfirmasi sederhana, cabang tetap ada", () => {
    const text = removeConfirmText(inspect());
    expect(text).toContain("Cabang jejak tetap ada");
    expect(text).not.toContain("MENGHILANGKAN");
  });

  test("kotor: menyebut jumlah berkas, commit, dan peringatan kehilangan perubahan", () => {
    const text = removeConfirmText(inspect({ dirtyFiles: 3, commitsAhead: 2 }));
    expect(text).toContain("3 berkas berubah");
    expect(text).toContain("2 commit belum digabung");
    expect(text).toContain("MENGHILANGKAN");
    expect(text).toContain("jejak/");
  });

  test("hanya commit menunggu juga dianggap kotor", () => {
    expect(removeConfirmText(inspect({ commitsAhead: 1 }))).toContain("MENGHILANGKAN");
  });
});

describe("canSendToSession", () => {
  test("sesi tanpa worktree selalu boleh", () => {
    expect(canSendToSession({})).toEqual({ allowed: true });
  });

  test("worktree aktif boleh", () => {
    expect(canSendToSession({ worktree: info() })).toEqual({ allowed: true });
  });

  test("worktree dihapus menolak dengan alasan", () => {
    expect(canSendToSession({ worktree: info({ removed: true }) })).toEqual({
      allowed: false,
      reason: "Worktree sesi sudah dihapus.",
    });
  });

  test("folder hilang menolak dengan alasan", () => {
    expect(canSendToSession({ worktree: info({ missing: true }) })).toEqual({
      allowed: false,
      reason: "Folder worktree hilang; pulihkan dulu.",
    });
  });
});

describe("dirtyWarning", () => {
  test("teks peringatan hanya saat true", () => {
    expect(dirtyWarning(true)).toBe(
      "Perubahan yang belum di-commit di folder asli tidak ikut ke worktree.",
    );
    expect(dirtyWarning(false)).toBeUndefined();
    expect(dirtyWarning(undefined)).toBeUndefined();
  });
});
