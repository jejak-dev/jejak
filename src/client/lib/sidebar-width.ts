import { paneWidth } from "./pane-width";

export const SIDEBAR_STORAGE_KEY = "jejak.sidebarWidth";
export const SIDEBAR_DEFAULT = 264;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_STEP = 16;

export const sidebarWidth = paneWidth({
  key: SIDEBAR_STORAGE_KEY,
  def: SIDEBAR_DEFAULT,
  min: SIDEBAR_MIN,
  max: SIDEBAR_MAX,
  step: SIDEBAR_STEP,
});

export const clampSidebarWidth = sidebarWidth.clamp;
export const parseSidebarWidth = sidebarWidth.parse;
export const loadSidebarWidth = sidebarWidth.load;
export const saveSidebarWidth = sidebarWidth.save;

/** Lebar baru dari tombol panah/Home pada pegangan; undefined bila tombol tak dikenal. */
export function widthForKey(current: number, key: string): number | undefined {
  return sidebarWidth.forKey(current, key, "ArrowRight");
}
