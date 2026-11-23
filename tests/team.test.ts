import { describe, expect, test } from "bun:test";
import {
  TEAM_BRIEF_MAX,
  TEAM_DEFAULT_ACTIVE,
  TEAM_DEFAULT_TOTAL,
  TEAM_HARD_MAX_ACTIVE,
  TEAM_HARD_MAX_TOTAL,
  TEAM_ROLE_MAX,
  checkSpawn,
  childModeAllowed,
  clampBrief,
  clampRole,
  isTeamEnabled,
  teamLimits,
  type SpawnCheckInput,
  type TeamLimits,
  type TeamMode,
} from "../src/server/team/team";

const LIMITS: TeamLimits = {
  maxDepth: 1,
  maxActiveChildren: TEAM_DEFAULT_ACTIVE,
  maxTotalChildren: TEAM_DEFAULT_TOTAL,
};

function check(overrides: Partial<SpawnCheckInput> = {}): ReturnType<typeof checkSpawn> {
  return checkSpawn({
    enabled: true,
    parent: { exists: true, isChild: false, permissionMode: "default" },
    children: [],
    limits: LIMITS,
    ...overrides,
  });
}

describe("teamLimits", () => {
  const cases: Array<{ concurrent: number; active: number }> = [
    { concurrent: 1, active: 0 },
    { concurrent: 2, active: 0 },
    { concurrent: 3, active: 1 },
    { concurrent: 4, active: 2 },
    { concurrent: 10, active: 3 },
  ];

  for (const item of cases) {
    test(`maxConcurrent ${item.concurrent} -> ${item.active} anak aktif`, () => {
      const limits = teamLimits({ maxConcurrent: item.concurrent });
      expect(limits.maxActiveChildren).toBe(item.active);
      expect(limits.maxDepth).toBe(1);
      expect(limits.maxTotalChildren).toBe(TEAM_DEFAULT_TOTAL);
    });
  }

  test("override di atas batas keras dipotong", () => {
    const limits = teamLimits({
      maxConcurrent: 10,
      maxActiveChildren: 50,
      maxTotalChildren: 100,
    });
    expect(limits.maxActiveChildren).toBe(TEAM_HARD_MAX_ACTIVE);
    expect(limits.maxTotalChildren).toBe(TEAM_HARD_MAX_TOTAL);
  });

  test("override di bawah bawaan dipakai", () => {
    const limits = teamLimits({
      maxConcurrent: 10,
      maxActiveChildren: 1,
      maxTotalChildren: 2,
    });
    expect(limits.maxActiveChildren).toBe(1);
    expect(limits.maxTotalChildren).toBe(2);
  });

  test("override tetap dibatasi jatah maxConcurrent", () => {
    const limits = teamLimits({ maxConcurrent: 4, maxActiveChildren: 8 });
    expect(limits.maxActiveChildren).toBe(2);
  });

  test("nilai aneh diabaikan dan tak pernah negatif", () => {
    const limits = teamLimits({
      maxConcurrent: 10,
      maxActiveChildren: -5,
      maxTotalChildren: 2.5,
    });
    expect(limits.maxActiveChildren).toBe(TEAM_DEFAULT_ACTIVE);
    expect(limits.maxTotalChildren).toBe(TEAM_DEFAULT_TOTAL);
    expect(teamLimits({ maxConcurrent: 0 }).maxActiveChildren).toBe(0);
    expect(teamLimits({ maxConcurrent: -3 }).maxActiveChildren).toBe(0);
    expect(teamLimits({ maxConcurrent: 10, maxTotalChildren: -1 }).maxTotalChildren).toBe(
      TEAM_DEFAULT_TOTAL,
    );
    expect(teamLimits({ maxConcurrent: 10, maxTotalChildren: 0 }).maxTotalChildren).toBe(0);
  });
});

describe("childModeAllowed", () => {
  const modes: TeamMode[] = ["plan", "default", "acceptEdits", "bypassPermissions"];

  test("bypass untuk anak selalu ditolak", () => {
    for (const parent of modes) {
      expect(childModeAllowed(parent, "bypassPermissions")).toBe(false);
    }
  });

  test("plan selalu boleh", () => {
    for (const parent of modes) {
      expect(childModeAllowed(parent, "plan")).toBe(true);
    }
  });

  test("tabel kelonggaran 4x4", () => {
    const expected: Record<TeamMode, Record<TeamMode, boolean>> = {
      plan: { plan: true, default: false, acceptEdits: false, bypassPermissions: false },
      default: { plan: true, default: true, acceptEdits: false, bypassPermissions: false },
      acceptEdits: { plan: true, default: true, acceptEdits: true, bypassPermissions: false },
      bypassPermissions: {
        plan: true,
        default: true,
        acceptEdits: true,
        bypassPermissions: false,
      },
    };
    for (const parent of modes) {
      for (const child of modes) {
        expect([parent, child, childModeAllowed(parent, child)]).toEqual([
          parent,
          child,
          expected[parent][child],
        ]);
      }
    }
  });
});

describe("checkSpawn", () => {
  test("jalur sukses memakai mode bawaan default", () => {
    expect(check()).toEqual({ ok: true, mode: "default" });
    expect(check({ requestedMode: "plan" })).toEqual({ ok: true, mode: "plan" });
  });

  test("dinonaktifkan menang atas semua pemeriksaan", () => {
    const result = check({
      enabled: false,
      parent: undefined,
      limits: { maxDepth: 1, maxActiveChildren: 0, maxTotalChildren: 0 },
    });
    expect(result).toMatchObject({ ok: false, code: "dinonaktifkan" });
  });

  test("induk tak ada", () => {
    expect(check({ parent: undefined })).toMatchObject({ ok: false, code: "induk-tak-ada" });
    expect(
      check({ parent: { exists: false, isChild: false, permissionMode: "default" } }),
    ).toMatchObject({ ok: false, code: "induk-tak-ada" });
  });

  test("anak tak boleh beranak, sebelum pemeriksaan jumlah", () => {
    const result = check({
      parent: { exists: true, isChild: true, permissionMode: "default" },
      limits: { maxDepth: 1, maxActiveChildren: 0, maxTotalChildren: 0 },
    });
    expect(result).toMatchObject({ ok: false, code: "anak-tak-boleh-beranak" });
  });

  test("penuh-aktif dihitung hanya dari anak berjalan dan menang atas penuh-total", () => {
    const children = [
      { status: "berjalan" as const },
      { status: "berjalan" as const },
      { status: "selesai" as const },
    ];
    const result = check({
      children,
      limits: { maxDepth: 1, maxActiveChildren: 2, maxTotalChildren: 2 },
    });
    expect(result).toMatchObject({ ok: false, code: "penuh-aktif" });
    expect((result as { message: string }).message).toContain("tunggu");
  });

  test("anak selesai tidak menghabiskan jatah aktif", () => {
    const result = check({
      children: [{ status: "selesai" }, { status: "gagal" }, { status: "dibatalkan" }],
      limits: { maxDepth: 1, maxActiveChildren: 1, maxTotalChildren: 10 },
    });
    expect(result).toEqual({ ok: true, mode: "default" });
  });

  test("penuh-total", () => {
    const result = check({
      children: [{ status: "selesai" }, { status: "selesai" }],
      limits: { maxDepth: 1, maxActiveChildren: 2, maxTotalChildren: 2 },
    });
    expect(result).toMatchObject({ ok: false, code: "penuh-total" });
  });

  test("mode lebih longgar ditolak", () => {
    expect(check({ requestedMode: "acceptEdits" })).toMatchObject({
      ok: false,
      code: "mode-lebih-longgar",
    });
    expect(
      check({
        parent: { exists: true, isChild: false, permissionMode: "acceptEdits" },
        requestedMode: "bypassPermissions",
      }),
    ).toMatchObject({ ok: false, code: "mode-lebih-longgar" });
    expect(
      check({
        parent: { exists: true, isChild: false, permissionMode: "acceptEdits" },
        requestedMode: "plan",
      }),
    ).toEqual({ ok: true, mode: "plan" });
  });
});

describe("clampRole", () => {
  test("memangkas spasi dan memotong batas", () => {
    expect(clampRole("  pelaksana  ")).toBe("pelaksana");
    expect(clampRole("x".repeat(TEAM_ROLE_MAX + 10))).toBe("x".repeat(TEAM_ROLE_MAX));
  });

  test("kosong atau bukan teks menjadi undefined", () => {
    expect(clampRole("   ")).toBeUndefined();
    expect(clampRole("")).toBeUndefined();
    expect(clampRole(undefined)).toBeUndefined();
    expect(clampRole(42)).toBeUndefined();
  });
});

describe("clampBrief", () => {
  test("dipotong di batas brief", () => {
    expect(clampBrief("pendek")).toBe("pendek");
    const panjang = "a".repeat(TEAM_BRIEF_MAX + 100);
    expect(clampBrief(panjang)).toHaveLength(TEAM_BRIEF_MAX);
  });
});

describe("isTeamEnabled", () => {
  test("hanya JEJAK_TEAM=0 yang mematikan", () => {
    expect(isTeamEnabled({})).toBe(true);
    expect(isTeamEnabled({ JEJAK_TEAM: "1" })).toBe(true);
    expect(isTeamEnabled({ JEJAK_TEAM: "" })).toBe(true);
    expect(isTeamEnabled({ JEJAK_TEAM: " 0 " })).toBe(false);
    expect(isTeamEnabled({ JEJAK_TEAM: "0" })).toBe(false);
  });
});
