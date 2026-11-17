export const SIDEBAR_HIDDEN_KEY = "jejak.sidebarHidden";

/** Baca nilai tersimpan: hanya "1" yang berarti tersembunyi. */
export function parseSidebarHidden(raw: string | null | undefined): boolean {
  return raw === "1";
}

/** Muat pilihan sembunyikan sidebar; penyimpanan rusak berarti tetap tampil. */
export function loadSidebarHidden(storage?: Pick<Storage, "getItem">): boolean {
  try {
    return parseSidebarHidden(storage?.getItem(SIDEBAR_HIDDEN_KEY));
  } catch {
    return false;
  }
}

/** Simpan pilihan sembunyikan sidebar; penyimpanan diblokir diabaikan. */
export function saveSidebarHidden(storage: Pick<Storage, "setItem">, hidden: boolean): void {
  try {
    storage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // penyimpanan tidak tersedia
  }
}
