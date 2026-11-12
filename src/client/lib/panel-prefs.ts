export type PanelTab =
  | "changes"
  | "todos"
  | "files"
  | "git"
  | "checkpoints"
  | "rahasia"
  | "commands"
  | "terminal";

export interface PanelPrefs {
  open: boolean;
  tab: PanelTab;
}

const STORAGE_KEY = "jejak.panel";
const DEFAULT_PREFS: PanelPrefs = { open: false, tab: "changes" };
const TABS: readonly PanelTab[] = [
  "changes",
  "todos",
  "files",
  "git",
  "checkpoints",
  "rahasia",
  "commands",
  "terminal",
];

function isTab(value: unknown): value is PanelTab {
  return typeof value === "string" && (TABS as readonly string[]).includes(value);
}

/** Baca preferensi panel dari string JSON; bentuk asing jatuh ke bawaan. */
export function parsePanelPrefs(raw: string | null): PanelPrefs {
  if (raw === null || raw === "") return DEFAULT_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
  const value = parsed as Record<string, unknown>;
  return {
    open: value.open === true,
    tab: isTab(value.tab) ? value.tab : "changes",
  };
}

export function readPanelPrefs(): PanelPrefs {
  try {
    return parsePanelPrefs(globalThis.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writePanelPrefs(patch: Partial<PanelPrefs>): void {
  try {
    const merged = { ...readPanelPrefs(), ...patch };
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Penyimpanan tidak tersedia (mode privat); panel tetap berfungsi tanpa memori.
  }
}
