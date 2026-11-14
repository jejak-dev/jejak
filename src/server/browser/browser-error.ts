/**
 * Kode galat browser: mati, tidak ditemukan, tidak valid, gagal, atau batas.
 *
 * "batas" dipakai saat permintaan melebihi batas (jumlah tab, ukuran body,
 * laju input) dan dipetakan ke HTTP 429.
 */
export type BrowserErrorCode =
  | "mati"
  | "tidak-ditemukan"
  | "tidak-valid"
  | "gagal"
  | "batas";

/** Galat browser; pesan selalu Bahasa Indonesia dan aman ditampilkan. */
export class BrowserError extends Error {
  constructor(
    message: string,
    public readonly code: BrowserErrorCode,
  ) {
    super(message);
    this.name = "BrowserError";
  }
}
