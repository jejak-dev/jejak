import { describe, expect, test } from "bun:test";
import {
  formatCost,
  formatCount,
  formatRelative,
  parseHashRoute,
  sessionHash,
  shortPath,
  statusTone,
} from "../src/client/lib/format";

describe("formatCost", () => {
  test("undefined menjadi tanda pisah", () => {
    expect(formatCost()).toBe("–");
  });

  test("nol dan nilai sangat kecil", () => {
    expect(formatCost(0)).toBe("$0,00");
    expect(formatCost(0.004)).toBe("<$0,01");
  });

  test("dua desimal dengan koma", () => {
    expect(formatCost(1.25)).toBe("$1,25");
    expect(formatCost(12)).toBe("$12,00");
  });
});

describe("formatCount", () => {
  test("undefined menjadi tanda pisah", () => {
    expect(formatCount()).toBe("–");
  });

  test("pemisah ribuan id-ID", () => {
    expect(formatCount(1234567)).toBe("1.234.567");
    expect(formatCount(0)).toBe("0");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-11-07T12:00:00.000Z");

  test("baru saja di bawah 45 detik", () => {
    expect(formatRelative("2026-11-07T11:59:30.000Z", now)).toBe("baru saja");
    expect(formatRelative("2026-11-07T11:59:20.000Z", now)).toBe("baru saja");
  });

  test("menit dan jam", () => {
    expect(formatRelative("2026-11-07T11:55:00.000Z", now)).toBe("5 mnt lalu");
    expect(formatRelative("2026-11-07T09:00:00.000Z", now)).toBe("3 jam lalu");
  });

  test("kemarin lalu tanggal pendek", () => {
    expect(formatRelative("2026-11-06T11:00:00.000Z", now)).toBe("kemarin");
    expect(formatRelative("2026-11-01T12:00:00.000Z", now)).toBe("1 Nov");
  });

  test("ISO tidak valid menjadi string kosong", () => {
    expect(formatRelative("bukan tanggal", now)).toBe("");
  });
});

describe("statusTone", () => {
  test("memetakan status ke nada", () => {
    expect(statusTone("berjalan")).toBe("accent");
    expect(statusTone("selesai")).toBe("success");
    expect(statusTone("gagal")).toBe("danger");
    expect(statusTone("dibatalkan")).toBe("muted");
  });
});

describe("shortPath", () => {
  test("path pendek dikembalikan apa adanya", () => {
    expect(shortPath("/tmp")).toBe("/tmp");
  });

  test("memotong dari depan dan menyisakan segmen terakhir", () => {
    const path = "/Users/boykurniawan/Developer/proyek-yang-cukup-panjang/src";
    const result = shortPath(path, 20);
    expect(result.startsWith("…/")).toBe(true);
    expect(result.endsWith("/src")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  test("segmen terakhir yang terlalu panjang tetap utuh", () => {
    const path = `/a/${"x".repeat(40)}`;
    expect(shortPath(path, 10)).toBe(`…/${"x".repeat(40)}`);
  });
});

describe("hash route", () => {
  test("membaca id sesi", () => {
    expect(parseHashRoute("#/s/s_abcdef12")).toEqual({ sessionId: "s_abcdef12" });
  });

  test("decode id", () => {
    expect(parseHashRoute("#/s/s_ab%2Dcd")).toEqual({ sessionId: "s_ab-cd" });
  });

  test("rute lain dan id tidak valid menjadi objek kosong", () => {
    expect(parseHashRoute("#/")).toEqual({});
    expect(parseHashRoute("#/s/")).toEqual({});
    expect(parseHashRoute("#/s/a b")).toEqual({});
    expect(parseHashRoute("#/s/a".padEnd(80, "b"))).toEqual({});
    expect(parseHashRoute("")).toEqual({});
  });

  test("sessionHash", () => {
    expect(sessionHash("s1")).toBe("#/s/s1");
    expect(sessionHash()).toBe("#/");
  });
});
