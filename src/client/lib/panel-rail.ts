import type { IconName } from "../components/Icon";
import type { PanelTab } from "./panel-prefs";

/** Kelompok bagian pada rel ikon panel kanan. */
export type PanelRailGroupId = "kode" | "agent" | "pengetahuan";

export interface PanelRailTab {
  /** Id internal; tetap sama supaya preferensi panel lama tetap berlaku. */
  id: PanelTab;
  /** Label Bahasa Indonesia untuk header, tooltip, dan aria-label. */
  label: string;
  icon: IconName;
}

export interface PanelRailGroup {
  id: PanelRailGroupId;
  label: string;
  tabs: readonly PanelRailTab[];
}

/**
 * Susunan rel ikon: tiga kelompok dari atas ke bawah. Id internal tidak
 * berubah, hanya label tampilan yang memakai Bahasa Indonesia.
 */
export const PANEL_RAIL_GROUPS: readonly PanelRailGroup[] = [
  {
    id: "kode",
    label: "Kode",
    tabs: [
      { id: "changes", label: "Perubahan", icon: "diff" },
      { id: "git", label: "Git", icon: "branch" },
      { id: "files", label: "Berkas", icon: "file" },
      { id: "checkpoints", label: "Checkpoint", icon: "clock" },
    ],
  },
  {
    id: "agent",
    label: "Agent",
    tabs: [
      { id: "todos", label: "Langkah", icon: "checklist" },
      { id: "commands", label: "Perintah", icon: "play" },
      { id: "terminal", label: "Terminal", icon: "terminal" },
    ],
  },
  {
    id: "pengetahuan",
    label: "Pengetahuan",
    tabs: [
      { id: "wiki", label: "Wiki", icon: "memory" },
      { id: "rahasia", label: "Rahasia", icon: "lock" },
    ],
  },
];

/** Semua tab rel dalam urutan navigasi (kelompok demi kelompok). */
export const PANEL_RAIL_TABS: readonly PanelRailTab[] = PANEL_RAIL_GROUPS.flatMap(
  (group) => group.tabs,
);

/** Label Bahasa Indonesia untuk sebuah id tab; id itself sebagai cadangan. */
export function panelTabLabel(id: PanelTab): string {
  return PANEL_RAIL_TABS.find((entry) => entry.id === id)?.label ?? id;
}

/** Indeks tab dalam urutan rel; 0 bila id tidak dikenal. */
export function panelTabIndex(id: PanelTab): number {
  const index = PANEL_RAIL_TABS.findIndex((entry) => entry.id === id);
  return index < 0 ? 0 : index;
}

/**
 * Indeks tab berikutnya untuk navigasi keyboard pada rel vertikal.
 * Panah naik/bawah berputar; Home ke tab pertama, End ke tab terakhir.
 * Kunci lain mengembalikan indeks saat ini.
 */
export function nextPanelTabIndex(
  key: string,
  index: number,
  total: number = PANEL_RAIL_TABS.length,
): number {
  if (total <= 0) return 0;
  const current = ((index % total) + total) % total;
  switch (key) {
    case "ArrowUp":
      return (current - 1 + total) % total;
    case "ArrowDown":
      return (current + 1) % total;
    case "Home":
      return 0;
    case "End":
      return total - 1;
    default:
      return current;
  }
}
