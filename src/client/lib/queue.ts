/**
 * Logika tampilan antrean pesan: isi antrean datang dari server (teks penuh),
 * klien hanya memotong tampilannya jadi satu baris.
 */

/** Panjang maksimum teks antrean pada tampilan satu baris. */
export const QUEUE_PREVIEW_MAX = 120;

/** Satu pesan antrean yang dilihat pengguna. */
export interface QueuedMessageView {
  id: string;
  text: string;
}

/**
 * Potong teks antrean untuk tampilan satu baris: baris baru dirapatkan dan
 * teks panjang dipotong elipsis. Teks penuh tetap tersedia lewat `title`.
 */
export function queuePreview(
  text: string,
  max: number = QUEUE_PREVIEW_MAX,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  if (max <= 1) return "…";
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}
