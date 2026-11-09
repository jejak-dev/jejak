import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetPath,
  defaultBudgetStore,
  FileBudgetStore,
} from "../src/server/budget/budget-store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jejak-budget-"));
  dirs.push(dir);
  return dir;
}

function store(path: string): FileBudgetStore {
  return new FileBudgetStore(path, { warnAt: 0.8 });
}

describe("FileBudgetStore", () => {
  test("berkas tak ada memakai default env", () => {
    const dir = tempDir();
    const created = store(join(dir, "budget.json"));
    expect(created.get()).toEqual({ warnAt: 0.8 });
  });

  test("set lalu get dan berkas 0600 dengan isi versi", () => {
    const dir = tempDir();
    const path = join(dir, "budget.json");
    const created = store(path);
    created.set({ sessionUsd: 1.5, dailyUsd: 10, warnAt: 0.9 });

    expect(created.get()).toEqual({ sessionUsd: 1.5, dailyUsd: 10, warnAt: 0.9 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(body).toEqual({ version: 1, sessionUsd: 1.5, dailyUsd: 10, warnAt: 0.9 });

    const reopened = store(path);
    expect(reopened.get()).toEqual({ sessionUsd: 1.5, dailyUsd: 10, warnAt: 0.9 });
  });

  test("hapus batas lewat config tanpa batas", () => {
    const dir = tempDir();
    const path = join(dir, "budget.json");
    const created = store(path);
    created.set({ sessionUsd: 1, warnAt: 0.8 });
    created.set({ warnAt: 0.8 });
    expect(created.get()).toEqual({ warnAt: 0.8 });
    const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect("sessionUsd" in body).toBe(false);
  });

  test("berkas rusak tidak ditimpa sampai set", () => {
    const dir = tempDir();
    const path = join(dir, "budget.json");
    const broken = "{ bukan json";
    writeFileSync(path, broken, { mode: 0o600 });

    const created = store(path);
    expect(created.get()).toEqual({ warnAt: 0.8 });
    expect(readFileSync(path, "utf8")).toBe(broken);

    created.set({ sessionUsd: 2, warnAt: 0.8 });
    expect(JSON.parse(readFileSync(path, "utf8")).sessionUsd).toBe(2);
  });

  test("versi tak dikenal diperlakukan default tanpa menimpa", () => {
    const dir = tempDir();
    const path = join(dir, "budget.json");
    const body = JSON.stringify({ version: 2, sessionUsd: 5, warnAt: 0.8 });
    writeFileSync(path, body, { mode: 0o600 });
    const created = store(path);
    expect(created.get()).toEqual({ warnAt: 0.8 });
    expect(readFileSync(path, "utf8")).toBe(body);
  });
});

describe("defaultBudgetStore", () => {
  test("memakai <JEJAK_HOME>/budget.json dan default env", () => {
    const dir = tempDir();
    const env = { JEJAK_HOME: dir, JEJAK_BUDGET_SESSION_USD: "3", JEJAK_BUDGET_WARN: "0.7" };
    const created = defaultBudgetStore(env);
    expect(created).toBeDefined();
    expect(budgetPath(env)).toBe(join(dir, "budget.json"));
    expect(created!.get()).toEqual({ sessionUsd: 3, warnAt: 0.7 });
  });

  test("JEJAK_PERSIST=0 tetap memakai store memori", () => {
    const dir = tempDir();
    const env = { JEJAK_HOME: dir, JEJAK_PERSIST: "0", JEJAK_BUDGET_DAY_USD: "4" };
    const created = defaultBudgetStore(env);
    expect(created).toBeDefined();
    created!.set({ sessionUsd: 2, warnAt: 0.8 });
    expect(created!.get()).toEqual({ sessionUsd: 2, warnAt: 0.8 });
    expect(existsSync(join(dir, "budget.json"))).toBe(false);
  });

  test("JEJAK_BUDGET=0 mematikan fitur", () => {
    const dir = tempDir();
    expect(defaultBudgetStore({ JEJAK_HOME: dir, JEJAK_BUDGET: "0" })).toBeUndefined();
  });
});
