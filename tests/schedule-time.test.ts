import { describe, expect, test } from "bun:test";
import { nextRun, parseSpec } from "../src/server/sessions/schedule-time";
import { SessionError } from "../src/server/sessions/session-manager";

/**
 * Semua tanggal dibangun dengan konstruktor lokal (`new Date(y, m, d, h, mi)`)
 * supaya tes tak bergantung pada zona waktu mesin.
 */
// Senin 5 Januari 2026, 10:00 waktu lokal.
const SENIN = new Date(2026, 0, 5, 10, 0);

function jamLokal(y: number, m: number, d: number, h: number, mi: number): Date {
  return new Date(y, m, d, h, mi);
}

describe("jadwal sekali jalan", () => {
  test("waktu yang diminta dipakai bila masih di masa depan", () => {
    const at = jamLokal(2026, 0, 5, 12, 0).toISOString();
    const hasil = nextRun({ kind: "once", at }, SENIN);
    expect(hasil?.getTime()).toBe(Date.parse(at));
  });

  test("waktu yang sudah lewat tak punya jadwal lagi", () => {
    const at = jamLokal(2026, 0, 5, 9, 0).toISOString();
    expect(nextRun({ kind: "once", at }, SENIN)).toBeUndefined();
  });

  test("waktu yang sama dengan sekarang dianggap sudah lewat", () => {
    const at = SENIN.toISOString();
    expect(nextRun({ kind: "once", at }, SENIN)).toBeUndefined();
  });

  test("waktu tak valid tak punya jadwal", () => {
    expect(nextRun({ kind: "once", at: "bukan waktu" }, SENIN)).toBeUndefined();
  });
});

describe("jadwal berulang", () => {
  test("tanpa jalan sebelumnya dijadwalkan satu interval dari sekarang", () => {
    const hasil = nextRun({ kind: "every", minutes: 30 }, SENIN);
    expect(hasil?.getTime()).toBe(SENIN.getTime() + 30 * 60_000);
  });

  test("jalan sebelumnya menggeser jadwal satu interval", () => {
    const lastRun = jamLokal(2026, 0, 5, 9, 45);
    const hasil = nextRun({ kind: "every", minutes: 30 }, SENIN, lastRun);
    expect(hasil?.getTime()).toBe(lastRun.getTime() + 30 * 60_000);
  });

  test("kemunduran tak dikejar berkali-kali", () => {
    // Terlewat banyak interval: jadwal satu interval dari sekarang.
    const lastRun = jamLokal(2026, 0, 4, 8, 0);
    const hasil = nextRun({ kind: "every", minutes: 30 }, SENIN, lastRun);
    expect(hasil?.getTime()).toBe(SENIN.getTime() + 30 * 60_000);
  });

  test("interval yang pas di frontier digeser satu interval", () => {
    // lastRun + minutes = tepat `from`; hasil takenar bukan di masa depan,
    // jadi jadwal digeser satu interval dari sekarang.
    const lastRun = jamLokal(2026, 0, 5, 9, 30);
    const hasil = nextRun({ kind: "every", minutes: 30 }, SENIN, lastRun);
    expect(hasil?.getTime()).toBe(SENIN.getTime() + 30 * 60_000);
  });
});

describe("jadwal harian", () => {
  test("jam hari ini dipakai bila masih di depan", () => {
    const hasil = nextRun({ kind: "daily", time: "11:30" }, SENIN);
    expect(hasil?.getTime()).toBe(jamLokal(2026, 0, 5, 11, 30).getTime());
  });

  test("jam yang sudah lewat dipakai keesokan hari", () => {
    const hasil = nextRun({ kind: "daily", time: "09:00" }, SENIN);
    expect(hasil?.getTime()).toBe(jamLokal(2026, 0, 6, 9, 0).getTime());
  });

  test("jam yang tepat sama dengan sekarang dipakai keesokan hari", () => {
    const hasil = nextRun({ kind: "daily", time: "10:00" }, SENIN);
    expect(hasil?.getTime()).toBe(jamLokal(2026, 0, 6, 10, 0).getTime());
  });

  test("hari yang diizinkan dipakai", () => {
    // Hanya Sabtu (6): dari Senin, jadwalnya Sabtu depan.
    const hasil = nextRun({ kind: "daily", time: "08:00", days: [6] }, SENIN);
    expect(hasil?.getTime()).toBe(jamLokal(2026, 0, 10, 8, 0).getTime());
  });

  test("hari Minggu diizinkan (0)", () => {
    const hasil = nextRun({ kind: "daily", time: "08:00", days: [0] }, SENIN);
    expect(hasil?.getTime()).toBe(jamLokal(2026, 0, 11, 8, 0).getTime());
  });

  test("hari yang sama boleh dipakai bila jamnya masih di depan", () => {
    const hasil = nextRun({ kind: "daily", time: "23:00", days: [1] }, SENIN);
    expect(hasil?.getTime()).toBe(jamLokal(2026, 0, 5, 23, 0).getTime());
  });

  test("daftar hari kosong berarti tiap hari", () => {
    const hasil = nextRun({ kind: "daily", time: "11:30", days: [] }, SENIN);
    expect(hasil?.getTime()).toBe(jamLokal(2026, 0, 5, 11, 30).getTime());
  });

  test("jam tak valid tak punya jadwal", () => {
    expect(nextRun({ kind: "daily", time: "25:00" }, SENIN)).toBeUndefined();
  });
});

describe("baca jadwal", () => {
  const now = SENIN;

  test("sekali jalan dengan waktu di masa depan diterima", () => {
    const at = jamLokal(2026, 0, 6, 12, 0).toISOString();
    expect(parseSpec({ kind: "once", at }, now)).toEqual({ kind: "once", at });
  });

  test("berulang dengan interval diterima", () => {
    expect(parseSpec({ kind: "every", minutes: 60 }, now)).toEqual({
      kind: "every",
      minutes: 60,
    });
  });

  test("harian tanpa hari diterima", () => {
    expect(parseSpec({ kind: "daily", time: "07:15" }, now)).toEqual({
      kind: "daily",
      time: "07:15",
    });
  });

  test("harian dengan hari diurutkan", () => {
    expect(parseSpec({ kind: "daily", time: "07:15", days: [3, 1] }, now)).toEqual({
      kind: "daily",
      time: "07:15",
      days: [1, 3],
    });
  });

  test("hari kosong berarti tiap hari", () => {
    expect(parseSpec({ kind: "daily", time: "07:15", days: [] }, now)).toEqual({
      kind: "daily",
      time: "07:15",
    });
  });

  test("waktu di masa lalu ditolak", () => {
    const at = jamLokal(2026, 0, 4, 12, 0).toISOString();
    expect(() => parseSpec({ kind: "once", at }, now)).toThrow(SessionError);
  });

  test("waktu tak valid ditolak", () => {
    expect(() => parseSpec({ kind: "once", at: "bukan waktu" }, now)).toThrow(
      SessionError,
    );
  });

  test("interval di bawah batas ditolak", () => {
    expect(() => parseSpec({ kind: "every", minutes: 4 }, now)).toThrow(SessionError);
  });

  test("interval di atas batas ditolak", () => {
    expect(() => parseSpec({ kind: "every", minutes: 10081 }, now)).toThrow(
      SessionError,
    );
  });

  test("interval bukan bilangan bulat ditolak", () => {
    expect(() => parseSpec({ kind: "every", minutes: 30.5 }, now)).toThrow(
      SessionError,
    );
  });

  test("jam di luar pola ditolak", () => {
    expect(() => parseSpec({ kind: "daily", time: "7:15" }, now)).toThrow(SessionError);
    expect(() => parseSpec({ kind: "daily", time: "24:00" }, now)).toThrow(SessionError);
    expect(() => parseSpec({ kind: "daily", time: "12:60" }, now)).toThrow(SessionError);
  });

  test("hari di luar 0..6 ditolak", () => {
    expect(() => parseSpec({ kind: "daily", time: "07:15", days: [7] }, now)).toThrow(
      SessionError,
    );
  });

  test("hari yang sama dua kali ditolak", () => {
    expect(() =>
      parseSpec({ kind: "daily", time: "07:15", days: [1, 1] }, now),
    ).toThrow(SessionError);
  });

  test("jenis tak dikenal ditolak", () => {
    expect(() => parseSpec({ kind: "mingguan" }, now)).toThrow(SessionError);
  });

  test("spec bukan objek ditolak", () => {
    expect(() => parseSpec("harian", now)).toThrow(SessionError);
    expect(() => parseSpec(null, now)).toThrow(SessionError);
  });
});
