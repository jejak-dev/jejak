import { describe, expect, test } from "bun:test";
import {
  budgetFromEnv,
  evaluateBudget,
  formatUsd,
  levelFor,
  localDayStartIso,
  parseBudgetConfig,
  type BudgetConfig,
} from "../src/server/budget/budget";

const CONFIG: BudgetConfig = { sessionUsd: 1, dailyUsd: 10, warnAt: 0.8 };

describe("levelFor", () => {
  test("undefined tanpa batas", () => {
    expect(levelFor(5, undefined, 0.8)).toBeUndefined();
  });

  test("tepi ok/warn/over", () => {
    expect(levelFor(0, 1, 0.8)).toBe("ok");
    expect(levelFor(0.79, 1, 0.8)).toBe("ok");
    expect(levelFor(0.8, 1, 0.8)).toBe("warn");
    expect(levelFor(0.99, 1, 0.8)).toBe("warn");
    expect(levelFor(1, 1, 0.8)).toBe("over");
    expect(levelFor(2, 1, 0.8)).toBe("over");
  });

  test("warnAt kustom menggeser ambang", () => {
    expect(levelFor(0.6, 1, 0.5)).toBe("warn");
    expect(levelFor(0.6, 1, 0.95)).toBe("ok");
  });
});

describe("evaluateBudget", () => {
  test("kedua cakupan dihitung terpisah", () => {
    expect(evaluateBudget({ config: CONFIG, sessionUsd: 0.5, dayUsd: 9 })).toEqual({
      session: "ok",
      day: "warn",
    });
    expect(evaluateBudget({ config: CONFIG, sessionUsd: 1.5, dayUsd: 20 })).toEqual({
      session: "over",
      day: "over",
    });
  });

  test("cakupan tanpa batas tidak muncul", () => {
    expect(evaluateBudget({ config: { warnAt: 0.8 }, sessionUsd: 1, dayUsd: 1 })).toEqual({});
    expect(
      evaluateBudget({ config: { sessionUsd: 1, warnAt: 0.8 }, sessionUsd: 0.5, dayUsd: 5 }),
    ).toEqual({ session: "ok" });
  });
});

describe("localDayStartIso", () => {
  test("awal hari lokal dalam ISO UTC", () => {
    const now = new Date(2026, 10, 10, 15, 30, 0);
    const start = localDayStartIso(now);
    const parsed = new Date(start);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(10);
    expect(parsed.getDate()).toBe(10);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
    expect(parsed.getSeconds()).toBe(0);
  });
});

describe("parseBudgetConfig", () => {
  test("valid dengan batas opsional", () => {
    expect(parseBudgetConfig({})).toEqual({ config: { warnAt: 0.8 } });
    expect(parseBudgetConfig({ sessionUsd: 1.5, dailyUsd: 10, warnAt: 0.9 })).toEqual({
      config: { sessionUsd: 1.5, dailyUsd: 10, warnAt: 0.9 },
    });
    expect(parseBudgetConfig({ sessionUsd: null, warnAt: 0.5 })).toEqual({
      config: { warnAt: 0.5 },
    });
  });

  test("menolak field tak dikenal, tipe salah, dan rentang", () => {
    for (const raw of [
      null,
      [],
      "x",
      { lain: 1 },
      { sessionUsd: "1" },
      { sessionUsd: 0 },
      { sessionUsd: -1 },
      { sessionUsd: 100001 },
      { dailyUsd: Number.NaN },
      { warnAt: 0.4 },
      { warnAt: 0.96 },
      { warnAt: "0.8" },
    ]) {
      const result = parseBudgetConfig(raw);
      expect(result.config).toBeUndefined();
      expect(typeof result.error).toBe("string");
    }
  });
});

describe("budgetFromEnv", () => {
  test("membaca env yang valid dan mengabaikan yang tidak", () => {
    expect(
      budgetFromEnv({
        JEJAK_BUDGET_SESSION_USD: "2.5",
        JEJAK_BUDGET_DAY_USD: "20",
        JEJAK_BUDGET_WARN: "0.7",
      }),
    ).toEqual({ sessionUsd: 2.5, dailyUsd: 20, warnAt: 0.7 });

    expect(
      budgetFromEnv({
        JEJAK_BUDGET_SESSION_USD: "abc",
        JEJAK_BUDGET_DAY_USD: "-3",
        JEJAK_BUDGET_WARN: "2",
      }),
    ).toEqual({ warnAt: 0.8 });
    expect(budgetFromEnv({})).toEqual({ warnAt: 0.8 });
  });
});

describe("formatUsd", () => {
  test("dua desimal koma dan ambang kecil", () => {
    expect(formatUsd(1.234)).toBe("US$1,23");
    expect(formatUsd(1.5)).toBe("US$1,50");
    expect(formatUsd(0.01)).toBe("US$0,01");
    expect(formatUsd(0.009)).toBe("<US$0,01");
    expect(formatUsd(0)).toBe("<US$0,01");
  });
});
