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
  { name: "string acak panjang", pattern: /[A-Za-z0-9+/=_-]{40,}/ },
];

/**
 * Mengembalikan nama jenis rahasia yang ditemukan, atau null bila teks bersih.
 */
export function findSecret(text: string): string | null {
  for (const { name, pattern } of PATTERNS) {
    if (pattern.test(text)) {
      return name;
    }
  }
  return null;
}
