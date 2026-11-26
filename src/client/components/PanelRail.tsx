import { formatCount } from "../lib/format";
import type { PanelTab } from "../lib/panel-prefs";
import {
  PANEL_RAIL_GROUPS,
  PANEL_RAIL_TABS,
  type PanelRailGroup,
} from "../lib/panel-rail";
import { Icon } from "./Icon";

export interface PanelRailViewProps {
  /** Tab yang sudah terbuka; ikonnya diberi aria-pressed dan kelas open. */
  openTabs: readonly PanelTab[];
  /** Tab aktif pada jendela yang difokuskan; ikonnya diberi kelas active. */
  activeTab?: PanelTab;
  /** Indeks tombol yang punya fokus keyboard (roving tabindex). */
  focusIndex: number;
  /** Lencana jumlah per tab; undefined atau 0 disembunyikan. */
  countFor?: (id: PanelTab) => number | undefined;
  /** Dipanggil saat ikon diklik: membuka alat atau memfokuskan tabnya. */
  onOpen: (id: PanelTab) => void;
  /** Penangan keyboard untuk navigasi panah atas/bawah/Home/End. */
  onKeyDown?: (event: globalThis.KeyboardEvent, index: number) => void;
  /** Referensi tombol untuk pemindahan fokus. */
  railRefs?: Record<string, HTMLButtonElement | null>;
  /** Grup untuk indeks navigasi keyboard; bawaan seluruh tab rel. */
  groups?: readonly PanelRailGroup[];
}

/**
 * Rel ikon vertikal sebagai peluncur alat; bukan pemilih tab lagi.
 * Tampilan murni tanpa hook supaya bisa diuji tanpa DOM.
 */
export function PanelRailView(props: PanelRailViewProps) {
  const { openTabs, activeTab, focusIndex, countFor, onOpen, onKeyDown, railRefs } = props;
  const groups = props.groups ?? PANEL_RAIL_GROUPS;
  const terbuka = new Set(openTabs);

  return (
    <div
      class="jk-panel-rail"
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Alat panel"
    >
      {groups.map((group) => (
        <div class="jk-rail-group" role="group" aria-label={group.label} key={group.id}>
          {group.tabs.map((entry) => {
            const index = PANEL_RAIL_TABS.findIndex((item) => item.id === entry.id);
            const count = countFor?.(entry.id);
            const isOpen = terbuka.has(entry.id);
            const isActive = activeTab === entry.id;
            return (
              <button
                key={entry.id}
                ref={
                  railRefs
                    ? (element: HTMLButtonElement | null) => {
                        railRefs[entry.id] = element;
                      }
                    : undefined
                }
                type="button"
                class={`jk-rail-btn${isActive ? " jk-rail-btn-active" : ""}${
                  isOpen ? " jk-rail-btn-open" : ""
                }`}
                aria-pressed={isOpen}
                tabIndex={focusIndex === index ? 0 : -1}
                title={entry.label}
                aria-label={entry.label}
                onClick={() => onOpen(entry.id)}
                onKeyDown={(event) => onKeyDown?.(event, index)}
              >
                <Icon name={entry.icon} />
                {count !== undefined && count > 0 && (
                  <span class="jk-rail-badge">{formatCount(count)}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Rel ikon panel; pembungkus tipis untuk {@link PanelRailView}. */
export function PanelRail(props: PanelRailViewProps) {
  return <PanelRailView {...props} />;
}
