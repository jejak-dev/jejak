import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { formatCount } from "../lib/format";
import type { Pane } from "../lib/pane-layout";
import type { PanelTab } from "../lib/panel-prefs";
import {
  nextPaneTabIndex,
  panelTabIcon,
  panelTabLabel,
  type PanelRailTab,
} from "../lib/panel-rail";
import type { PanelRepoOption } from "../lib/workspace";
import { Icon } from "./Icon";

export interface PaneWindowViewProps {
  /** Jendela yang digambar: deretan tab dan tab aktifnya. */
  pane: Pane;
  /** Pecahan tinggi jendela; dipakai untuk gaya flex. */
  size: number;
  /** Jendela pertama di tumpukan (bila benar, punya tombol tutup panel). */
  isFirst: boolean;
  /** Jumlah jendela di tumpukan. */
  paneCount: number;
  /** Alat yang belum terbuka; sumber isi menu tambah tab. */
  availableTools: readonly PanelRailTab[];
  /** Lencana jumlah per tab; undefined atau 0 disembunyikan. */
  countFor?: (id: PanelTab) => number | undefined;
  /** Tampilkan pemilih repo (hanya jendela bertab kode). */
  showRepo?: boolean;
  /** Repo efektif yang sedang dipakai. */
  repoLabel?: string;
  /** Daftar repo untuk pemilih. */
  repoOptions?: readonly PanelRepoOption[];
  /** Dipanggil saat repo diganti. */
  onRepoChange?: (value: string) => void;
  /** Tampilkan tombol muat ulang. */
  showRefresh?: boolean;
  /** Menu tambah tab sedang terbuka. */
  menuOpen?: boolean;
  /** Dipanggil saat tab diklik pada strip. */
  onSelectTab: (tab: PanelTab) => void;
  /** Dipanggil saat tombol tutup tab diklik. */
  onCloseTab: (tab: PanelTab) => void;
  /** Dipanggil saat sebuah alat dipilih dari menu tambah tab. */
  onOpenTool: (tab: PanelTab) => void;
  /** Dipanggil saat jendela ditutup. */
  onClosePane: () => void;
  /** Dipanggil saat panel ditutup. */
  onClosePanel: () => void;
  /** Dipanggil saat tombol muat ulang diklik. */
  onRefresh: () => void;
  /** Membuka atau menutup menu tambah tab. */
  onMenuToggle?: () => void;
  /** Menutup menu tambah tab. */
  onMenuClose?: () => void;
  /** Penangan keyboard pada strip tab. */
  onTabKeyDown?: (event: KeyboardEvent, tab: PanelTab) => void;
  /** Referensi tombol tutup panel untuk fokus awal. */
  closeRef?: { current: HTMLButtonElement | null };
  /** Referensi tombol tambah tab. */
  addRef?: { current: HTMLButtonElement | null };
  /** Referensi menu tambah tab. */
  menuRef?: { current: HTMLDivElement | null };
  /** Referensi tombol tab untuk navigasi keyboard. */
  tabRefs?: Record<string, HTMLButtonElement | null>;
  /** Isi tab aktif. */
  children?: ComponentChildren;
}

/**
 * Tampilan satu jendela bertumpuk tanpa hook; dipakai uji render tanpa DOM.
 * Perilaku menu dan fokus disediakan lewat props bindings.
 */
export function PaneWindowView(props: PaneWindowViewProps) {
  const {
    pane,
    size,
    isFirst,
    paneCount,
    availableTools,
    countFor,
    showRepo,
    repoLabel,
    repoOptions,
    onRepoChange,
    showRefresh,
    menuOpen,
    onSelectTab,
    onCloseTab,
    onOpenTool,
    onClosePane,
    onClosePanel,
    onRefresh,
    onMenuToggle,
    onMenuClose,
    onTabKeyDown,
    closeRef,
    addRef,
    menuRef,
    tabRefs,
    children,
  } = props;

  const active = pane.active;
  // Tab terakhir pada satu-satunya jendela tidak bisa ditutup.
  const canCloseTab = !(paneCount === 1 && pane.tabs.length === 1);

  return (
    <section
      class="jk-pane"
      style={{ flex: `${size} 1 0` }}
      aria-label={`Jendela ${panelTabLabel(active)}`}
    >
      <div class="jk-pane-head">
        <div class="jk-pane-tabs" role="tablist" aria-label="Tab jendela">
          {pane.tabs.map((tab) => {
            const label = panelTabLabel(tab);
            const count = countFor?.(tab);
            return (
              <span class="jk-pane-tab-wrap" role="presentation" key={tab}>
                <button
                  type="button"
                  role="tab"
                  id={`jk-panel-tab-${tab}`}
                  class={`jk-pane-tab${tab === active ? " jk-pane-tab-active" : ""}`}
                  aria-selected={tab === active}
                  aria-controls={`jk-panel-panel-${tab}`}
                  tabIndex={tab === active ? 0 : -1}
                  title={label}
                  ref={
                    tabRefs
                      ? (element: HTMLButtonElement | null) => {
                          tabRefs[tab] = element;
                        }
                      : undefined
                  }
                  onClick={() => onSelectTab(tab)}
                  onKeyDown={(event) => onTabKeyDown?.(event, tab)}
                >
                  <Icon name={panelTabIcon(tab)} />
                  <span class="jk-pane-tab-label">{label}</span>
                  {count !== undefined && count > 0 && (
                    <span class="jk-pane-count">{formatCount(count)}</span>
                  )}
                </button>
                {canCloseTab && (
                  <button
                    type="button"
                    class="jk-pane-tab-close"
                    aria-label={`Tutup tab ${label}`}
                    title={`Tutup tab ${label}`}
                    onClick={() => onCloseTab(tab)}
                  >
                    <Icon name="close" />
                  </button>
                )}
              </span>
            );
          })}
        </div>

        {availableTools.length > 0 && (
          <div class="jk-pane-add">
            <button
              ref={addRef}
              type="button"
              class="jk-icon-btn jk-pane-add-btn"
              aria-label="Tambah tab"
              title="Tambah tab"
              aria-haspopup="menu"
              aria-expanded={menuOpen === true}
              onClick={() => onMenuToggle?.()}
            >
              <Icon name="plus" />
            </button>
            {menuOpen === true && (
              <div
                ref={menuRef}
                class="jk-pane-menu"
                role="menu"
                aria-label="Alat yang dapat dibuka"
              >
                {availableTools.map((tool) => (
                  <button
                    type="button"
                    role="menuitem"
                    class="jk-pane-menu-item"
                    key={tool.id}
                    onClick={() => {
                      onMenuClose?.();
                      onOpenTool(tool.id);
                    }}
                  >
                    <Icon name={tool.icon} />
                    <span>{tool.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {showRepo === true && repoOptions !== undefined && (
          <label class="jk-chip" title="Repo">
            <Icon name="folder" />
            <span>{repoLabel}</span>
            <select
              class="jk-chip-select"
              aria-label="Repo"
              value={repoLabel ?? ""}
              onChange={(event) =>
                onRepoChange?.((event.currentTarget as HTMLSelectElement).value)
              }
            >
              {repoOptions.map((option) => (
                <option key={option.value} value={option.value} disabled={option.missing}>
                  {option.missing ? `${option.label} (hilang)` : option.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {showRefresh === true && (
          <button
            type="button"
            class="jk-icon-btn jk-panel-refresh"
            aria-label="Muat ulang"
            title="Muat ulang"
            onClick={() => onRefresh()}
          >
            <Icon name="refresh" />
          </button>
        )}

        {paneCount > 1 && (
          <button
            type="button"
            class="jk-icon-btn jk-pane-close"
            aria-label="Tutup jendela"
            title="Tutup jendela"
            onClick={() => onClosePane()}
          >
            <Icon name="close" />
          </button>
        )}

        {isFirst && (
          <button
            ref={closeRef}
            type="button"
            class="jk-icon-btn jk-panel-close"
            aria-label="Tutup panel"
            title="Tutup panel"
            onClick={() => onClosePanel()}
          >
            <Icon name="close" />
          </button>
        )}
      </div>

      <div
        class="jk-pane-body"
        role="tabpanel"
        id={`jk-panel-panel-${active}`}
        aria-labelledby={`jk-panel-tab-${active}`}
      >
        {children}
      </div>
    </section>
  );
}

export type PaneWindowProps = PaneWindowViewProps;

/** Satu jendela bertumpuk: menangani menu tambah tab dan fokus strip tab. */
export function PaneWindow(props: PaneWindowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Menu tertutup saat klik di luar atau tekan Escape; fokus kembali ke tombol +.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: Event): void => {
      const target = event.target as Node;
      const diTombol = addRef.current?.contains(target) === true;
      const diMenu = menuRef.current?.contains(target) === true;
      if (!diTombol && !diMenu) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      addRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Menu ditutup sendiri bila semua alat sudah terbuka.
  useEffect(() => {
    if (menuOpen && props.availableTools.length === 0) setMenuOpen(false);
  }, [menuOpen, props.availableTools.length]);

  const onTabKeyDown = (event: KeyboardEvent, tab: PanelTab): void => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = props.pane.tabs.indexOf(tab);
    const next = props.pane.tabs[nextPaneTabIndex(event.key, index, props.pane.tabs.length)];
    if (next === undefined) return;
    props.onSelectTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <PaneWindowView
      {...props}
      menuOpen={menuOpen}
      addRef={addRef}
      menuRef={menuRef}
      tabRefs={tabRefs.current}
      onMenuToggle={() => setMenuOpen((current) => !current)}
      onMenuClose={() => setMenuOpen(false)}
      onTabKeyDown={onTabKeyDown}
    />
  );
}
