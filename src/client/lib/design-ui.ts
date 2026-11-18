import type { DesignPage, DeviceId } from "./api";

/**
 * Ukuran perangkat disalin dari `src/server/design/manifest.ts` (DEVICES).
 * Tidak diimpor langsung supaya kode server (node:fs, node:crypto) tidak
 * ikut masuk ke bundel klien. `tests/client-design-ui.test.ts` membandingkan
 * kedua daftar agar salinan ini tidak menyimpang.
 */
export const DEVICE_SIZES: Record<DeviceId, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
  "mobile-android": { width: 412, height: 915 },
};

/** Label tampilan per perangkat, urut seperti DEVICES. */
export const DEVICE_LABELS: Record<DeviceId, string> = {
  desktop: "Desktop",
  tablet: "Tablet",
  mobile: "Mobile",
  "mobile-android": "Android",
};

/** Urutan perangkat untuk tampilan; sama dengan urutan manifest. */
export const DEVICE_IDS: readonly DeviceId[] = [
  "desktop",
  "tablet",
  "mobile",
  "mobile-android",
];

/** Label Bahasa Indonesia untuk satu perangkat. */
export function deviceLabel(device: DeviceId): string {
  return DEVICE_LABELS[device];
}

/** Ukuran tampilan `1440 x 900` dari preset perangkat. */
export function deviceSizeLabel(device: DeviceId): string {
  const size = DEVICE_SIZES[device];
  return `${size.width} x ${size.height}`;
}

/** Satu baris daftar halaman di tab Desain. */
export interface DesignPageRow {
  slug: string;
  title: string;
  /** Route halaman (mis. `/`); kosong bila tidak ada. */
  route?: string;
  deviceLabel: string;
  sizeLabel: string;
  /** Berkas `design/pages/<slug>.html` belum ada di disk. */
  missing: boolean;
}

/** Baris tampilan halaman, urut seperti manifest. */
export function pageRows(pages: readonly DesignPage[]): DesignPageRow[] {
  return pages.map((page) => ({
    slug: page.slug,
    title: page.title,
    ...(page.route === undefined ? {} : { route: page.route }),
    deviceLabel: deviceLabel(page.device),
    sizeLabel: deviceSizeLabel(page.device),
    missing: page.missing,
  }));
}

/** Prompt contoh yang ditempel ke komposer setelah perancah dibuat. */
export const SAMPLE_PROMPT = [
  "Rancang satu halaman beranda untuk produk yang aku jelaskan di bawah ini.",
  "Ikuti aturan di design/DESIGN.md, simpan halaman sebagai design/pages/<slug>.html,",
  "lalu daftarkan slug, judul, perangkat, posisi x/y di design/design.json.",
  "Produk: <jelaskan produk, pengguna, dan tujuan halaman di sini>.",
].join(" ");

/** Cap berubah bila berbeda dari sebelumnya; `undefined` selalu berubah. */
export function shouldRefetch(prev: string | undefined, next: string): boolean {
  return prev !== next;
}
