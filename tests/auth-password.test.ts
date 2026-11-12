import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PasswordError,
  createVerifier,
  generateAutoPassword,
  resolvePassword,
} from "../src/server/auth/password";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "jejak-auth-password-"));
}

describe("resolvePassword", () => {
  test("tanpa sumber tidak ada kata sandi", () => {
    expect(resolvePassword({ env: {} })).toBeUndefined();
  });

  test("dari variabel lingkungan JEJAK_PASSWORD", () => {
    expect(resolvePassword({ env: { JEJAK_PASSWORD: "rahasia123" } })).toBe("rahasia123");
  });

  test("dari berkas, whitespace akhir dipangkas", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "sandi");
      writeFileSync(file, "  bcrypt-weakness  \n");
      expect(resolvePassword({ passwordFile: file, env: {} })).toBe("bcrypt-weakness");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("berkas lebih diprioritaskan daripada lingkungan", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "sandi");
      writeFileSync(file, "dari-berkas-1");
      expect(
        resolvePassword({ passwordFile: file, env: { JEJAK_PASSWORD: "dari-env-1234" } }),
      ).toBe("dari-berkas-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sandi acak 24 karakter base32", () => {
    const password = resolvePassword({ env: {}, auto: true });
    expect(password).toBeDefined();
    expect(password).toHaveLength(AUTO_PASSWORD_LENGTH);
    expect(password).toMatch(/^[A-Z2-7]+$/);
  });

  test("dua sandi acak berbeda", () => {
    expect(generateAutoPassword()).not.toBe(generateAutoPassword());
  });

  test("sandi pendek dari lingkungan ditolak", () => {
    expect(() => resolvePassword({ env: { JEJAK_PASSWORD: "pendek" } })).toThrow(PasswordError);
  });

  test("sandi pendek dari berkas ditolak", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "sandi");
      writeFileSync(file, "pendek");
      expect(() => resolvePassword({ passwordFile: file, env: {} })).toThrow(PasswordError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("berkas tidak ada ditolak", () => {
    expect(() =>
      resolvePassword({ passwordFile: join(tmpdir(), "jejak-tidak-ada-12345"), env: {} }),
    ).toThrow(PasswordError);
  });

  test("panjang minimal adalah delapan karakter", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(resolvePassword({ env: { JEJAK_PASSWORD: "12345678" } })).toBe("12345678");
  });
});

describe("createVerifier", () => {
  test("sandi benar diterima", () => {
    const verifier = createVerifier("benar-1234");
    expect(verifier.verify("benar-1234")).toBe(true);
  });

  test("sandi salah ditolak", () => {
    const verifier = createVerifier("benar-1234");
    expect(verifier.verify("salah-1234")).toBe(false);
    expect(verifier.verify("")).toBe(false);
    expect(verifier.verify("BENAR-1234")).toBe(false);
  });

  test("verifier berbeda tidak saling menerima", () => {
    const satu = createVerifier("sama-12345");
    const dua = createVerifier("sama-12345");
    expect(satu.verify("sama-12345")).toBe(true);
    expect(dua.verify("sama-12345")).toBe(true);
    expect(satu.verify("beda-12345")).toBe(false);
  });
});
