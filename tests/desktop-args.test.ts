import { describe, expect, test } from "bun:test";
import { isValidDesktopToken, readDesktopToken, DesktopTokenError } from "../src/server/desktop";
import { parseArgs } from "../src/cli/args";

describe("parseArgs mode desktop", () => {
  test("--desktop terurai", () => {
    expect(parseArgs(["serve", "--desktop"])).toEqual({
      command: "serve",
      desktop: true,
    });
  });

  test("--desktop boleh digabung dengan flag lain", () => {
    expect(parseArgs(["serve", "--mock", "--desktop"])).toEqual({
      command: "serve",
      mock: true,
      desktop: true,
    });
  });

  test("--port 0 sah hanya bersama --desktop", () => {
    expect(parseArgs(["serve", "--desktop", "--port", "0"])).toEqual({
      command: "serve",
      desktop: true,
      port: 0,
    });
    // Urutan flag tak berpengaruh.
    expect(parseArgs(["serve", "--port", "0", "--desktop"])).toEqual({
      command: "serve",
      desktop: true,
      port: 0,
    });
  });

  test("tanpa --desktop, --port 0 tetap ditolak seperti sebelumnya", () => {
    const parsed = parseArgs(["serve", "--port", "0"]);
    expect(parsed.command).toBe("serve");
    expect(parsed.error).toContain("Port harus bilangan bulat 1-65535");
    expect(parsed.port).toBeUndefined();
  });

  test("--desktop dengan host non-loopback ditolak", () => {
    for (const host of ["0.0.0.0", "192.168.1.5", "::"]) {
      const parsed = parseArgs(["serve", "--desktop", "--host", host]);
      expect(parsed.command).toBe("serve");
      expect(parsed.error).toContain("--desktop");
      expect(parsed.host).toBeUndefined();
    }
  });

  test("--desktop dengan host loopback diterima", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const parsed = parseArgs(["serve", "--desktop", "--host", host]);
      expect(parsed.error).toBeUndefined();
      expect(parsed.host).toBe(host);
    }
  });

  test("port di luar jangkauan tetap error walau --desktop", () => {
    for (const raw of ["70000", "abc", "-1", "1.5"]) {
      const parsed = parseArgs(["serve", "--desktop", "--port", raw]);
      expect(parsed.error).toBeDefined();
    }
  });
});

describe("token desktop", () => {
  test("token sah diterima dan dihapus dari lingkungan", () => {
    const env: Record<string, string | undefined> = {
      JEJAK_DESKTOP_TOKEN: "a".repeat(32),
    };
    expect(readDesktopToken(env)).toBe("a".repeat(32));
    // Tidak boleh diwarisi proses anak.
    expect(env.JEJAK_DESKTOP_TOKEN).toBeUndefined();
  });

  test("token kosong, pendek, atau karakter tak sah ditolak", () => {
    for (const value of ["", "   ", "pendek", "a".repeat(31), "a".repeat(33) + "!"]) {
      const env: Record<string, string | undefined> = {
        JEJAK_DESKTOP_TOKEN: value,
      };
      expect(() => readDesktopToken(env)).toThrow(DesktopTokenError);
      // Token tak valid pun dihapus dari lingkungan.
      expect(env.JEJAK_DESKTOP_TOKEN).toBeUndefined();
    }
  });

  test("tanpa variabel lingkungan ditolak", () => {
    const env: Record<string, string | undefined> = {};
    expect(() => readDesktopToken(env)).toThrow(DesktopTokenError);
  });

  test("isValidDesktopToken mengikuti panjang dan karakter", () => {
    expect(isValidDesktopToken("a".repeat(32))).toBe(true);
    expect(isValidDesktopToken("A-b_0".repeat(7))).toBe(true);
    expect(isValidDesktopToken("a".repeat(31))).toBe(false);
    expect(isValidDesktopToken(`${"a".repeat(31)}+`)).toBe(false);
  });
});
