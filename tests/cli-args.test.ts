import { describe, expect, test } from "bun:test";
import { isLoopbackHost, parseArgs } from "../src/cli/args";

describe("parseArgs", () => {
  test("tanpa argumen menampilkan bantuan", () => {
    expect(parseArgs([])).toEqual({ command: "help" });
  });

  test("serve polos", () => {
    expect(parseArgs(["serve"])).toEqual({ command: "serve" });
  });

  test("--port dengan spasi", () => {
    expect(parseArgs(["serve", "--port", "3001"])).toEqual({
      command: "serve",
      port: 3001,
    });
  });

  test("--port dengan sama dengan", () => {
    expect(parseArgs(["serve", "--port=3001"])).toEqual({
      command: "serve",
      port: 3001,
    });
  });

  test("--host dan --port urutan bebas", () => {
    expect(parseArgs(["serve", "--port", "8080", "--host", "127.0.0.1"])).toEqual({
      command: "serve",
      host: "127.0.0.1",
      port: 8080,
    });
  });

  test("--mock", () => {
    expect(parseArgs(["serve", "--mock"])).toEqual({ command: "serve", mock: true });
  });

  test("port di luar jangkauan dan bukan angka error", () => {
    for (const raw of ["0", "70000", "abc", "-1", "1.5"]) {
      const parsed = parseArgs(["serve", "--port", raw]);
      expect(parsed.command).toBe("serve");
      expect(parsed.error).toBeDefined();
      expect(parsed.port).toBeUndefined();
    }
  });

  test("port tanpa nilai error", () => {
    const parsed = parseArgs(["serve", "--port"]);
    expect(parsed.error).toContain("--port");
  });

  test("host kosong error", () => {
    const parsed = parseArgs(["serve", "--host="]);
    expect(parsed.error).toContain("--host");
  });

  test("flag tak dikenal error", () => {
    const parsed = parseArgs(["serve", "--verbose"]);
    expect(parsed.command).toBe("serve");
    expect(parsed.unknown).toBe("--verbose");
    expect(parsed.error).toContain("--verbose");
  });

  test("-v dan --version", () => {
    expect(parseArgs(["-v"])).toEqual({ command: "version" });
    expect(parseArgs(["--version"])).toEqual({ command: "version" });
  });

  test("-h dan --help", () => {
    expect(parseArgs(["-h"])).toEqual({ command: "help" });
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
  });

  test("doctor tanpa argumen", () => {
    expect(parseArgs(["doctor"])).toEqual({ command: "doctor" });
  });

  test("doctor dengan argumen tambahan error", () => {
    const parsed = parseArgs(["doctor", "--json"]);
    expect(parsed.command).toBe("doctor");
    expect(parsed.error).toBeDefined();
  });

  test("perintah tak dikenal", () => {
    const parsed = parseArgs(["terbang"]);
    expect(parsed.command).toBe("unknown");
    expect(parsed.unknown).toBe("terbang");
  });
});

describe("isLoopbackHost", () => {
  test("loopback dikenali", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "127.255.255.255", "localhost", "::1", "[::1]", "LocalHost"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("non-loopback ditolak", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.2", "10.0.0.1", "example.test", "128.0.0.1", "127.0.0.256", ""]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
