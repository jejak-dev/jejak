import type { ScheduleSpec } from "../../server/sessions/schedule-time";
import type { ScheduledTask } from "../../server/sessions/scheduled-tasks";

/**
 * Pustaka jadwal tugas: mengubah spec jadwal menjadi kalimat yang bisa
 * dibaca orang, dan sebaliknya antara spec dan state formulir.
 *
 * Semua fungsi murni; tak ada akses jaringan atau penyimpanan.
 */

/** Nama hari penuh; urutan mengikuti `Date.getDay()` (0 = Minggu). */
export const HARI_PENUH = [
  "Minggu",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
] as const;

/** Nama hari singkat untuk tombol dan daftar. */
export const HARI_SINGKAT = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"] as const;

/** Nama bulan singkat; urutan mengikuti `Date.getMonth()`. */
const BULAN_SINGKAT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
] as const;

/** Interval bawaan saat memilih jadwal berulang (menit). */
export const DEFAULT_EVERY_MINUTES = 30;

/** Jam bawaan untuk jadwal harian. */
export const DEFAULT_DAILY_TIME = "09:00";

/** Batas interval berulang (menit), sama seperti batas server. */
export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 10080;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Jam dinding lokal "HH:MM". */
export function formatJam(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Tanggal lokal "17 Nov 2026". */
export function formatTanggal(date: Date): string {
  return `${date.getDate()} ${BULAN_SINGKAT[date.getMonth()]} ${date.getFullYear()}`;
}

/** Tanggal lokal tanpa tahun "17 Nov". */
export function formatTanggalPendek(date: Date): string {
  return `${date.getDate()} ${BULAN_SINGKAT[date.getMonth()]}`;
}

/** Nama hari singkat untuk angka hari 0..6. */
export function dayShortName(day: number): string {
  return HARI_SINGKAT[day] ?? "";
}

/**
 * Awal dan akhir rentang hari yang berurutan (berputar lewat akhir minggu).
 * `undefined` bila hari yang dipilih bukan satu rentang berurutan.
 */
function rentangHari(days: number[]): { start: number; end: number } | undefined {
  const set = new Set(days);
  for (const start of days) {
    let lengkap = true;
    for (let offset = 0; offset < days.length; offset += 1) {
      if (!set.has((start + offset) % 7)) {
        lengkap = false;
        break;
      }
    }
    if (lengkap) {
      return { start, end: (start + days.length - 1) % 7 };
    }
  }
  return undefined;
}

/** Bagian hari dari jadwal harian: "Harian", "Senin–Jumat", atau "Sen, Rab". */
export function describeHari(days: number[]): string {
  const unik = [...new Set(days)].sort((a, b) => a - b);
  if (unik.length === 0 || unik.length === 7) return "Harian";
  if (unik.length === 1) return HARI_PENUH[unik[0]!] ?? "Harian";
  const rentang = rentangHari(unik);
  if (rentang !== undefined) {
    return `${HARI_PENUH[rentang.start] ?? ""}–${HARI_PENUH[rentang.end] ?? ""}`;
  }
  return unik.map((day) => HARI_SINGKAT[day] ?? "").join(", ");
}

/** Kalimat ringkas untuk sebuah jadwal. */
export function describeSpec(spec: ScheduleSpec): string {
  if (spec.kind === "once") {
    const date = new Date(spec.at);
    if (Number.isNaN(date.getTime())) return "Sekali";
    return `Sekali, ${formatTanggal(date)} ${formatJam(date)}`;
  }
  if (spec.kind === "every") {
    const minutes = spec.minutes;
    if (minutes % 60 === 0) return `Tiap ${minutes / 60} jam`;
    return `Tiap ${minutes} menit`;
  }
  return `${describeHari(spec.days ?? [])} ${spec.time}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Kalimat tentang kapan tugas berjalan berikutnya.
 *
 * Tugas sekali yang sudah jalan disebut "Selesai"; tugas yang dimatikan
 * disebut "Nonaktif".
 */
export function describeNext(task: ScheduledTask, now: Date): string {
  if (task.spec.kind === "once" && task.nextRunAt === undefined) return "Selesai";
  if (!task.enabled) return "Nonaktif";
  if (task.nextRunAt === undefined) return "Selesai";

  const next = new Date(task.nextRunAt);
  if (Number.isNaN(next.getTime())) return "Selesai";

  const selisih = next.getTime() - now.getTime();
  if (selisih <= 60_000) return "Berikutnya: sebentar lagi";
  if (sameDay(next, now)) {
    const menit = Math.round(selisih / 60_000);
    if (menit < 60) return `Berikutnya: ${Math.max(1, menit)} menit lagi`;
    return `Berikutnya: ${Math.round(menit / 60)} jam lagi`;
  }
  const besok = new Date(now.getTime());
  besok.setDate(besok.getDate() + 1);
  if (sameDay(next, besok)) return `Berikutnya: besok ${formatJam(next)}`;
  return `Berikutnya: ${formatTanggalPendek(next)} ${formatJam(next)}`;
}

/** Jenis jadwal yang bisa dipilih di formulir. */
export type ScheduleKind = "once" | "every" | "daily";

/** State formulir jadwal. */
export interface ScheduleFormValues {
  kind: ScheduleKind;
  /** Nilai `datetime-local`: "YYYY-MM-DDTHH:MM" (waktu lokal). */
  at: string;
  /** Interval berulang dalam menit, sebagai teks. */
  everyMinutes: string;
  /** Jam dinding harian "HH:MM". */
  time: string;
  /** Hari yang dipilih; 0 = Minggu .. 6 = Sabtu. */
  days: number[];
}

/** Hasil konversi formulir ke spec jadwal. */
export type ScheduleFormResult =
  | { ok: true; spec: ScheduleSpec }
  | { ok: false; error: string };

const DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Baca "YYYY-MM-DDTHH:MM" sebagai waktu lokal; `undefined` bila tak cocok. */
export function parseLocalDateTime(value: string): Date | undefined {
  const match = DATETIME_PATTERN.exec(value.trim());
  if (match === null) return undefined;
  const tahun = Number(match[1]);
  const bulan = Number(match[2]);
  const hari = Number(match[3]);
  const jam = Number(match[4]);
  const menit = Number(match[5]);
  const date = new Date(tahun, bulan - 1, hari, jam, menit, 0, 0);
  if (Number.isNaN(date.getTime())) return undefined;
  // Tanggal yang meluber (mis. 31 Feb) ditolak.
  if (
    date.getFullYear() !== tahun ||
    date.getMonth() !== bulan - 1 ||
    date.getDate() !== hari
  ) {
    return undefined;
  }
  return date;
}

/** Tulis waktu lokal sebagai "YYYY-MM-DDTHH:MM". */
export function toDateTimeLocal(date: Date): string {
  const hari = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${hari}T${formatJam(date)}`;
}

/**
 * Ubah state formulir menjadi spec jadwal, dengan pemeriksaan.
 *
 * Jadwal sekali harus berada di masa depan; jadwal berulang harus berupa
 * bilangan bulat 5..10080 menit; jadwal harian memakai jam "HH:MM" dan
 * daftar hari (kosong berarti tiap hari).
 */
export function formToSpec(
  form: ScheduleFormValues,
  now: Date = new Date(),
): ScheduleFormResult {
  if (form.kind === "once") {
    const date = parseLocalDateTime(form.at);
    if (date === undefined) {
      return { ok: false, error: "Isi tanggal dan waktu untuk jadwal sekali jalan." };
    }
    if (date.getTime() <= now.getTime()) {
      return { ok: false, error: "Waktu menjalankan tugas harus berada di masa depan." };
    }
    return { ok: true, spec: { kind: "once", at: date.toISOString() } };
  }

  if (form.kind === "every") {
    const trimmed = form.everyMinutes.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, error: "Interval harus bilangan bulat dalam menit." };
    }
    const minutes = Number(trimmed);
    if (minutes < MIN_EVERY_MINUTES || minutes > MAX_EVERY_MINUTES) {
      return {
        ok: false,
        error: `Interval harus antara ${MIN_EVERY_MINUTES} menit dan ${MAX_EVERY_MINUTES} menit (1 minggu).`,
      };
    }
    return { ok: true, spec: { kind: "every", minutes } };
  }

  const time = form.time.trim();
  if (!TIME_PATTERN.test(time)) {
    return { ok: false, error: "Jam harus berformat HH:MM." };
  }
  const days = [...new Set(form.days)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  if (days.length === 0) {
    return { ok: true, spec: { kind: "daily", time } };
  }
  return { ok: true, spec: { kind: "daily", time, days } };
}

/** Ubah spec jadwal menjadi state formulir. */
export function specToForm(spec: ScheduleSpec): ScheduleFormValues {
  if (spec.kind === "once") {
    const date = new Date(spec.at);
    return {
      kind: "once",
      at: Number.isNaN(date.getTime()) ? "" : toDateTimeLocal(date),
      everyMinutes: String(DEFAULT_EVERY_MINUTES),
      time: DEFAULT_DAILY_TIME,
      days: [],
    };
  }
  if (spec.kind === "every") {
    return {
      kind: "every",
      at: "",
      everyMinutes: String(spec.minutes),
      time: DEFAULT_DAILY_TIME,
      days: [],
    };
  }
  return {
    kind: "daily",
    at: "",
    everyMinutes: String(DEFAULT_EVERY_MINUTES),
    time: spec.time,
    days: [...(spec.days ?? [])].sort((a, b) => a - b),
  };
}
