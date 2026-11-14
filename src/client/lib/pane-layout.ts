import { PANEL_TAB_IDS, type PanelTab } from "./panel-prefs";

/** Batas jumlah jendela bertumpuk yang boleh aktif bersamaan. */
export const MAX_PANES = 3;
/** Ukuran minimum satu jendela sebagai pecahan tinggi (dari 0 sampai 1). */
export const MIN_SIZE = 0.15;
/** Toleransi jumlah ukuran agar tetap dianggap satu. */
const SIZE_EPSILON = 1e-9;
/** Ukuran jendela baru saat sebuah tab dipindahkan ke arah tanpa tetangga. */
const NEW_PANE_SIZE = 0.4;
/** Langkah geser pembatas untuk navigasi keyboard. */
const KEY_STEP = 0.05;

/** Satu jendela bertumpuk: deretan tab dan tab yang sedang aktif. */
export interface Pane {
  id: string;
  tabs: PanelTab[];
  active: PanelTab;
}

/** Susunan seluruh jendela bertumpuk beserta tinggi masing-masing. */
export interface PaneLayout {
  panes: Pane[];
  /** Pecahan tinggi per jendela, jumlah 1. */
  sizes: number[];
  /** Id jendela yang diperbesar, atau undefined. */
  maximized?: string;
}

function isTab(value: unknown): value is PanelTab {
  return typeof value === "string" && (PANEL_TAB_IDS as readonly string[]).includes(value);
}

function clonePane(pane: Pane): Pane {
  return { id: pane.id, tabs: [...pane.tabs], active: pane.active };
}

function cloneLayout(layout: PaneLayout): PaneLayout {
  const cloned: PaneLayout = {
    panes: layout.panes.map(clonePane),
    sizes: [...layout.sizes],
  };
  if (layout.maximized !== undefined) cloned.maximized = layout.maximized;
  return cloned;
}

/** Id jendela berikutnya dibuat berurutan dari id terbesar yang ada. */
function nextPaneId(panes: readonly Pane[]): string {
  let tertinggi = 0;
  for (const pane of panes) {
    const cocok = /^p(\d+)$/.exec(pane.id);
    if (cocok) tertinggi = Math.max(tertinggi, Number(cocok[1]));
  }
  return `p${tertinggi + 1}`;
}

function equalSizes(count: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, () => 1 / count);
}

/**
 * Susun ulang ukuran supaya valid: jumlah sesuai jumlah jendela, tiap ukuran
 * tidak di bawah {@link MIN_SIZE}, dan jumlah seluruhnya satu.
 */
function fixSizes(sizes: unknown, count: number): number[] {
  if (count <= 0) return [];
  if (!Array.isArray(sizes) || sizes.length !== count) return equalSizes(count);
  const values = sizes.map((value) => (typeof value === "number" ? value : Number.NaN));
  if (!values.every((value) => Number.isFinite(value) && value >= MIN_SIZE)) return equalSizes(count);
  const jumlah = values.reduce((a, b) => a + b, 0);
  if (Math.abs(jumlah - 1) > SIZE_EPSILON) return equalSizes(count);
  return values;
}

/**
 * Bagi ukuran jendela yang hilang ke tetangganya secara proporsional.
 * Jumlah akhir tetap satu dan tiap ukuran tidak pernah mengecil.
 */
function redistribute(sizes: number[], removedIndex: number): number[] {
  const remaining = sizes.filter((_, index) => index !== removedIndex);
  if (remaining.length === 0) return [];
  const hilang = sizes[removedIndex] ?? 0;
  const total = remaining.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(total) || total <= 0) return equalSizes(remaining.length);
  const dibagi = remaining.map((value) => value + (hilang * value) / total);
  const jumlah = dibagi.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(jumlah) || jumlah <= 0) return equalSizes(remaining.length);
  return dibagi.map((value) => value / jumlah);
}

/**
 * Perkecil ukuran jendela yang ada agar totalnya sesuai `budget`, dengan menghormati
 * {@link MIN_SIZE}. Bila minimum tidak muat, dibagi rata.
 */
function shrinkToBudget(sizes: number[], budget: number): number[] {
  const count = sizes.length;
  if (count === 0) return [];
  const total = sizes.reduce((a, b) => a + b, 0);
  let shares =
    Number.isFinite(total) && total > 0
      ? sizes.map((value) => (value / total) * budget)
      : new Array<number>(count).fill(budget / count);
  shares = shares.map((value) => (value < MIN_SIZE ? MIN_SIZE : value));
  const jumlah = shares.reduce((a, b) => a + b, 0);
  if (jumlah > budget) {
    const sama = budget / count;
    return new Array<number>(count).fill(sama >= MIN_SIZE ? sama : MIN_SIZE);
  }
  if (jumlah < budget) {
    const sisa = budget - jumlah;
    let terbesar = 0;
    for (let index = 1; index < shares.length; index += 1) {
      if ((shares[index] ?? 0) > (shares[terbesar] ?? 0)) terbesar = index;
    }
    shares[terbesar] = (shares[terbesar] ?? 0) + sisa;
  }
  return shares;
}

/** Tata letak bawaan: satu jendela dengan satu tab. */
export function defaultLayout(tab: PanelTab = "changes"): PaneLayout {
  return { panes: [{ id: "p1", tabs: [tab], active: tab }], sizes: [1] };
}

/**
 * Ubah data tak tepercaya menjadi tata letak yang sah: tab tak dikenal dan
 * duplikat dibuang, jendela kosong dibuang, jumlah dibatasi, tab aktif
 * diperbaiki, ukuran dihitung ulang bila rusak, dan `maximized` tak valid
 * dibuang.
 */
export function normalizeLayout(value: unknown): PaneLayout {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return defaultLayout();
  const raw = value as Record<string, unknown>;
  const rawPanes = Array.isArray(raw.panes) ? raw.panes : [];
  const rawSizes = Array.isArray(raw.sizes) ? raw.sizes : [];
  const seen = new Set<PanelTab>();
  const panes: Pane[] = [];
  const indeksAsal: number[] = [];
  const idsDipakai = new Set<string>();

  for (let index = 0; index < rawPanes.length && panes.length < MAX_PANES; index += 1) {
    const candidate = rawPanes[index];
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const pane = candidate as Record<string, unknown>;
    const rawTabs = Array.isArray(pane.tabs) ? pane.tabs : [];
    const tabs: PanelTab[] = [];
    for (const rawTab of rawTabs) {
      if (!isTab(rawTab) || seen.has(rawTab)) continue;
      seen.add(rawTab);
      tabs.push(rawTab);
    }
    if (tabs.length === 0) continue;
    const active = isTab(pane.active) && tabs.includes(pane.active) ? pane.active : tabs[0]!;
    let id = typeof pane.id === "string" && pane.id.trim() !== "" ? pane.id : "";
    if (id === "" || idsDipakai.has(id)) id = nextPaneId(panes);
    idsDipakai.add(id);
    panes.push({ id, tabs, active });
    indeksAsal.push(index);
  }

  if (panes.length === 0) return defaultLayout();

  const ukuranMentah = indeksAsal.map((index) => rawSizes[index]);
  const sizes = fixSizes(ukuranMentah, panes.length);

  const layout: PaneLayout = { panes, sizes };
  if (typeof raw.maximized === "string" && panes.some((pane) => pane.id === raw.maximized)) {
    layout.maximized = raw.maximized;
  }
  return layout;
}

/**
 * Buka sebuah tab. Bila tab sudah terbuka, tab itu menjadi aktif di jendela
 * tempatnya; bila belum, tab ditambahkan ke jendela yang difokuskan
 * (`focusId`, bawaan jendela terakhir).
 */
export function openTool(layout: PaneLayout, tab: PanelTab, focusId?: string): PaneLayout {
  const next = cloneLayout(layout);
  const existing = next.panes.findIndex((pane) => pane.tabs.includes(tab));
  if (existing >= 0) {
    const pane = next.panes[existing]!;
    pane.active = tab;
    if (next.maximized !== undefined && next.maximized !== pane.id) delete next.maximized;
    return next;
  }
  let target = focusId === undefined ? -1 : next.panes.findIndex((pane) => pane.id === focusId);
  if (target < 0) target = next.panes.length - 1;
  if (target < 0) {
    next.panes.push({ id: "p1", tabs: [tab], active: tab });
    next.sizes = [1];
    return next;
  }
  const pane = next.panes[target]!;
  pane.tabs.push(tab);
  pane.active = tab;
  if (next.maximized !== undefined && next.maximized !== pane.id) delete next.maximized;
  return next;
}

/**
 * Tutup sebuah tab. Bila jendelanya jadi kosong, jendela itu dihapus dan
 * ukurannya dibagi ke tetangga. Tab terakhir pada satu-satunya jendela tidak
 * bisa ditutup.
 */
export function closeTab(layout: PaneLayout, tab: PanelTab): PaneLayout {
  const index = layout.panes.findIndex((pane) => pane.tabs.includes(tab));
  if (index < 0) return layout;
  const pane = layout.panes[index]!;
  if (layout.panes.length === 1 && pane.tabs.length === 1) return layout;

  const next = cloneLayout(layout);
  const target = next.panes[index]!;
  target.tabs.splice(target.tabs.indexOf(tab), 1);
  if (target.tabs.length === 0) {
    next.panes.splice(index, 1);
    next.sizes = redistribute(next.sizes, index);
  } else if (target.active === tab) {
    target.active = target.tabs[0]!;
  }
  if (next.maximized !== undefined && !next.panes.some((entry) => entry.id === next.maximized)) {
    delete next.maximized;
  }
  return next;
}

/** Tutup sebuah jendela beserta seluruh tabnya; jendela terakhir tidak bisa ditutup. */
export function closePane(layout: PaneLayout, paneId: string): PaneLayout {
  const index = layout.panes.findIndex((pane) => pane.id === paneId);
  if (index < 0) return layout;
  if (layout.panes.length === 1) return layout;
  const next = cloneLayout(layout);
  next.panes.splice(index, 1);
  next.sizes = redistribute(next.sizes, index);
  if (next.maximized === paneId) delete next.maximized;
  return next;
}

/** Jadikan sebuah tab aktif pada jendela tertentu. */
export function setActive(layout: PaneLayout, paneId: string, tab: PanelTab): PaneLayout {
  const index = layout.panes.findIndex((pane) => pane.id === paneId);
  if (index < 0) return layout;
  const pane = layout.panes[index]!;
  if (!pane.tabs.includes(tab)) return layout;
  const next = cloneLayout(layout);
  next.panes[index]!.active = tab;
  return next;
}

/** Arah pemindahan tab ke jendela sebelah. */
export type MoveDirection = "atas" | "bawah";

/**
 * Pindahkan sebuah tab ke jendela sebelah. Bila tidak ada jendela sebelah dan
 * jumlah jendela masih di bawah {@link MAX_PANES}, jendela baru dibuat di arah
 * itu. Bila sudah di tepi dan jumlah jendela sudah maksimum, tata letak tetap.
 */
export function moveTab(
  layout: PaneLayout,
  tab: PanelTab,
  direction: MoveDirection,
): PaneLayout {
  const sourceIndex = layout.panes.findIndex((pane) => pane.tabs.includes(tab));
  if (sourceIndex < 0) return layout;
  const neighborIndex = direction === "atas" ? sourceIndex - 1 : sourceIndex + 1;
  const punyaTetangga = neighborIndex >= 0 && neighborIndex < layout.panes.length;
  if (!punyaTetangga && layout.panes.length >= MAX_PANES) return layout;

  const next = cloneLayout(layout);
  const source = next.panes[sourceIndex]!;
  source.tabs.splice(source.tabs.indexOf(tab), 1);
  if (source.tabs.length > 0 && source.active === tab) source.active = source.tabs[0]!;
  const sourceKosong = source.tabs.length === 0;

  if (punyaTetangga) {
    const destination = next.panes[neighborIndex]!;
    destination.tabs.push(tab);
    destination.active = tab;
    if (sourceKosong) {
      next.panes.splice(sourceIndex, 1);
      next.sizes = redistribute(next.sizes, sourceIndex);
    }
    return next;
  }

  if (sourceKosong) {
    next.panes.splice(sourceIndex, 1);
    next.sizes = redistribute(next.sizes, sourceIndex);
  }
  const insertAt = direction === "atas" ? sourceIndex : sourceIndex + 1;
  const baru: Pane = { id: nextPaneId(next.panes), tabs: [tab], active: tab };
  // Bila tidak ada jendela lain, jendela baru memakai seluruh tinggi.
  const adaTetangga = next.sizes.length > 0;
  const ukuranBaru = adaTetangga ? NEW_PANE_SIZE : 1;
  const diperkecil = adaTetangga ? shrinkToBudget(next.sizes, 1 - ukuranBaru) : [];
  diperkecil.splice(insertAt, 0, ukuranBaru);
  next.sizes = diperkecil;
  next.panes.splice(insertAt, 0, baru);
  return next;
}

/**
 * Geser pembatas antara jendela `index` dan `index+1` sebesar `deltaFraction`.
 * Hanya dua jendela itu yang berubah dan keduanya tidak boleh di bawah
 * {@link MIN_SIZE}; nilai di luar batas dijepit, bukan digagalkan.
 */
export function resizeBoundary(
  layout: PaneLayout,
  index: number,
  deltaFraction: number,
): PaneLayout {
  if (!Number.isFinite(index) || index < 0 || index >= layout.panes.length - 1) return layout;
  if (!Number.isFinite(deltaFraction)) return layout;
  const atas = layout.sizes[index];
  const bawah = layout.sizes[index + 1];
  if (atas === undefined || bawah === undefined) return layout;
  const total = atas + bawah;
  if (!Number.isFinite(total) || total <= 0) return layout;
  const batasAtas = Math.min(MIN_SIZE, total / 2);
  const batasBawah = total - batasAtas;
  const baruAtas = Math.min(batasBawah, Math.max(batasAtas, atas + deltaFraction));
  const next = cloneLayout(layout);
  next.sizes[index] = baruAtas;
  next.sizes[index + 1] = total - baruAtas;
  return next;
}

/**
 * Ubah tinggi jendela dengan keyboard. Panah menggeser 0,05; Home dan End
 * menjepit pembatas ke batas atas dan bawah. Kunci lain mengembalikan
 * undefined.
 */
export function resizeBoundaryByKey(
  layout: PaneLayout,
  index: number,
  key: string,
): PaneLayout | undefined {
  if (key === "ArrowUp") return resizeBoundary(layout, index, -KEY_STEP);
  if (key === "ArrowDown") return resizeBoundary(layout, index, KEY_STEP);
  if (key === "Home" || key === "End") {
    const atas = layout.sizes[index];
    const bawah = layout.sizes[index + 1];
    if (atas === undefined || bawah === undefined) return resizeBoundary(layout, index, 0);
    const total = atas + bawah;
    const target = key === "Home" ? MIN_SIZE : total - MIN_SIZE;
    return resizeBoundary(layout, index, target - atas);
  }
  return undefined;
}

/** Nyalakan atau matikan keadaan diperbesar sebuah jendela. */
export function toggleMaximize(layout: PaneLayout, paneId: string): PaneLayout {
  if (!layout.panes.some((pane) => pane.id === paneId)) return layout;
  const next = cloneLayout(layout);
  if (next.maximized === paneId) delete next.maximized;
  else next.maximized = paneId;
  return next;
}

/** Jendela tempat sebuah tab berada, atau undefined bila tab tidak terbuka. */
export function paneOfTool(layout: PaneLayout, tab: PanelTab): Pane | undefined {
  return layout.panes.find((pane) => pane.tabs.includes(tab));
}

/** Semua tab yang terbuka, urut jendela lalu urut tab. */
export function openTools(layout: PaneLayout): PanelTab[] {
  return layout.panes.flatMap((pane) => [...pane.tabs]);
}

/**
 * Jendela yang menjadi sasaran tab baru: jendela terakhir pada tata letak.
 * Karena tata letak tidak menyimpan riwayat pembukaan, jendela terakhir
 * dipakai sebagai penanda fokus.
 */
export function focusTarget(layout: PaneLayout): string | undefined {
  return layout.panes[layout.panes.length - 1]?.id;
}
