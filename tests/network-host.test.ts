import { describe, expect, test } from "bun:test";
import {
  isAllowedNetworkHost,
  isLoopbackHostname,
  isPrivateNetworkHostname,
} from "../src/server/network/network-host";
import { VIA_HEADER, VIA_NETWORK } from "../src/server/network/network-fetch";
import { isValidPublicHost } from "../src/server/network/network-store";

describe("host privat untuk listener jaringan", () => {
  test("rentang IPv4 privat diterima", () => {
    for (const host of [
      "10.0.0.3",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.5",
      "169.254.10.10",
      "100.64.0.1",
      "100.127.255.254",
    ]) {
      expect(isPrivateNetworkHostname(host)).toBe(true);
    }
  });

  test("IPv4 publik ditolak", () => {
    for (const host of [
      "8.8.8.8",
      "1.2.3.4",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.1.5",
      "100.63.0.1",
      "100.128.0.1",
      "11.0.0.1",
    ]) {
      expect(isPrivateNetworkHostname(host)).toBe(false);
    }
  });

  test("IPv6 privat diterima dan publik ditolak", () => {
    expect(isPrivateNetworkHostname("[fe80::1]")).toBe(true);
    expect(isPrivateNetworkHostname("fe80::abcd")).toBe(true);
    expect(isPrivateNetworkHostname("[fc00::1]")).toBe(true);
    expect(isPrivateNetworkHostname("[fd12:3456::1]")).toBe(true);
    expect(isPrivateNetworkHostname("[2001:db8::1]")).toBe(false);
    expect(isPrivateNetworkHostname("[::1]")).toBe(false);
  });

  test("nama .local dan .ts.net diterima, nama lain ditolak", () => {
    expect(isPrivateNetworkHostname("jejak.local")).toBe(true);
    expect(isPrivateNetworkHostname("mesin.tail.ts.net")).toBe(true);
    expect(isPrivateNetworkHostname("evil.test")).toBe(false);
    expect(isPrivateNetworkHostname("localhost")).toBe(false);
    expect(isPrivateNetworkHostname("")).toBe(false);
  });

  test("loopback dikenali", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.1.2.3")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("192.168.1.5")).toBe(false);
  });
});

describe("penjaga host jaringan", () => {
  function request(headers: Record<string, string>): Request {
    return new Request("http://192.168.1.5:4747/api/health", { headers });
  }

  test("penanda jaringan dan host privat: boleh", () => {
    expect(
      isAllowedNetworkHost("192.168.1.5", request({ [VIA_HEADER]: VIA_NETWORK })),
    ).toBe(true);
  });

  test("tanpa penanda jaringan: ditolak", () => {
    expect(isAllowedNetworkHost("192.168.1.5", request({}))).toBe(false);
  });

  test("penanda lain: ditolak", () => {
    expect(
      isAllowedNetworkHost("192.168.1.5", request({ [VIA_HEADER]: "evil" })),
    ).toBe(false);
  });

  test("host publik dengan penanda jaringan: ditolak", () => {
    expect(
      isAllowedNetworkHost("8.8.8.8", request({ [VIA_HEADER]: VIA_NETWORK })),
    ).toBe(false);
  });

  test("host publik persis sama dengan publicHost tersimpan: boleh", () => {
    const publik = () => "jejak.contoh.com";
    expect(
      isAllowedNetworkHost(
        "jejak.contoh.com",
        request({ [VIA_HEADER]: VIA_NETWORK }),
        publik,
      ),
    ).toBe(true);
    // Perbandingan huruf kecil, tanpa port.
    expect(
      isAllowedNetworkHost(
        "JEJAK.CONTOH.COM",
        request({ [VIA_HEADER]: VIA_NETWORK }),
        publik,
      ),
    ).toBe(true);
  });

  test("host publik lain tetap ditolak", () => {
    const publik = () => "jejak.contoh.com";
    for (const host of ["lain.contoh.com", "evil.test", "contoh.com"]) {
      expect(
        isAllowedNetworkHost(host, request({ [VIA_HEADER]: VIA_NETWORK }), publik),
      ).toBe(false);
    }
  });

  test("host publik tanpa penanda jaringan: ditolak", () => {
    expect(
      isAllowedNetworkHost("jejak.contoh.com", request({}), () => "jejak.contoh.com"),
    ).toBe(false);
  });

  test("tanpa publicHost tersimpan: host publik ditolak", () => {
    expect(
      isAllowedNetworkHost(
        "jejak.contoh.com",
        request({ [VIA_HEADER]: VIA_NETWORK }),
        () => undefined,
      ),
    ).toBe(false);
  });
});

describe("validasi hostname publik tunnel", () => {
  test("FQDN huruf kecil sah diterima", () => {
    for (const host of ["jejak.contoh.com", "a-b.c-d.io", "x.y"]) {
      expect(isValidPublicHost(host)).toBe(true);
    }
  });

  test("bentuk tak sah ditolak", () => {
    for (const host of [
      "",
      "localhost",
      "JeJak.contoh.com",
      "https://jejak.contoh.com",
      "jejak.contoh.com:443",
      "jejak.contoh.com/path",
      "*.contoh.com",
      "-jejak.contoh.com",
      "jejak-.contoh.com",
      "jejak..contoh.com",
      "192.168.1.5",
      "jejak contoh.com",
      `${"a".repeat(64)}.contoh.com`,
    ]) {
      expect(isValidPublicHost(host)).toBe(false);
    }
    expect(isValidPublicHost(undefined)).toBe(false);
    expect(isValidPublicHost(42)).toBe(false);
  });
});
