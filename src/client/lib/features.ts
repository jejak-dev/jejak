import { providersHash } from "./format";

/** Fitur yang bisa dinyalakan lewat Pengaturan. */
export const FEATURE_NAMES = ["terminal", "browser"] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Status satu fitur: menyala atau mati, dan terkunci env atau tidak. */
export interface FeatureState {
  enabled: boolean;
  locked: boolean;
}

/** Status seluruh fitur. */
export interface FeatureStatus {
  terminal: FeatureState;
  browser: FeatureState;
}

/** Variabel lingkungan yang mengunci tiap fitur. */
export const FEATURE_ENV: Record<FeatureName, string> = {
  terminal: "JEJAK_TERMINAL",
  browser: "JEJAK_BROWSER",
};

/** Nama fitur untuk ditampilkan. */
export const FEATURE_LABELS: Record<FeatureName, string> = {
  terminal: "Terminal",
  browser: "Browser",
};

/** Keterangan singkat tiap fitur di kartu Pengaturan. */
export const FEATURE_DESCRIPTIONS: Record<FeatureName, string> = {
  terminal:
    "Akses shell penuh pada komputermu, tanpa sandbox. Nyalakan hanya bila kamu yang mengendalikan sesinya.",
  browser:
    "Chromium terpisah yang bisa dilihat di panel dan dipakai agent. Memakai profil sendiri, bukan profil Chrome-mu.",
};

/** Pesan risiko saat menyalakan fitur (dipakai di modal konfirmasi). */
export const FEATURE_RISKS: Record<FeatureName, string> = {
  terminal:
    "Terminal memberi akses shell penuh dengan hak akunmu, tanpa sandbox. Perintah agent di terminal berjalan tanpa batas dan bisa mengubah berkas di komputermu.",
  browser:
    "Browser memakai profil terpisah milik Jejak. Agent bisa membuka halaman dan melihat isinya lewat panel browser.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateFrom(raw: unknown): FeatureState | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.enabled !== "boolean" || typeof raw.locked !== "boolean") return undefined;
  return { enabled: raw.enabled, locked: raw.locked };
}

/** Baca status fitur dari respons server; bentuk asing ditolak. */
export function parseFeatureStatus(raw: unknown): FeatureStatus | undefined {
  if (!isRecord(raw)) return undefined;
  const terminal = stateFrom(raw.terminal);
  const browser = stateFrom(raw.browser);
  if (terminal === undefined || browser === undefined) return undefined;
  return { terminal, browser };
}

/** Pesan galat singkat dari galat API atau galat biasa. */
export function featureErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "Permintaan gagal.";
}

/** Petunjuk saat fitur mati: terkunci env atau bisa dinyalakan di Pengaturan. */
export interface FeatureOffHint {
  /**.True bila nilai fitur dikunci variabel lingkungan. */
  locked: boolean;
  /** Keterangan singkat yang ditampilkan. */
  text: string;
  /** Nama variabel lingkungan yang mengunci fitur. */
  env: string;
}

export function featureOffHint(
  name: FeatureName,
  state: FeatureState | undefined,
): FeatureOffHint {
  const env = FEATURE_ENV[name];
  const label = FEATURE_LABELS[name];
  if (state?.locked === true) {
    return {
      locked: true,
      text: `${label} dikunci oleh variabel lingkungan ${env}. Ubah nilainya di luar Jejak, lalu jalankan ulang.`,
      env,
    };
  }
  return {
    locked: false,
    text: `${label} dimatikan. Nyalakan di halaman Pengaturan bila kamu membutuhkannya.`,
    env,
  };
}

/** Buka halaman Pengaturan (rute yang sama dipakai sidebar). */
export function openFeatureSettings(): void {
  if (typeof window === "undefined") return;
  window.location.hash = providersHash();
}
