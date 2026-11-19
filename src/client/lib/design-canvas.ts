import type { DeviceId } from "./api";
import { DEVICE_SIZES } from "./design-ui";

/**
 * Matematika kanvas desain. Murni: tanpa DOM, tanpa jaringan. Koordinat
 * layar = koordinat dunia * zoom + (x, y).
 */

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
/** Batas tinggi frame, sama dengan batas pesan `size` di protokol. */
export const MAX_FRAME_PX = 6000;

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Halaman yang dipakai untuk menghitung kotak frame. */
export interface FramePage {
  slug: string;
  x: number;
  y: number;
  device: DeviceId;
}

/** Jepit zoom ke 0.1..4; nilai tak hingga jatuh ke 1. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function screenToWorld(view: View, p: Point): Point {
  return { x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom };
}

export function worldToScreen(view: View, p: Point): Point {
  return { x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y };
}

/** Zoom baru dengan titik dunia di bawah jangkar tetap di tempat. */
export function zoomAt(view: View, newZoom: number, anchor: Point): View {
  const zoom = clampZoom(newZoom);
  const world = screenToWorld(view, anchor);
  return { x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom, zoom };
}

export function zoomBy(view: View, factor: number, anchor: Point): View {
  return zoomAt(view, view.zoom * factor, anchor);
}

export function panBy(view: View, dx: number, dy: number): View {
  return { x: view.x + dx, y: view.y + dy, zoom: view.zoom };
}

/** Tinggi frame: minimal tinggi preset, mengikuti isi, paling tinggi 6000 px. */
export function frameHeight(deviceHeight: number, contentHeight: number | undefined): number {
  const isi =
    contentHeight === undefined || !Number.isFinite(contentHeight)
      ? 0
      : Math.ceil(contentHeight);
  return Math.min(MAX_FRAME_PX, Math.max(deviceHeight, isi));
}

/** Kotak tiap frame dari posisi manifest dan tinggi isi yang dilaporkan. */
export function frameRects(
  pages: readonly FramePage[],
  contentHeights: Record<string, number>,
): Array<{ slug: string } & Rect> {
  return pages.map((page) => {
    const size = DEVICE_SIZES[page.device];
    return {
      slug: page.slug,
      x: page.x,
      y: page.y,
      width: size.width,
      height: frameHeight(size.height, contentHeights[page.slug]),
    };
  });
}

/** Kotak pembungkus semua frame; `undefined` bila kosong. */
export function boundsOf(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
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
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Halaman yang punya kelompok; dipakai untuk menghitung kotak kelompok. */
export interface GroupPage {
  slug: string;
  group?: string;
}

/** Kotak kelompok halaman: satu kubus pembungkus seluruh anggotanya. */
export interface GroupBox {
  group: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Slug anggota kelompok, urut kemunculan. */
  slugs: string[];
}

/**
 * Kotak kelompok halaman. Hanya kelompok dengan dua anggota atau lebih yang
 * digambar; kelompok bernama sama selalu jadi satu kotak. Kotak dilebihkan
 * `pad` di semua sisi supaya tidak menempel frame di dalamnya.
 */
export function groupBoxes(
  pages: readonly GroupPage[],
  rects: readonly ({ slug: string } & Rect)[],
  pad = 24,
): GroupBox[] {
  const bySlug = new Map(rects.map((rect) => [rect.slug, rect]));
  const urutan: string[] = [];
  const anggota = new Map<string, string[]>();
  for (const page of pages) {
    const group = page.group;
    if (group === undefined || group === "") continue;
    const list = anggota.get(group);
    if (list === undefined) {
      anggota.set(group, [page.slug]);
      urutan.push(group);
      continue;
    }
    list.push(page.slug);
  }

  const kotak: GroupBox[] = [];
  for (const group of urutan) {
    const slugs = anggota.get(group) ?? [];
    if (slugs.length < 2) continue;
    const rectAnggota = slugs
      .map((slug) => bySlug.get(slug))
      .filter((rect): rect is { slug: string } & Rect => rect !== undefined);
    const batas = boundsOf(rectAnggota);
    if (batas === undefined) continue;
    kotak.push({
      group,
      x: batas.x - pad,
      y: batas.y - pad,
      width: batas.width + pad * 2,
      height: batas.height + pad * 2,
      slugs,
    });
  }
  return kotak;
}

/** Saran nama varian yang sering dipakai. */
export const variantSuggestions: readonly string[] = ["gelap", "kosong", "galat", "memuat"];

/** Tampilkan semua frame: zoom paling besar 1, dipusatkan di viewport. */
export function fitView(rects: readonly Rect[], viewport: Size, padding = 48): View {
  const bounds = boundsOf(rects);
  if (bounds === undefined) return { x: 0, y: 0, zoom: 1 };
  const lebar = Math.max(1, viewport.width - padding * 2);
  const tinggi = Math.max(1, viewport.height - padding * 2);
  const zoom = clampZoom(
    Math.min(1, lebar / Math.max(1, bounds.width), tinggi / Math.max(1, bounds.height)),
  );
  return {
    x: (viewport.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (viewport.height - bounds.height * zoom) / 2 - bounds.y * zoom,
    zoom,
  };
}

/** Pusatkan satu frame tanpa mengubah zoom. */
export function centerOn(view: View, rect: Rect, viewport: Size): View {
  return {
    x: viewport.width / 2 - (rect.x + rect.width / 2) * view.zoom,
    y: viewport.height / 2 - (rect.y + rect.height / 2) * view.zoom,
    zoom: view.zoom,
  };
}

/** Bulatkan ke kelipatan `step`; hasil nol selalu 0 (bukan -0). */
export function snap(value: number, step = 8): number {
  if (!Number.isFinite(value) || step <= 0) return 0;
  const hasil = Math.round(value / step) * step;
  return hasil === 0 ? 0 : hasil;
}

/** Slug frame yang beririsan dengan viewport (plus margin layar). */
export function visibleSlugs(
  rects: readonly ({ slug: string } & Rect)[],
  view: View,
  viewport: Size,
  margin = 200,
): string[] {
  const kiri = (-margin - view.x) / view.zoom;
  const atas = (-margin - view.y) / view.zoom;
  const kanan = (viewport.width + margin - view.x) / view.zoom;
  const bawah = (viewport.height + margin - view.y) / view.zoom;
  return rects
    .filter(
      (rect) =>
        rect.x < kanan &&
        rect.x + rect.width > kiri &&
        rect.y < bawah &&
        rect.y + rect.height > atas,
    )
    .map((rect) => rect.slug);
}

/**
 * Batasi jumlah iframe hidup. Bila melebihi `max`, ambil yang pusatnya
 * terdekat ke pusat viewport; hasil tetap dalam urutan masukan.
 */
export function pickLive(
  visible: readonly string[],
  rects: readonly ({ slug: string } & Rect)[],
  view: View,
  viewport: Size,
  max = 12,
): string[] {
  if (visible.length <= max) return [...visible];
  const pusat = screenToWorld(view, { x: viewport.width / 2, y: viewport.height / 2 });
  const bySlug = new Map(rects.map((rect) => [rect.slug, rect]));
  const kandidat = visible.map((slug, index) => {
    const rect = bySlug.get(slug);
    const jarak =
      rect === undefined
        ? Infinity
        : Math.hypot(rect.x + rect.width / 2 - pusat.x, rect.y + rect.height / 2 - pusat.y);
    return { slug, index, jarak };
  });
  kandidat.sort((a, b) => a.jarak - b.jarak || a.index - b.index);
  const dipilih = new Set(kandidat.slice(0, Math.max(0, max)).map((item) => item.slug));
  return visible.filter((slug) => dipilih.has(slug));
}

export interface WheelLike {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

export type WheelAction =
  | { kind: "zoom"; factor: number }
  | { kind: "pan"; dx: number; dy: number };

/** Terjemahkan roda mouse: Ctrl/Cmd = zoom, selain itu geser. */
export function wheelAction(event: WheelLike): WheelAction {
  const skala = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
  if (event.ctrlKey || event.metaKey) {
    const mentah = Math.exp(-event.deltaY * skala * 0.0015);
    const factor = Number.isFinite(mentah) ? Math.min(2, Math.max(0.5, mentah)) : 1;
    return { kind: "zoom", factor };
  }
  return { kind: "pan", dx: -event.deltaX * skala, dy: -event.deltaY * skala };
}

export const ZOOM_STEPS: readonly number[] = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** Langkah zoom berikutnya dari daftar tetap; berhenti di ujung. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const z = clampZoom(zoom);
  if (dir === 1) {
    for (const step of ZOOM_STEPS) {
      if (step > z + 1e-6) return step;
    }
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const step = ZOOM_STEPS[i];
    if (step !== undefined && step < z - 1e-6) return step;
  }
  return MIN_ZOOM;
}
