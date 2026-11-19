import type { DesignToken } from "./api";

/**
 * Logika token desain di klien. Murni: tanpa DOM, tanpa jaringan. Token
 * dibaca dari berkas CSS milik pengguna, jadi nilainya diperlakukan sebagai
 * teks biasa.
 */

/** Jenis nilai token; menentukan kontrol yang dipakai di panel. */
export type TokenKind = "color" | "length" | "text";

/** Satu kelompok token pada panel. */
export interface TokenGroup {
  title: string;
  tokens: DesignToken[];
}

/** Warna hex 3, 4, 6, atau 8 digit (tanpa tanda pagar di dalam). */
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/** Fungsi warna CSS; awalan saja, sisanya tak diperiksa. */
const COLOR_FUNC_RE = /^(?:rgb|rgba|hsl|hsla)\(/i;
/** Angka dengan satuan px/rem/em/% atau angka murni. */
const LENGTH_RE = /^-?\d+(?:\.\d+)?(?:px|rem|em|%)?$/i;

/** Nama variabel CSS yang sah; sama dengan aturan server. */
const NAME_RE = /^--[A-Za-z0-9_-]{1,64}$/;

/** Batas panjang nilai token; sama dengan aturan server. */
const MAX_VALUE_LENGTH = 200;

/** Jenis nilai token: warna, ukuran, atau teks bebas. */
export function tokenKind(value: string): TokenKind {
  const text = value.trim();
  if (HEX_RE.test(text)) return "color";
  if (COLOR_FUNC_RE.test(text)) return "color";
  if (LENGTH_RE.test(text)) return "length";
  return "text";
}

/**
 * Mengelompokkan token untuk ditampilkan. Urutan kelompok: Warna, Ukuran,
 * Font, Lainnya. Token pertama yang cocok masuk kelompoknya; urutan asli
 * di dalam kelompok dipertahankan dan kelompok kosong dibuang.
 */
export function groupTokens(tokens: DesignToken[]): TokenGroup[] {
  const warna: DesignToken[] = [];
  const ukuran: DesignToken[] = [];
  const font: DesignToken[] = [];
  const lainnya: DesignToken[] = [];

  for (const token of tokens) {
    const name = token.name.toLowerCase();
    const kind = tokenKind(token.value);
    if (name.startsWith("--warna") || name.startsWith("--color") || kind === "color") {
      warna.push(token);
      continue;
    }
    if (kind === "length") {
      ukuran.push(token);
      continue;
    }
    if (name.includes("font")) {
      font.push(token);
      continue;
    }
    lainnya.push(token);
  }

  const groups: TokenGroup[] = [
    { title: "Warna", tokens: warna },
    { title: "Ukuran", tokens: ukuran },
    { title: "Font", tokens: font },
    { title: "Lainnya", tokens: lainnya },
  ];
  return groups.filter((group) => group.tokens.length > 0);
}

/**
 * Jumlah token yang berubah: nilai berbeda, token baru, atau token dihapus.
 * Dipakai untuk menghitung tombol "Simpan token (n)".
 */
export function diffTokens(saved: DesignToken[], draft: DesignToken[]): number {
  const sebelum = new Map(saved.map((token) => [token.name, token.value]));
  const sesudah = new Map(draft.map((token) => [token.name, token.value]));
  let jumlah = 0;
  for (const [name, value] of sesudah) {
    const lama = sebelum.get(name);
    if (lama === undefined || lama !== value) jumlah += 1;
  }
  for (const name of sebelum.keys()) {
    if (!sesudah.has(name)) jumlah += 1;
  }
  return jumlah;
}

/** Nama token sah: `--` diikuti huruf, angka, garis bawah, atau tanda hubung. */
export function isValidTokenName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * Nilai token sah: tidak kosong, maksimal 200 karakter, tanpa tanda struktural
 * CSS dan tanpa baris baru.
 */
export function isValidTokenValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) return false;
  if (value.includes(";") || value.includes("{") || value.includes("}")) return false;
  if (value.includes("</")) return false;
  if (/[\r\n]/.test(value)) return false;
  return true;
}

/**
 * Warna hex untuk `<input type="color">`: hanya `#rgb` dan `#rrggbb` yang
 * diterima; hasilnya huruf kecil. Nilai lain (`rgb()`, named color) tak
 * punya padanan hex, jadi `undefined`.
 */
export function hexForColorInput(value: string): string | undefined {
  const text = value.trim();
  const cocok = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text);
  if (cocok === null) return undefined;
  const hex = cocok[1]!.toLowerCase();
  if (hex.length === 3) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  return `#${hex}`;
}
