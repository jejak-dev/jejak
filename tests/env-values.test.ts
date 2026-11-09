import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvValuesFromDir } from "../src/server/security/env-values";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jejak-env-values-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadEnvValuesFromDir", () => {
  test(".env dan .env.local terbaca, .env.example diabaikan", () => {
    writeFileSync(join(dir, ".env"), "SIMPAN_RAHASIA=abc12345xyz\n");
    writeFileSync(join(dir, ".env.local"), "LAIN_RAHASIA=def67890uvw\n");
    writeFileSync(join(dir, ".env.example"), "CONTOH_RAHASIA=contoh12345zzz\n");

    const values = loadEnvValuesFromDir(dir).sort();
    expect(values).toContain("abc12345xyz");
    expect(values).toContain("def67890uvw");
    expect(values).not.toContain("contoh12345zzz");
  });

  test("berkas lebih dari 256 KiB diabaikan", () => {
    const big = "X".repeat(256 * 1024 + 1);
    writeFileSync(join(dir, ".env.besar"), `BESAR_RAHASIA=${big}\n`);
    expect(loadEnvValuesFromDir(dir)).not.toContain(big);
  });

  test("folder tidak ada menghasilkan []", () => {
    expect(loadEnvValuesFromDir(join(dir, "tidak-ada"))).toEqual([]);
  });

  test("symlink keluar folder diabaikan", () => {
    const outside = mkdtempSync(join(tmpdir(), "jejak-env-outside-"));
    try {
      writeFileSync(join(outside, ".env"), "LUAR_RAHASIA=luar12345xyz\n");
      symlinkSync(join(outside, ".env"), join(dir, ".env"));
      expect(loadEnvValuesFromDir(dir)).not.toContain("luar12345xyz");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("direktori bernama .env dilewati", () => {
    mkdirSync(join(dir, ".env"));
    expect(loadEnvValuesFromDir(dir)).toEqual([]);
  });
});
