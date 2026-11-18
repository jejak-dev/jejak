/**
 * Skrip tetap yang disisipkan server ke dalam frame desain. Isi sebenarnya
 * (sorot/pilih elemen, pengukuran tinggi, pesan `postMessage`) menyusul di
 * komit lain; untuk sekarang hanya penanda kosong agar klien bisa mengenali
 * dokumen yang sudah dirakit.
 */
export function frameRuntimeScript(): string {
  return "<script data-jejak-design-runtime></script>";
}
