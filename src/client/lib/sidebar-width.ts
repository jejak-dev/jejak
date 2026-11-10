export const SIDEBAR_STORAGE_KEY = "jejak.sidebarWidth";
export const SIDEBAR_DEFAULT = 264;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_STEP = 16;

export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(value)));
}

export function parseSidebarWidth(value: unknown): number {
  if (typeof value !== "string" || value.trim() === "") return SIDEBAR_DEFAULT;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT;
}

export function loadSidebarWidth(storage: Pick<Storage, "getItem"> | undefined): number {
  try {
    return parseSidebarWidth(storage?.getItem(SIDEBAR_STORAGE_KEY));
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

export function saveSidebarWidth(storage: Pick<Storage, "setItem"> | undefined, width: number): void {
  try {
    storage?.setItem(SIDEBAR_STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    // penyimpanan diblokir: lebar berlaku untuk sesi ini saja
  }
}

/** Lebar baru dari tombol panah/Home pada pegangan; undefined bila tombol tak dikenal. */
export function widthForKey(current: number, key: string): number | undefined {
  switch (key) {
    case "ArrowLeft":
      return clampSidebarWidth(current - SIDEBAR_STEP);
    case "ArrowRight":
      return clampSidebarWidth(current + SIDEBAR_STEP);
    case "Home":
      return SIDEBAR_DEFAULT;
    default:
      return undefined;
  }
}
