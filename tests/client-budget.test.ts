import { describe, expect, test } from "bun:test";
import type { BudgetStatusResult } from "../src/client/lib/api";
import {
  budgetBadge,
  budgetLine,
  formatUsd,
  parseUsdInput,
  parseWarnPercent,
} from "../src/client/lib/budget";

function status(overrides: Partial<BudgetStatusResult> = {}): BudgetStatusResult {
  return {
    config: { sessionUsd: 2, dailyUsd: 5, warnAt: 0.8 },
    todayUsd: 1.2,
    ...overrides,
  };
}

describe("parseUsdInput", () => {
  test("kosong berarti hapus batas", () => {
    expect(parseUsdInput("")).toEqual({ value: null });
    expect(parseUsdInput("   ")).toEqual({ value: null });
  });

  test("koma dan titik desimal diterima", () => {
    expect(parseUsdInput("2")).toEqual({ value: 2 });
    expect(parseUsdInput("2,5")).toEqual({ value: 2.5 });
    expect(parseUsdInput("2.5")).toEqual({ value: 2.5 });
    expect(parseUsdInput(" 0,01 ")).toEqual({ value: 0.01 });
  });

  test("nol, negatif, dan bukan angka ditolak", () => {
    for (const text of ["0", "0,0", "-1", "abc", "1e3", "2,5,1"]) {
      expect(parseUsdInput(text).error).toBeDefined();
      expect(parseUsdInput(text).value).toBeUndefined();
    }
  });

  test("batas maksimum 100000", () => {
    expect(parseUsdInput("100000")).toEqual({ value: 100000 });
    expect(parseUsdInput("100000,01").error).toBeDefined();
  });
});

describe("parseWarnPercent", () => {
  test("rentang 50–95 menjadi 0.5–0.95", () => {
    expect(parseWarnPercent("50")).toEqual({ value: 0.5 });
    expect(parseWarnPercent("80")).toEqual({ value: 0.8 });
    expect(parseWarnPercent("95")).toEqual({ value: 0.95 });
  });

  test("kosong memakai bawaan 0.8", () => {
    expect(parseWarnPercent("")).toEqual({ value: 0.8 });
  });

  test("di luar rentang dan bukan angka ditolak", () => {
    for (const text of ["49", "96", "0", "abc", "-80"]) {
      expect(parseWarnPercent(text).error).toBeDefined();
    }
  });
});

describe("formatUsd", () => {
  test("dua desimal dengan koma", () => {
    expect(formatUsd(1.23)).toBe("US$1,23");
    expect(formatUsd(5)).toBe("US$5,00");
    expect(formatUsd(0.005)).toBe("<US$0,01");
  });

  test("nilai tak valid atau nol menjadi US$0,00", () => {
    expect(formatUsd(0)).toBe("US$0,00");
    expect(formatUsd(Number.NaN)).toBe("US$0,00");
  });
});

describe("budgetLine", () => {
  test("dengan batas harian", () => {
    expect(budgetLine(status())).toBe("Hari ini US$1,20 dari US$5,00 (24%)");
  });

  test("tanpa batas harian", () => {
    expect(budgetLine(status({ config: { warnAt: 0.8 }, todayUsd: 1.2 }))).toBe(
      "Hari ini US$1,20 · tanpa batas harian",
    );
  });

  test("nol tanpa batas", () => {
    expect(budgetLine(status({ config: { warnAt: 0.8 }, todayUsd: 0 }))).toBe(
      "Hari ini US$0,00 · tanpa batas harian",
    );
  });
});

describe("budgetBadge", () => {
  test("tanpa anggaran tidak ada lencana", () => {
    expect(budgetBadge({})).toBeUndefined();
    expect(budgetBadge({ budget: {} })).toBeUndefined();
    expect(budgetBadge({ budget: { session: "ok", day: "ok" } })).toBeUndefined();
  });

  test("warn sesi", () => {
    const badge = budgetBadge({ budget: { session: "warn" } });
    expect(badge?.label).toBe("Budget almost used");
    expect(badge?.tone).toBe("warn");
    expect(badge?.title).toContain("sesi");
    expect(badge?.title).toContain("tidak dihentikan");
  });

  test("over dihari menang dan nada bad", () => {
    const badge = budgetBadge({ budget: { session: "ok", day: "over" } });
    expect(badge?.label).toBe("Budget exceeded");
    expect(badge?.tone).toBe("bad");
    expect(badge?.title).toContain("hari");
  });

  test("warn di dua cakupan menyebut keduanya", () => {
    const badge = budgetBadge({ budget: { session: "warn", day: "warn" } });
    expect(badge?.title).toContain("sesi dan hari");
    expect(badge?.tone).toBe("warn");
  });

  test("over sesi saat hari warn memakai bad", () => {
    const badge = budgetBadge({ budget: { session: "over", day: "warn" } });
    expect(badge?.tone).toBe("bad");
    expect(badge?.label).toBe("Budget exceeded");
    expect(badge?.title).toContain("sesi");
  });
});
