/**
 * Dikte suara di sisi klien memakai Web Speech API bawaan peramban.
 *
 * Catatan privasi: Chrome dan Safari mengirim audio ke server vendor
 * peramban, jadi dikte hanya berjalan setelah persetujuan pengguna.
 * Server Jejak tidak pernah menyentuh audio.
 *
 * Tipe `SpeechRecognition` tidak dipakai langsung: pustaka DOM TypeScript
 * menyediakannya dengan bentuk berbeda tiap versi, jadi di sini dipakai
 * antarmuka minimal sendiri.
 */

/** Satu alternatif hasil pengenalan suara (transkrip kasar). */
export interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

/** Satu hasil pengenalan suara: final atau masih sementara. */
export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly 0: SpeechRecognitionAlternativeLike;
}

/** Daftar hasil pengenalan suara. */
export interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}

/** Peristiwa hasil pengenalan suara. */
export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

/** Peristiwa galat pengenalan suara. */
export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

/** Objek pengenal suara yang dibuat peramban. */
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

/** Pembuat objek pengenal suara. */
export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/** Jendela yang mungkin memuat pembangun pengenal suara. */
export interface RecognitionHost {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

/** Kunci penyimpanan persetujuan dikte. */
export const CONSENT_KEY = "jejak.dictation.consent";

/** Kunci penyimpanan bahasa dikte. */
export const LANG_KEY = "jejak.dictation.lang";

/** Bahasa dikte yang bisa dipilih. */
export const DICTATION_LANG_OPTIONS: { value: string; label: string }[] = [
  { value: "id-ID", label: "Indonesia" },
  { value: "en-US", label: "English" },
];

/** Pembuat pengenal suara yang tersedia di jendela ini, bila ada. */
export function getRecognitionCtor(
  win: RecognitionHost | null | undefined,
): SpeechRecognitionConstructor | undefined {
  if (win === null || win === undefined) return undefined;
  return win.SpeechRecognition ?? win.webkitSpeechRecognition;
}

/** Bahasa dikte bawaan: bahasa peramban bila Indonesia, selain itu `id-ID`. */
export function defaultLang(navLang: string | undefined): string {
  if (navLang !== undefined && /^id(-|$)/i.test(navLang)) return navLang;
  return "id-ID";
}

/** Gabung dua potong teks dengan satu spasi pemisah yang wajar. */
function joinText(left: string, right: string): string {
  if (left === "") return right;
  if (right === "") return left;
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right;
  return `${left} ${right}`;
}

export interface MergedTranscript {
  /** Teks kolom setelah digabung. */
  text: string;
  /** Posisi tepat setelah bagian final, di dalam `text`. */
  caret: number;
}

/**
 * Gabungkan teks dikte ke draf kolom.
 *
 * - `draft`: draf terikat. Hasil sementara (interim) tidak pernah masuk ke
 *   draf terikat, jadi hasil final tidak mungkin menggandakan teks lama.
 * - `caret`: posisi sisip di dalam draf; teks setelah posisi ini tetap utuh.
 * - `final`: seluruh teks final yang sudah terkumpul pada sesi dikte ini.
 * - `interim`: teks sementara yang sedang-recognized, ditampilkan setelah
 *   bagian final dan hilang begitu ada final penggantinya.
 *
 * Huruf besar-kecil tidak diubah; hanya spasi pemisah yang dirapikan.
 */
export function mergeTranscript(
  draft: string,
  caret: number,
  final: string,
  interim: string,
): MergedTranscript {
  const position = Math.max(0, Math.min(caret, draft.length));
  const prefix = draft.slice(0, position);
  const suffix = draft.slice(position);
  const finalPart = final.trim();
  const interimPart = interim.trim();

  const committed = joinText(prefix, finalPart);
  const withInterim = joinText(committed, interimPart);
  const text = joinText(withInterim, suffix);
  return { text, caret: committed.length };
}

/**
 * Pesan singkat untuk kode galat peramban. `undefined` berarti diam saja:
 * galat `no-speech` (tidak ada suara) dan `aborted` (dihentikan pengguna)
 * bukan masalah yang perlu dilaporkan.
 */
export function describeError(code: string): string | undefined {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Izin mikrofon ditolak. Ubah di pengaturan situs.";
    case "no-speech":
      return undefined;
    case "aborted":
      return undefined;
    case "network":
      return "Layanan suara tidak terjangkau (perlu internet).";
    case "audio-capture":
      return "Mikrofon tidak ditemukan.";
    default:
      return "Dikte berhenti karena kesalahan. Coba lagi.";
  }
}

export interface DictationHandlers {
  /** Teks final terkumpul dan teks sementara terakhir. */
  onResult: (final: string, interim: string) => void;
  /** Kode galat dari peramban. */
  onError: (code: string) => void;
  /** Pengenalan suara berakhir: selesai, dihentikan, atau gagal. */
  onEnd: () => void;
}

export interface DictationOptions extends DictationHandlers {
  ctor: SpeechRecognitionConstructor;
  lang: string;
}

export interface DictationController {
  /** Mulai merekam. */
  start: () => void;
  /** Berhenti; hasil terakhir masih bisa terkirim. */
  stop: () => void;
  /** Berhenti dan buang hasil yang belum jadi final. */
  abort: () => void;
}

/**
 * Bungkus pengenal suara peramban jadi pengendali sederhana. Teks final
 * dikumpulkan dari semua hasil final, teks sementara diambil dari hasil
 * terakhir yang belum final. Sesi yang berhenti sendiri tidak dinyalakan
 * ulang: pemanggil menerima `onEnd` dan memutuskan sendiri.
 */
export function createDictation({
  ctor,
  lang,
  onResult,
  onError,
  onEnd,
}: DictationOptions): DictationController {
  const recognition = new ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = lang;
  let finalText = "";

  recognition.onresult = (event: SpeechRecognitionEventLike): void => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result === undefined) continue;
      const transcript = (result[0]?.transcript ?? "").trim();
      if (transcript === "") continue;
      if (result.isFinal) finalText = joinText(finalText, transcript);
      else interim = joinText(interim, transcript);
    }
    onResult(finalText, interim);
  };

  recognition.onerror = (event: SpeechRecognitionErrorEventLike): void => {
    onError(event.error);
  };

  recognition.onend = (): void => {
    onEnd();
  };

  return {
    start: (): void => {
      try {
        recognition.start();
      } catch {
        onError("start-failed");
      }
    },
    stop: (): void => {
      recognition.stop();
    },
    abort: (): void => {
      recognition.abort();
    },
  };
}
