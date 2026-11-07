import { describe, expect, test } from "bun:test";
import { sessionState } from "../src/client/components/SessionHeader";

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
