import { describe, expect, test } from "bun:test";
import {
  ROLE_PRESETS,
  applyRolePreset,
  findRolePreset,
} from "../src/server/team/roles";

describe("findRolePreset", () => {
  test("mencocokkan tanpa peka huruf besar dan setelah trim", () => {
    expect(findRolePreset("PENELITI")?.name).toBe("peneliti");
    expect(findRolePreset("  Pengulas \t")?.name).toBe("pengulas");
    expect(findRolePreset("pelaksana")?.name).toBe("pelaksana");
  });

  test("label tak dikenal, kosong, dan undefined tidak cocok", () => {
    expect(findRolePreset("lain")).toBeUndefined();
    expect(findRolePreset("")).toBeUndefined();
    expect(findRolePreset("   ")).toBeUndefined();
    expect(findRolePreset(undefined)).toBeUndefined();
  });

  test("prefix tiap preset pendek (<= 500 karakter)", () => {
    for (const preset of ROLE_PRESETS) {
      expect(preset.briefPrefix.length).toBeGreaterThan(0);
      expect(preset.briefPrefix.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("applyRolePreset", () => {
  test("peneliti memakai mode plan dan templat di depan", () => {
    const hasil = applyRolePreset({ role: "peneliti", prompt: "cari bug di a.ts" });
    expect(hasil.mode).toBe("plan");
    expect(hasil.prompt.startsWith(findRolePreset("peneliti")?.briefPrefix ?? "?")).toBe(true);
    expect(hasil.prompt).toContain("Tugas:\ncari bug di a.ts");
    expect(hasil.prompt.endsWith("cari bug di a.ts")).toBe(true);
  });

  test("pengulas memakai mode plan dan templat di depan", () => {
    const hasil = applyRolePreset({ role: "pengulas", prompt: "nilai diff ini" });
    expect(hasil.mode).toBe("plan");
    expect(hasil.prompt.startsWith(findRolePreset("pengulas")?.briefPrefix ?? "?")).toBe(true);
    expect(hasil.prompt.endsWith("nilai diff ini")).toBe(true);
  });

  test("pelaksana tanpa mode bawaan dan prompt asli utuh di akhir", () => {
    const hasil = applyRolePreset({ role: "pelaksana", prompt: "perbaiki tes b.ts" });
    expect(hasil.mode).toBeUndefined();
    expect(hasil.prompt.startsWith(findRolePreset("pelaksana")?.briefPrefix ?? "?")).toBe(true);
    expect(hasil.prompt.endsWith("perbaiki tes b.ts")).toBe(true);
  });

  test("mode eksplisit menang atas mode preset", () => {
    expect(applyRolePreset({ role: "peneliti", prompt: "x", mode: "acceptEdits" }).mode).toBe(
      "acceptEdits",
    );
    expect(applyRolePreset({ role: "pelaksana", prompt: "x", mode: "plan" }).mode).toBe("plan");
  });

  test("role bebas dan tanpa role tak mengubah prompt maupun mode", () => {
    expect(applyRolePreset({ role: "lain", prompt: "cari" })).toEqual({ prompt: "cari" });
    expect(applyRolePreset({ prompt: "cari", mode: "default" })).toEqual({
      prompt: "cari",
      mode: "default",
    });
  });
});
