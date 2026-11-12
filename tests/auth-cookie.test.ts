import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  SESSION_COOKIE_PREFIX,
  SESSION_TTL_MS,
  createSessionCodec,
  parseCookies,
} from "../src/server/auth/session-cookie";

describe("createSessionCodec", () => {
  test("nama cookie berbeda per port", () => {
    const a = createSessionCodec({ port: 3000 });
    const b = createSessionCodec({ port: 3001 });
    expect(a.cookieName).toBe(`${SESSION_COOKIE_PREFIX}3000`);
    expect(b.cookieName).toBe(`${SESSION_COOKIE_PREFIX}3001`);
    expect(a.cookieName).not.toBe(b.cookieName);
  });

  test("nilai yang diterbitkan sah", () => {
    const codec = createSessionCodec({ port: 3000 });
    const value = codec.issue();
    expect(value.split(".")).toHaveLength(3);
    expect(codec.verify(value)).toBe(true);
  });

  test("tanda tangan diubah satu karakter ditolak", () => {
    const codec = createSessionCodec({ port: 3000 });
    const value = codec.issue();
    const parts = value.split(".");
    const mac = parts[2] ?? "";
    const swapped = mac[0] === "a" ? "b" : "a";
    const tampered = `${parts[0]}.${parts[1]}.${swapped}${mac.slice(1)}`;
    expect(codec.verify(tampered)).toBe(false);
  });

  test("nonce diubah ditolak", () => {
    const codec = createSessionCodec({ port: 3000 });
    const parts = codec.issue().split(".");
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
    expect(codec.verify(tampered)).toBe(false);
  });

  test("cookie kedaluwarsa ditolak", () => {
    let now = 1_000_000;
    const codec = createSessionCodec({ port: 3000, now: () => now, ttlMs: 1000 });
    const value = codec.issue();
    expect(codec.verify(value)).toBe(true);
    now += 1001;
    expect(codec.verify(value)).toBe(false);
  });

  test("kunci berbeda ditolak", () => {
    const nilai = randomBytes(32);
    const satu = createSessionCodec({ port: 3000, key: nilai });
    const dua = createSessionCodec({ port: 3000, key: randomBytes(32) });
    const value = satu.issue();
    expect(dua.verify(value)).toBe(false);
  });

  test("nilai acak ditolak", () => {
    const codec = createSessionCodec({ port: 3000 });
    expect(codec.verify("bukan-cookie")).toBe(false);
    expect(codec.verify("")).toBe(false);
    expect(codec.verify("1.2.3")).toBe(false);
  });

  test("serialize memuat atribut aman dan Max-Age", () => {
    const codec = createSessionCodec({ port: 3000 });
    const value = codec.issue();
    const header = codec.serialize(value);
    expect(header.startsWith(`${codec.cookieName}=${value}`)).toBe(true);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(header).not.toContain("Secure");
  });

  test("serialize aman memakai Secure", () => {
    const codec = createSessionCodec({ port: 3000 });
    expect(codec.serialize(codec.issue(), { secure: true })).toContain("Secure");
  });

  test("clear meniadakan cookie dengan Max-Age=0", () => {
    const codec = createSessionCodec({ port: 3000 });
    const header = codec.clear({});
    expect(header).toContain(`${codec.cookieName}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
  });
});

describe("parseCookies", () => {
  test("membaca beberapa cookie", () => {
    const parsed = parseCookies("jejak_sid_3000=abc; lain=def");
    expect(parsed["jejak_sid_3000"]).toBe("abc");
    expect(parsed.lain).toBe("def");
  });

  test("header kosong memberi peta kosong", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  test("tanpa tanda sama diabaikan", () => {
    expect(parseCookies("rusak")).toEqual({});
  });
});
