/** Logika murni modal konfirmasi; tanpa DOM supaya bisa diuji terpisah. */

/** Nada tombol konfirmasi: "danger" untuk aksi merusak, "default" untuk yang biasa. */
export type ConfirmTone = "danger" | "default";

/** Tombol yang menerima fokus awal saat modal dibuka. */
export type ConfirmFocusTarget = "confirm" | "cancel";

/**
 * Aksi berbahaya fokus awalnya tombol Batal, supaya tidak mudah tanpa sengaja.
 * Aksi biasa fokus awalnya tombol konfirmasi.
 */
export function initialFocusTarget(tone: ConfirmTone): ConfirmFocusTarget {
  return tone === "danger" ? "cancel" : "confirm";
}

/**
 * Indeks fokus berikutnya di dalam kartu; berputar di ujung daftar.
 * `current` boleh di luar rentang (mis. -1 saat fokus belum ada di dalam).
 */
export function nextFocusIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return 0;
  const base = ((current % count) + count) % count;
  return (base + direction + count) % count;
}

/** Saat aksi sedang berjalan, modal tidak boleh ditutup. */
export function canDismiss(busy: boolean): boolean {
  return !busy;
}

/** Kelas tombol konfirmasi sesuai nada. */
export function confirmButtonClass(tone: ConfirmTone): string {
  return tone === "danger" ? "jk-button jk-button-caution" : "jk-button jk-button-primary";
}
