import { paneWidth } from "./pane-width";

export const PANEL_DEFAULT = 460;
export const PANEL_MIN = 280;
export const PANEL_MAX = 1400;
/** Lebar minimum kolom chat; panel tak boleh membuat kolom ini lebih sempit. */
export const PANEL_CHAT_MIN = 360;

export const panelWidth = paneWidth({
  key: "jejak.panelWidth",
  def: PANEL_DEFAULT,
  min: PANEL_MIN,
  max: PANEL_MAX,
  step: 20,
});

/**
 * Batas atas efektif panel: batas statis dijepit ruang yang tersisa di
 * jendela, supaya kolom chat tak pernah lebih sempit dari `chatMin`
 * (bawaan `PANEL_CHAT_MIN`; mode lebar memakai batas chat sendiri).
 * Hasilnya tak pernah di bawah `PANEL_MIN`.
 */
export function effectiveMax(viewport: number, sidebar: number, chatMin = PANEL_CHAT_MIN): number {
  if (!Number.isFinite(viewport) || !Number.isFinite(sidebar)) return PANEL_MAX;
  const batas = Math.round(viewport - sidebar - chatMin);
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, batas));
}

/**
 * Batas atas panel untuk layar sempit: panel jadi lapisan penuh di atas chat,
 * jadi lebar chat tak membatasi, tapi panel tak boleh melebihi jendela.
 */
export function effectiveMaxNarrow(viewport: number): number {
  if (!Number.isFinite(viewport)) return PANEL_MAX;
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(viewport - 32)));
}
