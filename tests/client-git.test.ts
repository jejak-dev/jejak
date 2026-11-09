import { describe, expect, test } from "bun:test";
import type { GitStatus } from "../src/server/git/git-read";
import {
  aheadBehindLabel,
  branchLabel,
  canWrite,
  commitSubject,
  fileStatusLabel,
  groupStatus,
  relativeTime,
  shouldRefreshGit,
  stateLabel,
  totalFiles,
  validateMessage,
  type GitMarker,
} from "../src/client/lib/git";

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: true,
    detached: false,
    state: "normal",
    staged: [],
    unstaged: [],
    untracked: [],
    truncated: false,
    ...overrides,
  };
}

describe("fileStatusLabel", () => {
  test("huruf dan teks lengkap tiap status", () => {
    expect(fileStatusLabel("ditambah")).toEqual({ short: "A", label: "Ditambah" });
    expect(fileStatusLabel("diubah")).toEqual({ short: "M", label: "Diubah" });
    expect(fileStatusLabel("dihapus")).toEqual({ short: "D", label: "Dihapus" });
    expect(fileStatusLabel("diganti")).toEqual({ short: "R", label: "Diganti" });
    expect(fileStatusLabel("disalin")).toEqual({ short: "C", label: "Disalin" });
    expect(fileStatusLabel("konflik").short).toBe("!");
    expect(fileStatusLabel("tipe-berubah").short).toBe("T");
  });
});

describe("groupStatus", () => {
  test("tiga bagian dengan jumlah dan tanda konflik", () => {
    const groups = groupStatus(
      status({
        staged: [{ path: "a.ts", status: "ditambah" }],
        unstaged: [
          { path: "b.ts", status: "diubah" },
          { path: "c.ts", status: "konflik" },
        ],
        untracked: ["d.ts"],
      }),
    );

    expect(groups.map((group) => group.id)).toEqual(["staged", "unstaged", "untracked"]);
    expect(groups.map((group) => group.count)).toEqual([1, 2, 1]);
    expect(groups[0]?.files[0]).toMatchObject({ path: "a.ts", short: "A", conflict: false });
    expect(groups[1]?.files[1]).toMatchObject({ path: "c.ts", short: "!", conflict: true });
    expect(groups[2]?.files[0]).toMatchObject({ path: "d.ts", short: "?", conflict: false });
  });

  test("status kosong menghasilkan tiga bagian kosong", () => {
    const groups = groupStatus(status());
    expect(groups).toHaveLength(3);
    for (const group of groups) expect(group.count).toBe(0);
  });

  test("rename membawa path asal", () => {
    const groups = groupStatus(status({ staged: [{ path: "b.ts", status: "diganti", from: "a.ts" }] }));
    expect(groups[0]?.files[0]).toMatchObject({ path: "b.ts", from: "a.ts", short: "R" });
  });
});

describe("totalFiles", () => {
  test("jumlah staged + unstaged + untracked", () => {
    const value = status({
      staged: [{ path: "a", status: "ditambah" }],
      unstaged: [{ path: "b", status: "diubah" }],
      untracked: ["c", "d"],
    });
    expect(totalFiles(value)).toBe(4);
  });
});

describe("canWrite", () => {
  const base = { status: "selesai", state: "normal" as const, writeDisabled: false };

  test("boleh saat normal, sesi diam, penulisan aktif", () => {
    expect(canWrite(base)).toEqual({ allowed: true });
  });

  test("sesi berjalan ditolak dengan alasan", () => {
    const result = canWrite({ ...base, status: "berjalan" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("Sesi sedang berjalan; tunggu selesai.");
  });

  test("state merge/rebase ditolak", () => {
    expect(canWrite({ ...base, state: "merge" })).toEqual({
      allowed: false,
      reason: "Sedang ada merge; selesaikan di terminal.",
    });
    expect(canWrite({ ...base, state: "rebase" }).allowed).toBe(false);
  });

  test("penulisan dimatikan ditolak", () => {
    expect(canWrite({ ...base, writeDisabled: true })).toEqual({
      allowed: false,
      reason: "Penulisan git dimatikan.",
    });
  });
});

describe("validateMessage", () => {
  test("trim lalu 1..2000 karakter", () => {
    expect(validateMessage("  ").ok).toBe(false);
    expect(validateMessage("halo").ok).toBe(true);
    expect(validateMessage("x".repeat(2000)).ok).toBe(true);
    expect(validateMessage("x".repeat(2001)).ok).toBe(false);
  });
});

describe("commitSubject", () => {
  test("baris pertama dan pemotongan", () => {
    expect(commitSubject("perbaiki bug\n\ndetail")).toBe("perbaiki bug");
    expect(commitSubject("a".repeat(100)).length).toBe(72);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");

  test("rentang kecil sampai hari", () => {
    expect(relativeTime("2026-03-01T11:59:50.000Z", now)).toBe("baru saja");
    expect(relativeTime("2026-03-01T11:55:00.000Z", now)).toBe("5 mnt lalu");
    expect(relativeTime("2026-03-01T09:00:00.000Z", now)).toBe("3 jam lalu");
    expect(relativeTime("2026-02-27T12:00:00.000Z", now)).toBe("2 hari lalu");
  });

  test("lebih dari 30 hari memakai tanggal", () => {
    const text = relativeTime("2025-12-01T12:00:00.000Z", now);
    expect(text).not.toContain("lalu");
    expect(text).toContain("2025");
  });

  test("tanggal rusak menghasilkan string kosong", () => {
    expect(relativeTime("bukan tanggal", now)).toBe("");
  });
});

describe("aheadBehindLabel", () => {
  test("dengan upstream", () => {
    expect(aheadBehindLabel({ upstream: "origin/main", ahead: 2, behind: 1 })).toBe("↑2 ↓1");
    expect(aheadBehindLabel({ upstream: "origin/main", ahead: 0, behind: 0 })).toBe("");
    expect(aheadBehindLabel({ upstream: "origin/main", ahead: 3 })).toBe("↑3");
  });

  test("tanpa upstream kosong", () => {
    expect(aheadBehindLabel({ ahead: 2, behind: 1 })).toBe("");
  });
});

describe("branchLabel dan stateLabel", () => {
  test("cabang biasa dan HEAD terlepas", () => {
    expect(branchLabel({ branch: "main", detached: false })).toBe("main");
    expect(
      branchLabel({ detached: true, head: "abcdef1234567890", branch: undefined }),
    ).toBe("HEAD terlepas abcdef1");
  });

  test("state hanya tampil saat bukan normal", () => {
    expect(stateLabel("normal")).toBe(undefined);
    expect(stateLabel("cherry-pick")).toBe("cherry-pick");
  });
});

describe("shouldRefreshGit", () => {
  const trigger = { open: true, eventCount: 4, status: "selesai", refreshToken: 0 };

  test("panel tertutup tidak menyegarkan", () => {
    expect(shouldRefreshGit({ ...trigger, open: false }, undefined)).toBe(false);
  });

  test("pemuatan pertama berjalan", () => {
    expect(shouldRefreshGit(trigger, undefined)).toBe(true);
  });

  test("event dan refresh memicu; status diam tidak", () => {
    const marker: GitMarker = { eventCount: 4, status: "selesai", refreshToken: 0 };
    expect(shouldRefreshGit(trigger, marker)).toBe(false);
    expect(shouldRefreshGit({ ...trigger, eventCount: 5 }, marker)).toBe(true);
    expect(shouldRefreshGit({ ...trigger, refreshToken: 1 }, marker)).toBe(true);
    expect(shouldRefreshGit({ ...trigger, status: "berjalan" }, marker)).toBe(false);
    // Arti `trigger.status` adalah status sesi saat ini; berjalan dari berjalan tetap diam.
  });

  test("selesai dari berjalan memicu muat ulang", () => {
    const marker: GitMarker = { eventCount: 4, status: "berjalan", refreshToken: 0 };
    expect(shouldRefreshGit(trigger, marker)).toBe(true);
  });
});
