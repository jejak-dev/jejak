/**
 * Penjaga rahasia untuk memory. Fungsi tunggal ini dipakai semua jalur tulis
 * supaya pesan galat dan jenis pola selalu konsisten.
 *
 * Mengembalikan NAMA jenis pola (mis. "kunci API") dan tidak pernah teks yang
 * cocok, supaya pemanggil aman menampilkan alasan penolakan.
 */

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { name: "kunci privat", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { name: "token Bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/i },
  { name: "kunci API", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}/ },
  { name: "token GitHub", pattern: /\bghp_[A-Za-z0-9]{8,}/ },
  { name: "token GitLab", pattern: /\bglpat-[A-Za-z0-9_-]{8,}/ },
  { name: "kunci AWS", pattern: /\bAKIA[0-9A-Z]{12,}/ },
  {
    name: "kredensial",
    pattern: /(?:password|passwd|secret|token|api[_-]?key)["']?\s*[=:]\s*["']?\S{8,}/i,
  },
];

/**
 * Token acak panjang: huruf, angka, dan karakter base64/URL yang beruntun.
 *
 * Jalur berkas juga bisa panjang dan beruntun (mis. folder bersarang), jadi
 * tokennya diperiksa lebih dulu sebelum dianggap rahasia.
 */
const TOKEN_ACAK_PANJANG = /[A-Za-z0-9+/=_-]{40,}/g;

/** Panjang segmen jalur yang masih dianggap nama berkas, bukan string acak. */
const MAX_SEGMENT_JALUR = 32;

/** Panjang minimal segmen huruf besar + angka agar dianggap string acak. */
const MIN_SEGMENT_ACAK = 6;

/**
 * Apakah segmen ini terlihat seperti bagian string acak, bukan nama berkas.
 *
 * Nama berkas biasanya huruf kecil (atau kapital di awal) dan angka. String
 * acak(base64/hex) campur huruf besar, huruf kecil, dan angka dalam satu
 * segmen, atau huruf besar semua dengan angka.
 */
function segmenAcak(segmen: string): boolean {
  const adaBesar = /[A-Z]/.test(segmen);
  const adaKecil = /[a-z]/.test(segmen);
  const adaAngka = /[0-9]/.test(segmen);
  if (adaBesar && adaKecil && adaAngka) return true;
  // Huruf besar semua + angka (mis. "K7MDENG"): bukan nama berkas biasa.
  return adaBesar && !adaKecil && adaAngka && segmen.length >= MIN_SEGMENT_ACAK;
}

/**
 * Apakah token ini terlihat seperti jalur berkas, bukan string acak.
 *
 * Jalur: ada pemisah "/", tiap segmen pendek, dan tiap segmen bukan campur
 * acak. Tanpa "/", atau dengan segmen panjang/campur, token tetap dianggap
 * string acak (mis. kunci AWS secret 40 karakter).
 */
function tampakJalur(token: string): boolean {
  const segmen = token.split("/");
  // Pemisah "/" sendiri harus ada sekurang-kurangnya dua kali.
  if (segmen.length - 1 < 2) return false;
  for (const bagian of segmen) {
    if (bagian.length >= MAX_SEGMENT_JALUR) return false;
    if (segmenAcak(bagian)) return false;
  }
  return true;
}

/**
 * Mengembalikan nama jenis rahasia yang ditemukan, atau null bila teks bersih.
 */
export function findSecret(text: string): string | null {
  for (const { name, pattern } of PATTERNS) {
    if (pattern.test(text)) {
      return name;
    }
  }
  // Pola "string acak panjang": jalur berkas panjang bukan rahasia, jadi
  // token yang tampak seperti jalur diabaikan.
  for (const cocok of text.matchAll(TOKEN_ACAK_PANJANG)) {
    const token = cocok[0];
    if (token === undefined) continue;
    if (!tampakJalur(token)) return "string acak panjang";
  }
  return null;
}
