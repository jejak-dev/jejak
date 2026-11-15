import type { RewindEvent } from "./rewind";

/**
 * Saran prompt berikutnya yang sah untuk sesi ini.
 *
 * Saran datang dari SDK setelah satu giliran selesai; teksnya sudah dipotong
 * server (300 karakter).
 */
export interface Suggestion {
  /** Teks saran. */
  text: string;
  /** Nomor urut event saran; dipakai untuk menandai chip yang sudah dipakai. */
  seq: number;
}

/**
 * Saran prompt terakhir pada daftar event sesi.
 *
 * Saran berlaku sampai ada pesan pengguna berikutnya: pesan itu membatalkan
 * saran lama karena konteks percakapan sudah berubah.
 */
export function latestSuggestion(events: readonly RewindEvent[]): Suggestion | undefined {
  let current: Suggestion | undefined;
  for (const item of events) {
    const event = item.event;
    if (event.type === "suggestion") {
      current = { text: event.text, seq: item.seq };
      continue;
    }
    if (event.type === "user_message") current = undefined;
  }
  return current;
}

/**
 * Aturan tampilan chip saran.
 *
 * Chip hanya tampil saat sesi diam, kolom balasan kosong, dan saran itu
 * belum dipakai (diklik, diisi lewat Tab, atau ditutup).
 */
export function showsSuggestion(options: {
  suggestion?: Suggestion;
  /** Sesi sedang berjalan. */
  running: boolean;
  /** Isi kolom balasan saat ini. */
  text: string;
  /** Nomor urut saran yang sudah dipakai atau ditutup. */
  dismissedSeq?: number;
}): boolean {
  const { suggestion, running, text, dismissedSeq } = options;
  if (suggestion === undefined) return false;
  if (suggestion.text.trim() === "") return false;
  if (running) return false;
  if (text.trim() !== "") return false;
  if (dismissedSeq !== undefined && dismissedSeq === suggestion.seq) return false;
  return true;
}

/** Hasil memakai saran: isi kolom balasan dan chip yang sudah dipakai. */
export interface SuggestionFill {
  /** Teks untuk kolom balasan. */
  text: string;
  /** Nomor urut saran yang dipakai; chip-nya mati. */
  dismissedSeq: number;
}

/**
 * Memakai saran: teksnya mengisi kolom balasan, chip-nya hilang.
 *
 * Saran tak pernah dikirim sendiri; pengirim tetap tombol kirim.
 */
export function fillSuggestion(suggestion: Suggestion): SuggestionFill {
  return { text: suggestion.text, dismissedSeq: suggestion.seq };
}

/** Aksi tombol di kolom balasan. */
export type ReplyKeyAction =
  /** Kirim pesan (enter tanpa shift). */
  | { kind: "kirim" }
  /** Isi kolom dengan saran (tab saat kolom kosong). */
  | { kind: "pakai-saran" }
  /** Biarkan apa adanya (termasuk shift+enter untuk baris baru). */
  | { kind: "biarkan" };

/**
 * Aksi tombol di kolom balasan.
 *
 * "Tab" memakai saran yang tampil (kolom balasan kosong); enter tanpa shift
 * mengirim pesan.
 */
export function replyKeyAction(options: {
  key: string;
  shiftKey?: boolean;
  composing?: boolean;
  /** Chip saran sedang tampil. */
  suggestionVisible: boolean;
}): ReplyKeyAction {
  if (options.key === "Tab" && options.suggestionVisible) return { kind: "pakai-saran" };
  if (
    options.key !== "Enter" ||
    options.shiftKey === true ||
    options.composing === true
  ) {
    return { kind: "biarkan" };
  }
  return { kind: "kirim" };
}
