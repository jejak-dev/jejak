import { PANEL_MIN } from "./panel-width";
import { paneWidth } from "./pane-width";

/** Lebar kolom chat saat mode lebar: cukup untuk membaca balasan agent. */
export const CHAT_WIDE_MIN = 320;
export const CHAT_WIDE_DEFAULT = 380;
export const CHAT_WIDE_MAX = 720;
/** Panel (kanvas) boleh jauh lebih lebar dari batas biasa saat mode lebar. */
export const WIDE_PANEL_MAX = 3000;

export const chatWidth = paneWidth({
  key: "jejak.designChatWidth",
  def: CHAT_WIDE_DEFAULT,
  min: CHAT_WIDE_MIN,
  max: CHAT_WIDE_MAX,
  step: 20,
});

/** Lebar jendela cadangan saat nilai tak hingga (mis. render tanpa DOM). */
const VIEWPORT_FALLBACK = 1280;

export interface WideLayout {
  chat: number;
  panel: number;
  panelMin: number;
  panelMax: number;
}

/** Mode lebar hanya untuk desktop; layar sempit dan ponsel memakai tata letak biasa. */
export function wideAvailable(input: { narrow: boolean; mobile: boolean }): boolean {
  return !input.narrow && !input.mobile;
}

function safeViewport(viewport: number): number {
  return Number.isFinite(viewport) ? viewport : VIEWPORT_FALLBACK;
}

/** Chat dijepit ke 320..720 dan tak boleh membuat panel lebih sempit dari PANEL_MIN. */
function clampChat(value: number, viewport: number): number {
  if (!Number.isFinite(value)) return CHAT_WIDE_DEFAULT;
  const batasAtas = Math.max(CHAT_WIDE_MIN, Math.min(CHAT_WIDE_MAX, Math.round(viewport - PANEL_MIN)));
  return Math.min(batasAtas, Math.max(CHAT_WIDE_MIN, Math.round(value)));
}

/**
 * Pembagian lebar saat mode lebar: chat di kiri, panel mengambil sisanya.
 * Nilai chat/panel selalu bilangan bulat dan tidak pernah negatif.
 */
export function wideLayout(input: { viewport: number; chat: number }): WideLayout {
  const viewport = safeViewport(input.viewport);
  const chat = clampChat(input.chat, viewport);
  const panel = Math.max(1, Math.min(WIDE_PANEL_MAX, Math.round(viewport - chat)));
  const panelMax = Math.max(PANEL_MIN, Math.min(WIDE_PANEL_MAX, Math.round(viewport - CHAT_WIDE_MIN)));
  const panelMin = Math.min(panelMax, Math.max(PANEL_MIN, Math.round(viewport - CHAT_WIDE_MAX)));
  return { chat, panel, panelMin, panelMax };
}

/** Lebar chat yang sesuai bila panel digeser ke lebar tersebut, dijepit 320..720. */
export function chatFromPanel(viewport: number, panel: number): number {
  const lebar = safeViewport(viewport);
  if (!Number.isFinite(panel)) return CHAT_WIDE_DEFAULT;
  return clampChat(lebar - panel, lebar);
}
