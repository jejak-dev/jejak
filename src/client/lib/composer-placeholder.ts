/**
 * Placeholder kolom tugas di komposer.
 *
 * Layar sempit memakai teks pendek supaya placeholder tak membungkus tiga
 * baris di textarea sempit; layar lebar tetap memakai contoh yang lengkap.
 */

/** Placeholder layar lebar. */
export const PLACEHOLDER_TUGAS = "Tulis tugas, mis. “jelaskan struktur proyek ini”";

/** Placeholder layar sempit. */
export const PLACEHOLDER_TUGAS_SEMPIT = "Tulis tugas…";

/** Placeholder mengikuti lebar layar. */
export function placeholderTugas(sempit: boolean): string {
  return sempit ? PLACEHOLDER_TUGAS_SEMPIT : PLACEHOLDER_TUGAS;
}
