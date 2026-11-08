export type TargetKind = "input" | "other";

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  targetKind?: TargetKind;
}

export type ShortcutAction =
  | "palette"
  | "help"
  | "search"
  | "new-session"
  | "toggle-panel"
  | "prev-session"
  | "next-session"
  | "escape";

export const SHORTCUT_LIST: readonly { label: string; keys: string }[] = [
  { label: "Palette perintah", keys: "Ctrl K / ⌘K" },
  { label: "Bantuan pintasan", keys: "?" },
  { label: "Cari sesi", keys: "/" },
  { label: "Sesi baru", keys: "n" },
  { label: "Tampilkan/sembunyikan panel", keys: "p" },
  { label: "Sesi sebelumnya", keys: "Alt ↑" },
  { label: "Sesi berikutnya", keys: "Alt ↓" },
  { label: "Tutup overlay", keys: "Esc" },
];

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** Klasifikasi target agar pintasan tidak mencuri ketikan di kolom teks. */
export function targetKindOf(target: unknown): TargetKind {
  if (target === null || target === undefined || typeof target !== "object") return "other";
  const element = target as ElementLike;
  const tag = (element.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return "input";
  if (element.isContentEditable === true) return "input";
  if (typeof element.closest === "function" && element.closest("[contenteditable]") !== null) {
    return "input";
  }
  return "other";
}

/** Pintasan yang tetap berlaku saat fokus berada di input. */
function matchInInput(event: KeyEventLike): ShortcutAction | undefined {
  if (event.ctrlKey || event.metaKey) {
    if (event.altKey || event.shiftKey) return undefined;
    return event.key.toLowerCase() === "k" ? "palette" : undefined;
  }
  if (event.altKey && !event.shiftKey) {
    if (event.key === "ArrowUp") return "prev-session";
    if (event.key === "ArrowDown") return "next-session";
  }
  return undefined;
}

export function matchShortcut(event: KeyEventLike): ShortcutAction | undefined {
  if (event.isComposing === true) return undefined;

  const targetKind = event.targetKind ?? "other";
  const base = { ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey };

  if (targetKind === "input") {
    return matchInInput(event);
  }

  // Ctrl/Cmd+K di luar input; modifier lain di luar itu tidak sah.
  if (base.ctrlKey || base.metaKey) {
    if (base.altKey || event.shiftKey) return undefined;
    return event.key.toLowerCase() === "k" ? "palette" : undefined;
  }

  if (base.altKey) {
    if (event.shiftKey) return undefined;
    if (event.key === "ArrowUp") return "prev-session";
    if (event.key === "ArrowDown") return "next-session";
    return undefined;
  }

  if (event.shiftKey) {
    // Beberapa tata letak mengirim "/" + Shift untuk "?".
    return event.key === "?" || event.key === "/" ? "help" : undefined;
  }

  switch (event.key) {
    case "?":
      return "help";
    case "/":
      return "search";
    case "n":
    case "N":
      return "new-session";
    case "p":
    case "P":
      return "toggle-panel";
    case "Escape":
      return "escape";
    default:
      return undefined;
  }
}

export type SessionDirection = "prev" | "next";

/**
 * Sesi tetangga pada daftar berurutan; berhenti di ujung (tanpa melingkar).
 * `undefined` bila tidak ada tujuan atau `currentId` tidak ada di daftar.
 */
export function adjacentSession(
  ids: readonly string[],
  currentId: string | undefined,
  dir: SessionDirection,
): string | undefined {
  if (ids.length === 0) return undefined;
  const index = currentId === undefined ? -1 : ids.indexOf(currentId);
  if (index === -1) return undefined;
  const next = index + (dir === "next" ? 1 : -1);
  if (next < 0 || next >= ids.length) return undefined;
  return ids[next];
}
