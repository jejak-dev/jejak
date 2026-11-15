/**
 * Logika murni untuk komponen Select.
 *
 * Dipisah dari komponen supaya bisa diuji tanpa DOM: navigasi keyboard,
 * ketik-huruf-awal, dan perhitungan tempat menu agar tak meluber keluar
 * panel sempit atau jendela.
 */

/** Satu pilihan di dalam menu Select. */
export interface SelectOption {
  /** Nilai yang diteruskan ke pemanggil saat opsi dipilih. */
  value: string;
  /** Teks yang tampil di menu dan di pemicu. */
  label: string;
  /** Keterangan kecil di kanan (mis. status rencana). */
  hint?: string;
  /** Opsi tak bisa dipilih; dilewati saat navigasi keyboard. */
  disabled?: boolean;
}

/** Kotak pemicu dalam koordinat layar. */
export interface TriggerRect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
}

/** Ukuran area tampilan (viewport). */
export interface Viewport {
  width: number;
  height: number;
}

/** Tempat menu setelah dihitung agar tetap di dalam layar. */
export interface MenuPosition {
  /** Jarak menu dari atas layar. */
  top: number;
  /** Jarak menu dari kiri layar. */
  left: number;
  /** Tinggi maksimum menu sebelum isinya di-scroll. */
  maxHeight: number;
  /** Lebar minimum menu; lebarnya mengikuti pemicu atau isi menu. */
  minWidth: number;
  /** Menu dibuka ke atas karena tak muat ke bawah. */
  flipped: boolean;
}

/** Jarak antara pemicu dan menu. */
export const MENU_GAP = 6;
/** Jarak aman dari tepi layar. */
export const MENU_EDGE = 8;
/** Lebar maksimum menu (28rem). */
export const MENU_MAX_WIDTH = 448;
/** Tinggi minimum menu walau ruang layar sempit. */
export const MENU_MIN_HEIGHT = 96;

/**
 * Indeks opsi aktif berikutnya yang bisa dipilih.
 *
 * Melewati opsi disabled, berputar ke awal bila sudah di ujung.
 * Mengembalikan -1 bila tak ada opsi yang bisa dipilih.
 */
export function nextEnabledIndex(
  options: readonly SelectOption[],
  from: number,
  direction: 1 | -1,
): number {
  const total = options.length;
  if (total === 0) return -1;
  for (let step = 1; step <= total; step += 1) {
    const index = (((from + step * direction) % total) + total) % total;
    const option = options[index];
    if (option !== undefined && option.disabled !== true) return index;
  }
  return -1;
}

/** Indeks opsi pertama yang bisa dipilih; -1 bila semua mati. */
export function firstEnabledIndex(options: readonly SelectOption[]): number {
  return nextEnabledIndex(options, -1, 1);
}

/** Indeks opsi terakhir yang bisa dipilih; -1 bila semua mati. */
export function lastEnabledIndex(options: readonly SelectOption[]): number {
  return nextEnabledIndex(options, options.length, -1);
}

/**
 * Indeks opsi yang labelnya diawali huruf yang diketik pengguna.
 *
 * Pencarian dimulai dari opsi setelah `from` lalu berputar; opsi disabled
 * dilewati. Mengembalikan -1 bila tak ada yang cocok.
 */
export function typeAheadIndex(
  options: readonly SelectOption[],
  query: string,
  from: number,
): number {
  const needle = query.trim().toLowerCase();
  if (needle === "") return -1;
  const total = options.length;
  for (let step = 1; step <= total; step += 1) {
    const index = (((from + step) % total) + total) % total;
    const option = options[index];
    if (option === undefined || option.disabled === true) continue;
    if (option.label.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/**
 * Tempat menu agar tak meluber keluar panel atau jendela.
 *
 * Bila menu tak muat ke bawah, dibuka ke atas; bila tetap tak muat, tinggi
 * menu dibatasi ruang sisa sehingga isinya bisa di-scroll. Sisi menu
 * mengikuti `align`: rata kiri atau rata kanan dengan pemicu.
 */
export function menuPlacement(
  rect: TriggerRect,
  viewport: Viewport,
  menuHeight: number,
  menuWidth: number,
  align: "start" | "end" = "start",
): MenuPosition {
  const below = viewport.height - rect.bottom - MENU_GAP;
  const above = rect.top - MENU_GAP;
  const flipped = menuHeight > below && above > below;
  const space = flipped ? above : below;
  const maxHeight = Math.max(space, MENU_MIN_HEIGHT);
  const height = Math.min(menuHeight, maxHeight);

  let top = flipped ? rect.top - MENU_GAP - height : rect.bottom + MENU_GAP;
  // Jaga menu tetap di dalam layar walau ruangnya sempit.
  top = Math.min(Math.max(top, MENU_EDGE), Math.max(MENU_EDGE, viewport.height - MENU_EDGE - height));

  const maxWidth = Math.min(viewport.width - MENU_EDGE * 2, MENU_MAX_WIDTH);
  const width = Math.min(menuWidth, maxWidth);
  const start = align === "end" ? rect.left + rect.width - width : rect.left;
  const left = Math.min(
    Math.max(start, MENU_EDGE),
    Math.max(MENU_EDGE, viewport.width - MENU_EDGE - width),
  );

  return {
    top,
    left,
    maxHeight,
    minWidth: Math.min(rect.width, MENU_MAX_WIDTH),
    flipped,
  };
}
