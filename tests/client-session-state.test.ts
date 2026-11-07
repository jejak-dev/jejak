import { describe, expect, test } from "bun:test";
import { sessionState } from "../src/client/components/SessionHeader";
import { shouldResume } from "../src/client/hooks";

describe("shouldResume", () => {
  test("sambung ulang bila aliran selesai dan sesi berjalan lagi", () => {
    expect(shouldResume("selesai", "berjalan", false, 0, 0)).toBe(true);
  });

  test("sambung ulang bila sesi selesai tetapi ada event baru yang belum diterima", () => {
    expect(shouldResume("selesai", "selesai", false, 5, 3)).toBe(true);
  });

  test("tidak sambung ulang bila eventCount sama dengan lastSeq", () => {
    expect(shouldResume("selesai", "selesai", false, 5, 5)).toBe(false);
  });

  test("tidak sambung ulang bila eventCount basi (lebih kecil dari lastSeq)", () => {
    expect(shouldResume("selesai", "selesai", false, 2, 5)).toBe(false);
  });

  test("tidak sambung bila sudah ada aliran aktif", () => {
    expect(shouldResume("selesai", "berjalan", true, 5, 3)).toBe(false);
  });

  test("tidak sambung saat aliran masih terhubung", () => {
    expect(shouldResume("terhubung", "berjalan", false, 5, 3)).toBe(false);
  });

  test("tidak sambung bila connection bukan selesai", () => {
    expect(shouldResume("menyambung", "selesai", false, 5, 3)).toBe(false);
  });
});

describe("sessionState", () => {
  test("berjalan tanpa izin menunggu", () => {
    expect(sessionState("berjalan", 0)).toEqual({ label: "Berjalan", dot: "run" });
  });

  test("berjalan dengan izin menunggu menampilkan jumlahnya bila lebih dari satu", () => {
    expect(sessionState("berjalan", 1)).toEqual({ label: "Menunggu izin", dot: "warn" });
    expect(sessionState("berjalan", 3)).toEqual({ label: "Menunggu izin (3)", dot: "warn" });
  });

  test("status akhir", () => {
    expect(sessionState("selesai", 0)).toEqual({ label: "Selesai", dot: "" });
    expect(sessionState("gagal", 0)).toEqual({ label: "Gagal", dot: "bad" });
    expect(sessionState("dibatalkan", 0)).toEqual({ label: "Dihentikan", dot: "" });
  });
});
