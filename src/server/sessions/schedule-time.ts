import { SessionError } from "./session-manager";

/**
 * Jadwal tugas terjadwal. Semua waktu memakai waktu lokal server: tak ada
 * cron dan tak ada zona waktu per tugas. Ramping ini cukup untuk kebutuhan
 * Jejak; apa yang lebih rumit butuh layanan penjadwal penuh.
 */
export type ScheduleSpec =
  /** Satu kali pada waktu tertentu (ISO UTC). */
  | { kind: "once"; at: string }
  /** Ulangi tiap beberapa menit (5..10080). */
  | { kind: "every"; minutes: number }
  /** Harian pada jam tertentu; `days` = 0 (Minggu) .. 6 (Sabtu). */
  | { kind: "daily"; time: string; days?: number[] };

/** Interval terkecil "every" (menit). */
export const MIN_EVERY_MINUTES = 5;
/** Interval terbesar "every" (menit), yaitu satu minggu. */
export const MAX_EVERY_MINUTES = 10080;

/** Pola jam "HH:MM" (24 jam). */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Uraikan waktu "HH:MM" jadi jam dan menit; `undefined` bila tak cocok.
 */
function parseTime(time: string): { hour: number; minute: number } | undefined {
  const match = TIME_PATTERN.exec(time);
  if (match === null) return undefined;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Jadwalkan waktu jalan berikutnya.
 *
 * - `once`: waktu yang diminta bila masih di depan `from`; tak ada lagi bila
 *   sudah lewat.
 * - `every`: `lastRun + minutes` (atau `from + minutes` bila belum pernah
 *   jalan). Bila hasilnya tak lagi di masa depan, jadwalkan satu interval
 *   dari `from`; kemunduran tak dikejar berkali-kali.
 * - `daily`: jam dinding lokal pada hari terdekat setelah `from` yang masuk
 *   `days` (kosong = tiap hari). Lompatan DST memakai jam dinding apa adanya
 *   dari `Date`: pada hari yang jamnya hilang, jadwal bisa bergeser beberapa
 *   menit. Batas ini diterima untuk versi ramping ini.
 */
export function nextRun(
  spec: ScheduleSpec,
  from: Date,
  lastRun?: Date,
): Date | undefined {
  const now = from.getTime();
  switch (spec.kind) {
    case "once": {
      const at = Date.parse(spec.at);
      if (!Number.isFinite(at)) return undefined;
      return at > now ? new Date(at) : undefined;
    }
    case "every": {
      const base = (lastRun ?? from).getTime() + spec.minutes * 60_000;
      const target = base > now ? base : now + spec.minutes * 60_000;
      return new Date(target);
    }
    case "daily": {
      const parsed = parseTime(spec.time);
      if (parsed === undefined) return undefined;
      const days = spec.days;
      // Maju maksimum tujuh hari: satu minggu selalu memuat hari yang diizinkan.
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = new Date(
          from.getFullYear(),
          from.getMonth(),
          from.getDate() + offset,
          parsed.hour,
          parsed.minute,
          0,
          0,
        );
        if (candidate.getTime() <= now) continue;
        if (days !== undefined && days.length > 0 && !days.includes(candidate.getDay())) {
          continue;
        }
        return candidate;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Baca jadwal dari nilai mentah (JSON) dan pastikan bentuknya benar.
 * Galat memakai `SessionError` kode "tidak-valid" supaya rute memetakannya
 * jadi HTTP 400 tanpa penanganan khusus.
 *
 * `now` dipakai untuk memeriksa waktu "once": jadwal sekali jalan harus
 * berada di masa depan saat tugas dibuat.
 */
export function parseSpec(value: unknown, now: Date = new Date()): ScheduleSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionError("Field spec harus berupa objek.", "tidak-valid");
  }
  const record = value as Record<string, unknown>;

  if (record.kind === "once") {
    const at = record.at;
    if (typeof at !== "string" || at.trim() === "") {
      throw new SessionError("Field at harus berupa teks ISO.", "tidak-valid");
    }
    const parsed = Date.parse(at);
    if (!Number.isFinite(parsed)) {
      throw new SessionError("Field at harus berupa waktu ISO yang valid.", "tidak-valid");
    }
    if (parsed <= now.getTime()) {
      throw new SessionError("Waktu at harus berada di masa depan.", "tidak-valid");
    }
    return { kind: "once", at: new Date(parsed).toISOString() };
  }

  if (record.kind === "every") {
    const minutes = record.minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes)) {
      throw new SessionError("Field minutes harus berupa bilangan bulat.", "tidak-valid");
    }
    if (minutes < MIN_EVERY_MINUTES || minutes > MAX_EVERY_MINUTES) {
      throw new SessionError(
        `Field minutes harus antara ${MIN_EVERY_MINUTES} dan ${MAX_EVERY_MINUTES}.`,
        "tidak-valid",
      );
    }
    return { kind: "every", minutes };
  }

  if (record.kind === "daily") {
    const time = record.time;
    if (typeof time !== "string" || !TIME_PATTERN.test(time)) {
      throw new SessionError("Field time harus berformat HH:MM.", "tidak-valid");
    }
    const days = record.days;
    if (days === undefined) {
      return { kind: "daily", time };
    }
    if (!Array.isArray(days)) {
      throw new SessionError("Field days harus berupa array.", "tidak-valid");
    }
    const unique: number[] = [];
    for (const day of days) {
      if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
        throw new SessionError("Field days hanya boleh berisi angka 0..6.", "tidak-valid");
      }
      if (unique.includes(day)) {
        throw new SessionError("Field days tidak boleh mengulang angka yang sama.", "tidak-valid");
      }
      unique.push(day);
    }
    unique.sort((a, b) => a - b);
    // Array kosong berarti tiap hari; sama dengan `days` tak ada.
    if (unique.length === 0) return { kind: "daily", time };
    return { kind: "daily", time, days: unique };
  }

  throw new SessionError(
    "Jenis jadwal harus 'once', 'every', atau 'daily'.",
    "tidak-valid",
  );
}
