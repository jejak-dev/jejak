/**
 * Utilitas ekspor PNG desain di sisi klien. Perhitungan kotak, skala, dan
 * penempatan gambar fungsi murni (tanpa DOM) supaya mudah diuji; unduhan
 * berkas memakai `Blob` dan tautan `a[download]`.
 */

/** Skala tangkapan: 1 (ukuran layar) atau 2 (ganda). */
export type ExportScale = 1 | 2;

/** Margin di sekeliling seluruh kanvas, dalam satuan koordinat dunia. */
export const EXPORT_MARGIN = 40;
/** Batas sisi terpanjang gambar hasil ekspor. */
export const MAX_EXPORT_SIDE = 8192;
/** Nama berkas hasil ekspor seluruh kanvas. */
export const CANVAS_FILE_NAME = "kanvas-desain.png";
/** Latar kanvas ekspor; tidak pernah transparan. */
export const CANVAS_BACKGROUND = "#e9e9ec";
/** Jeda sebelum URL objek dicabut, supaya unduhan sempat mulai. */
export const REVOKE_DELAY_MS = 1000;

/** Alasan kegagalan ekspor, memakai pesan yang sama dengan broker tangkapan. */
export type ExportFailure = "tainted" | "too-large" | "no-frame" | "failed" | "timeout";

/** Pesan Bahasa Indonesia untuk tiap alasan kegagalan. */
export const EXPORT_FAILURE_MESSAGES: Record<ExportFailure, string> = {
  tainted: "Browser ini tidak mengizinkan tangkapan layar frame desain.",
  "too-large": "Halaman terlalu besar untuk ditangkap.",
  "no-frame": "Frame halaman belum tampil di kanvas.",
  failed: "Tangkapan layar gagal.",
  timeout: "Waktu menunggu halaman habis.",
};

/** Pesan singkat untuk satu alasan kegagalan ekspor. */
export function exportFailureMessage(reason: ExportFailure): string {
  return EXPORT_FAILURE_MESSAGES[reason];
}

/** Kotak satu frame di kanvas desain. */
export interface ExportRect {
  slug: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Kotak pembatas sekumpulan frame, dengan offset margin. */
export interface ExportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Posisi dan ukuran satu gambar dalam kanvas ekspor. */
export interface ShotPlacement {
  slug: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Satu tangkapan siap diletakkan di kanvas ekspor. */
export interface ExportShot {
  slug: string;
  /** Sumber gambar yang bisa digambar ke kanvas. */
  image: CanvasImageSource;
}

/**
 * Nama berkas PNG satu frame: `<slug>.png` atau `<slug>@2x.png`. Karakter
 * yang tak aman pada nama berkas diganti tanda hubung.
 */
export function exportFileName(slug: string, scale: ExportScale): string {
  const bersih = slug.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const nama = bersih === "" ? "halaman" : bersih;
  return `${nama}${scale === 2 ? "@2x" : ""}.png`;
}

/**
 * Kotak pembatas semua frame plus margin di semua sisi. Kotak pembatas
 * ikut bergeser ke koordinat negatif bila frame berada di sana. Daftar
 * kosong tidak punya kotak.
 */
export function canvasBounds(
  rects: readonly ExportRect[],
  margin: number = EXPORT_MARGIN,
): ExportBounds | undefined {
  if (rects.length === 0) return undefined;
  const pad = Number.isFinite(margin) ? margin : 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

/**
 * Skala komposisi agar sisi terpanjang tidak melebihi `maxSide`. Hasil tak
 * pernah lebih besar dari 1, jadi komposisi tak pernah diperbesar.
 */
export function fitScale(
  width: number,
  height: number,
  maxSide: number = MAX_EXPORT_SIDE,
): number {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 1;
  if (width <= 0 || height <= 0) return 1;
  if (!Number.isFinite(maxSide) || maxSide <= 0) return 1;
  return Math.min(1, maxSide / Math.max(width, height));
}

/**
 * Posisi dan ukuran tiap gambar relatif terhadap kotak pembatas. `scale`
 * adalah faktor dari koordinat dunia ke piksel kanvas ekspor.
 */
export function placeShots(
  rects: readonly ExportRect[],
  bounds: ExportBounds,
  scale: number,
): ShotPlacement[] {
  const faktor = Number.isFinite(scale) ? scale : 1;
  return rects.map((rect) => ({
    slug: rect.slug,
    x: (rect.x - bounds.x) * faktor,
    y: (rect.y - bounds.y) * faktor,
    width: rect.width * faktor,
    height: rect.height * faktor,
  }));
}

/** Ubah data URL PNG menjadi `Blob` supaya bisa diunduh lewat `a[download]`. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const pisah = dataUrl.indexOf(",");
  if (pisah < 0) return new Blob([], { type: "image/png" });
  const kepala = dataUrl.slice(0, pisah);
  const isi = dataUrl.slice(pisah + 1);
  const tipe = /data:([^;,]+)/.exec(kepala)?.[1] ?? "image/png";
  const biner = atob(isi);
  const byte = new Uint8Array(biner.length);
  for (let index = 0; index < biner.length; index += 1) {
    byte[index] = biner.charCodeAt(index);
  }
  return new Blob([byte], { type: tipe });
}

/**
 * Unduh blob sebagai berkas. Dokumen boleh disuntikkan supaya fungsi ini
 * bisa diuji tanpa peramban.
 */
export function downloadBlob(blob: Blob, name: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const tautan = doc.createElement("a");
  tautan.href = url;
  tautan.download = name;
  tautan.rel = "noopener";
  doc.body.appendChild(tautan);
  tautan.click();
  tautan.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/**
 * Unduh URL lewat tautan sementara. Rute ekspor memakai cookie sesi, jadi
 * tautan `a[download]` cukup: peramban mengirim cookie dan menyimpan respons
 * dengan nama berkas dari `content-disposition`.
 */
export function downloadUrl(url: string, doc: Document = document): void {
  const tautan = doc.createElement("a");
  tautan.href = url;
  tautan.download = "";
  tautan.rel = "noopener";
  doc.body.appendChild(tautan);
  tautan.click();
  tautan.remove();
}

/** Prompt untuk agent yang diminta memecah desain menjadi komponen React. */
export const REACT_EXPORT_PROMPT = [
  "Siapkan ekspor React dari desain di design/.",
  "Mulai dari proyek hasil konversi mekanis (unduh lewat menu Ekspor > Proyek React, atau baca design/pages/*.html).",
  "Pecah tiap halaman menjadi komponen kecil yang bermakna (Header, Hero, FormReservasi, dst.), beri nama komponen deskriptif,",
  "ubah teks dan gambar yang berubah-ubah menjadi props bertipe, pertahankan tampilan persis,",
  "taruh di folder design-react/ (src/components, src/pages, src/styles),",
  "jalankan npx tsc --noEmit dan pastikan lolos sebelum menyerahkan,",
  "lalu laporkan daftar komponen dan berkas.",
].join(" ");

/** Prompt pemecahan komponen React, dengan daftar halaman yang diekspor. */
export function reactExportPrompt(slugs: string[]): string {
  const daftar = slugs.filter((slug) => slug !== "");
  const baris =
    daftar.length === 0 ? "Semua halaman." : `Halaman yang diekspor: ${daftar.join(", ")}.`;
  return `${REACT_EXPORT_PROMPT} ${baris}`;
}

/**
 * Susun tangkapan semua frame ke satu kanvas luar layar. Latar diisi warna
 * tetap (tak transparan) lalu tiap gambar digambar pada tempatnya.
 */
export function composeCanvas(
  shots: readonly ExportShot[],
  rects: readonly ExportRect[],
  bounds: ExportBounds,
  scale: number,
  doc: Document = document,
): HTMLCanvasElement {
  const kanvas = doc.createElement("canvas");
  kanvas.width = Math.max(1, Math.round(bounds.width * scale));
  kanvas.height = Math.max(1, Math.round(bounds.height * scale));
  const konteks = kanvas.getContext("2d");
  if (konteks === null) throw new Error("Kanvas 2D tak tersedia.");
  konteks.fillStyle = CANVAS_BACKGROUND;
  konteks.fillRect(0, 0, kanvas.width, kanvas.height);
  const tempat = placeShots(rects, bounds, scale);
  for (const shot of shots) {
    const pos = tempat.find((item) => item.slug === shot.slug);
    if (pos === undefined) continue;
    konteks.drawImage(shot.image, pos.x, pos.y, pos.width, pos.height);
  }
  return kanvas;
}
