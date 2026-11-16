import { describe, expect, test } from "bun:test";
import {
  describeHari,
  describeNext,
  describeSpec,
  formToSpec,
  parseLocalDateTime,
  specToForm,
  toDateTimeLocal,
  type ScheduleFormValues,
} from "../src/client/lib/schedule";
import type { ScheduledTask } from "../src/server/sessions/scheduled-tasks";
import type { ScheduleSpec } from "../src/server/sessions/schedule-time";

function form(partial: Partial<ScheduleFormValues>): ScheduleFormValues {
  return {
    kind: "daily",
    at: "",
    everyMinutes: "30",
    time: "09:00",
    days: [],
    ...partial,
  };
}

function task(partial: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "t1",
    name: "Tugas",
    input: { prompt: "Kerjakan" },
    spec: { kind: "daily", time: "09:00" },
    enabled: true,
    runCount: 0,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...partial,
  };
}

describe("describeSpec", () => {
  test("sekali memakai tanggal dan jam lokal", () => {
    const spec = describeSpec({ kind: "once", at: "2026-11-17T09:00:00.000Z" });
    // Jam lokal tak pasti di mesin uji; yang diperiksa bentuk kalimatnya.
    expect(spec.startsWith("Sekali, 17 Nov 2026 ")).toBe(true);
    expect(spec).toMatch(/Sekali, 17 Nov 2026 \d{2}:\d{2}$/);
  });

  test("berulang per menit dan per jam", () => {
    expect(describeSpec({ kind: "every", minutes: 30 })).toBe("Tiap 30 menit");
    expect(describeSpec({ kind: "every", minutes: 5 })).toBe("Tiap 5 menit");
    expect(describeSpec({ kind: "every", minutes: 60 })).toBe("Tiap 1 jam");
    expect(describeSpec({ kind: "every", minutes: 120 })).toBe("Tiap 2 jam");
  });

  test("harian tanpa hari Selected berarti tiap hari", () => {
    expect(describeSpec({ kind: "daily", time: "09:00" })).toBe("Harian 09:00");
    expect(describeSpec({ kind: "daily", time: "09:00", days: [] })).toBe("Harian 09:00");
    expect(describeSpec({ kind: "daily", time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] })).toBe(
      "Harian 09:00",
    );
  });

  test("harian dengan rentang hari dan daftar hari", () => {
    expect(describeSpec({ kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] })).toBe(
      "Senin–Jumat 09:00",
    );
    expect(describeSpec({ kind: "daily", time: "07:30", days: [1, 3] })).toBe("Sen, Rab 07:30");
    expect(describeSpec({ kind: "daily", time: "08:00", days: [3] })).toBe("Rabu 08:00");
  });
});

describe("describeHari", () => {
  test("hari berurutan yang berputar lewat akhir minggu", () => {
    expect(describeHari([5, 6, 0])).toBe("Jumat–Minggu");
  });

  test("hari tak berurutan memakai nama singkat", () => {
    expect(describeHari([1, 3])).toBe("Sen, Rab");
  });

  test("satu hari memakai nama penuh", () => {
    expect(describeHari([2])).toBe("Selasa");
  });
});

describe("describeNext", () => {
  const now = new Date(2026, 10, 16, 10, 0, 0);

  test("menit lagi bila jadwalnya dekat", () => {
    const next = new Date(2026, 10, 16, 10, 5, 0).toISOString();
    expect(describeNext(task({ nextRunAt: next }), now)).toBe("Berikutnya: 5 menit lagi");
  });

  test("besok bila jadwalnya esok hari", () => {
    const next = new Date(2026, 10, 17, 9, 0, 0).toISOString();
    expect(describeNext(task({ nextRunAt: next }), now)).toBe("Berikutnya: besok 09:00");
  });

  test("tanggal lain memakai hari dan bulan tanpa tahun", () => {
    const next = new Date(2026, 10, 20, 9, 0, 0).toISOString();
    expect(describeNext(task({ nextRunAt: next }), now)).toBe("Berikutnya: 20 Nov 09:00");
  });

  test("tugas mati disebut nonaktif", () => {
    expect(describeNext(task({ enabled: false }), now)).toBe("Nonaktif");
  });

  test("tugas sekali yang sudah jalan disebut selesai", () => {
    const selesai = task({
      spec: { kind: "once", at: "2026-11-15T09:00:00.000Z" },
      enabled: false,
    });
    expect(describeNext(selesai, now)).toBe("Selesai");
  });
});

describe("formToSpec", () => {
  const now = new Date(2026, 10, 16, 10, 0, 0);

  test("sekali menjadi ISO UTC dan harus di masa depan", () => {
    const hasil = formToSpec(
      form({ kind: "once", at: "2026-11-20T09:00" }),
      now,
    );
    expect(hasil.ok).toBe(true);
    if (!hasil.ok) return;
    expect(hasil.spec.kind).toBe("once");
    if (hasil.spec.kind !== "once") return;
    expect(hasil.spec.at).toBe(new Date(2026, 10, 20, 9, 0, 0).toISOString());
  });

  test("sekali di masa lalu ditolak", () => {
    const hasil = formToSpec(form({ kind: "once", at: "2026-11-10T09:00" }), now);
    expect(hasil.ok).toBe(false);
    if (hasil.ok) return;
    expect(hasil.error).toContain("masa depan");
  });

  test("sekali dengan tanggal tak lengkap ditolak", () => {
    expect(formToSpec(form({ kind: "once", at: "" }), now).ok).toBe(false);
    expect(formToSpec(form({ kind: "once", at: "20-11-2026" }), now).ok).toBe(false);
    expect(formToSpec(form({ kind: "once", at: "2026-02-31T09:00" }), now).ok).toBe(false);
  });

  test("berulang mewajibkan bilangan bulat 5..10080", () => {
    const hasil = formToSpec(form({ kind: "every", everyMinutes: "60" }), now);
    expect(hasil.ok).toBe(true);
    if (!hasil.ok) return;
    expect(hasil.spec).toEqual({ kind: "every", minutes: 60 });

    expect(formToSpec(form({ kind: "every", everyMinutes: "4" }), now).ok).toBe(false);
    expect(formToSpec(form({ kind: "every", everyMinutes: "10081" }), now).ok).toBe(false);
    expect(formToSpec(form({ kind: "every", everyMinutes: "1,5" }), now).ok).toBe(false);
    expect(formToSpec(form({ kind: "every", everyMinutes: "" }), now).ok).toBe(false);
  });

  test("harian memakai jam HH:MM dan daftar hari", () => {
    const hasil = formToSpec(form({ kind: "daily", time: "07:30", days: [1, 2] }), now);
    expect(hasil).toEqual({ ok: true, spec: { kind: "daily", time: "07:30", days: [1, 2] } });
  });

  test("harian tanpa hari berarti tiap hari", () => {
    expect(formToSpec(form({ kind: "daily", time: "07:30" }), now)).toEqual({
      ok: true,
      spec: { kind: "daily", time: "07:30" },
    });
  });

  test("harian dengan jam tak sah ditolak", () => {
    expect(formToSpec(form({ kind: "daily", time: "9:00" }), now).ok).toBe(false);
    expect(formToSpec(form({ kind: "daily", time: "24:00" }), now).ok).toBe(false);
  });
});

describe("specToForm", () => {
  test("sekali mengisi datetime-local waktu lokal", () => {
    const hasil = specToForm({ kind: "once", at: "2026-11-20T09:00:00.000Z" });
    expect(hasil.kind).toBe("once");
    expect(hasil.at).toBe(toDateTimeLocal(new Date("2026-11-20T09:00:00.000Z")));
  });

  test("berulang mengisi menit", () => {
    expect(specToForm({ kind: "every", minutes: 120 }).everyMinutes).toBe("120");
  });

  test("harian mengisi jam dan hari urut", () => {
    const hasil = specToForm({ kind: "daily", time: "07:30", days: [3, 1] });
    expect(hasil.kind).toBe("daily");
    expect(hasil.time).toBe("07:30");
    expect(hasil.days).toEqual([1, 3]);
  });

  test("bolak-balik dengan formToSpec", () => {
    const spec: ScheduleSpec = { kind: "daily", time: "07:30", days: [1, 2, 3] };
    const hasil = formToSpec(specToForm(spec), new Date(2026, 10, 16, 10, 0, 0));
    expect(hasil).toEqual({ ok: true, spec });
  });
});

describe("waktu lokal", () => {
  test("parseLocalDateTime menolak bentuk tak sah", () => {
    expect(parseLocalDateTime("2026-11-20 09:00")).toBeUndefined();
    expect(parseLocalDateTime("2026-13-01T09:00")).toBeUndefined();
  });

  test("toDateTimeLocal memakai waktu lokal", () => {
    expect(toDateTimeLocal(new Date(2026, 10, 20, 9, 5, 0))).toBe("2026-11-20T09:05");
  });
});
