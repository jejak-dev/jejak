/** Kode galat browser: mati, tidak ditemukan, tidak valid, atau gagal. */
export type BrowserErrorCode = "mati" | "tidak-ditemukan" | "tidak-valid" | "gagal";

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
