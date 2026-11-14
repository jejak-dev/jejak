import { defaultLayout, normalizeLayout, type PaneLayout } from "./pane-layout";
import { PANEL_TAB_IDS, readPanelPrefs, type PanelTab } from "./panel-prefs";

const STORAGE_KEY = "jejak.panes";

function isTab(value: unknown): value is PanelTab {
  return typeof value === "string" && (PANEL_TAB_IDS as readonly string[]).includes(value);
}

/** Apakah data tersimpan memuat setidaknya satu tab yang sah. */
function adaTabValid(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const panes = (value as { panes?: unknown }).panes;
  if (!Array.isArray(panes)) return false;
  return panes.some((pane) => {
    if (typeof pane !== "object" || pane === null || Array.isArray(pane)) return false;
    const tabs = (pane as { tabs?: unknown }).tabs;
    return Array.isArray(tabs) && tabs.some(isTab);
  });
}

/**
 * Baca tata letak jendela dari penyimpanan. Bentuk rusak, penyimpanan yang
 * melempar, atau data kosong akan memakai tab terakhir dari preferensi panel
 * lama supaya pengguna lama tetap melihat alat yang biasa dipakai.
 */
export function readPaneLayout(storage?: Pick<Storage, "getItem">): PaneLayout {
  try {
    const sumber = storage ?? globalThis.localStorage;
    const raw = sumber.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined || raw === "") {
      return defaultLayout(readPanelPrefs().tab);
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!adaTabValid(parsed)) return defaultLayout(readPanelPrefs().tab);
    return normalizeLayout(parsed);
  } catch {
    return defaultLayout(readPanelPrefs().tab);
  }
}

/** Simpan tata letak jendela; kegagalan penyimpanan tidak menggagalkan UI. */
export function writePaneLayout(layout: PaneLayout, storage?: Pick<Storage, "setItem">): void {
  try {
    const sumber = storage ?? globalThis.localStorage;
    sumber.setItem(STORAGE_KEY, JSON.stringify(normalizeLayout(layout)));
  } catch {
    // Penyimpanan diblokir (mode privat); tata letak tetap berlaku untuk sesi ini.
  }
}
