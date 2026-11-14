/**
 * Kemiripan dua memory dihitung dari himpunan kata pada judul dan isi.
 * Kata dinormalkan: huruf kecil, tanpa tanda baca, dan hanya kata dengan
 * panjang minimal tiga karakter yang dihitung.
 */

/** Panjang minimum kata yang ikut dihitung. */
const MIN_WORD_LENGTH = 3;

/** Ambang kemiripan Jaccard agar dua memory dianggap soal yang sama. */
export const MEMORY_SIMILARITY_MIN = 0.35;

/**
 * Himpunan kata unik dari teks: huruf kecil, tanpa tanda baca, dan hanya kata
 * dengan panjang minimal tiga karakter.
 */
export function wordSet(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_WORD_LENGTH) continue;
    words.add(raw);
  }
  return words;
}

/**
 * Kemiripan Jaccard dua teks: irisan dibagi gabungan. Dua teks kosong (atau
 * tanpa kata yang cukup panjang) bernilai nol, bukan tak hingga.
 */
export function similarity(a: string, b: string): number {
  const left = wordSet(a);
  const right = wordSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) shared += 1;
  }
  const union = left.size + right.size - shared;
  if (union === 0) return 0;
  return shared / union;
}

/**
 * Kemiripan dua memory (judul dan isi digabung). Nilainya antara 0 dan 1.
 */
export function memorySimilarity(
  a: { title: string; body: string },
  b: { title: string; body: string },
): number {
  return similarity(`${a.title}\n${a.body}`, `${b.title}\n${b.body}`);
}

/**
 * Kata kunci untuk pencarian FTS: kata unik huruf kecil yang hanya berisi
 * huruf dan angka, dengan panjang minimal tiga karakter.
 */
export function keywords(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_WORD_LENGTH) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    found.push(raw);
  }
  return found;
}
