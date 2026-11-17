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
import { Select } from "./Select";

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
  /** Menu opsi jendela sedang terbuka. */
  optionsOpen?: boolean;
  /** Layar sempit: tombol pindah dan perbesar disembunyikan. */
  narrow?: boolean;
  /** Jendela ini sedang diperbesar. */
  maximized?: boolean;
  /** Pindah tab aktif ke jendela atas boleh (hasil tata letak berubah). */
  canMoveUp?: boolean;
  /** Pindah tab aktif ke jendela bawah boleh (hasil tata letak berubah). */
  canMoveDown?: boolean;
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
  /** Membuka atau menutup menu opsi jendela. */
  onOptionsToggle?: () => void;
  /** Menutup menu opsi jendela. */
  onOptionsClose?: () => void;
  /** Pindahkan tab aktif ke jendela atas. */
  onMoveUp?: () => void;
  /** Pindahkan tab aktif ke jendela bawah. */
  onMoveDown?: () => void;
  /** Perbesar atau pulihkan ukuran jendela ini. */
  onToggleMaximize?: () => void;
  /** Penangan keyboard pada strip tab. */
  onTabKeyDown?: (event: KeyboardEvent, tab: PanelTab) => void;
  /** Referensi tombol tutup panel untuk fokus awal. */
  closeRef?: { current: HTMLButtonElement | null };
  /** Referensi tombol tambah tab. */
  addRef?: { current: HTMLButtonElement | null };
  /** Referensi menu tambah tab. */
  menuRef?: { current: HTMLDivElement | null };
  /** Referensi tombol opsi jendela. */
  optionsRef?: { current: HTMLButtonElement | null };
  /** Referensi menu opsi jendela. */
  optionsMenuRef?: { current: HTMLDivElement | null };
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
    optionsOpen,
    narrow,
    maximized,
    canMoveUp,
    canMoveDown,
    onSelectTab,
    onCloseTab,
    onOpenTool,
    onClosePane,
    onClosePanel,
    onRefresh,
    onMenuToggle,
    onMenuClose,
    onOptionsToggle,
    onOptionsClose,
    onMoveUp,
    onMoveDown,
    onToggleMaximize,
    onTabKeyDown,
    closeRef,
    addRef,
    menuRef,
    optionsRef,
    optionsMenuRef,
    tabRefs,
    children,
  } = props;

  const active = pane.active;
  // Tab terakhir pada satu-satunya jendela tidak bisa ditutup.
  const canCloseTab = !(paneCount === 1 && pane.tabs.length === 1);
  // Layar sempit hanya satu jendela: pindah dan perbesar tidak relevan.
  const controlsHidden = narrow === true;

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
            <Select
              class="jk-chip-select"
              ariaLabel="Repo"
              value={repoLabel ?? ""}
              options={repoOptions.map((option) => ({
                value: option.value,
                label: option.missing ? `${option.label} (hilang)` : option.label,
                disabled: option.missing,
              }))}
              onChange={(value) => onRepoChange?.(value)}
            />
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

        {!controlsHidden && (
          <button
            type="button"
            class="jk-icon-btn jk-pane-max"
            aria-label={maximized === true ? "Pulihkan ukuran" : "Perbesar jendela"}
            title={maximized === true ? "Pulihkan ukuran" : "Perbesar jendela"}
            aria-pressed={maximized === true}
            onClick={() => onToggleMaximize?.()}
          >
            <Icon name={maximized === true ? "collapse" : "expand"} />
          </button>
        )}

        {!controlsHidden && (
          <div class="jk-pane-options">
            <button
              ref={optionsRef}
              type="button"
              class="jk-icon-btn jk-pane-options-btn"
              aria-label="Opsi jendela"
              title="Opsi jendela"
              aria-haspopup="menu"
              aria-expanded={optionsOpen === true}
              onClick={() => onOptionsToggle?.()}
            >
              <Icon name="dots" />
            </button>
            {optionsOpen === true && (
              <div
                ref={optionsMenuRef}
                class="jk-pane-menu"
                role="menu"
                aria-label="Opsi jendela"
              >
                <button
                  type="button"
                  role="menuitem"
                  class="jk-pane-menu-item"
                  disabled={canMoveUp !== true}
                  aria-disabled={canMoveUp !== true}
                  onClick={() => {
                    onOptionsClose?.();
                    onMoveUp?.();
                  }}
                >
                  <Icon name="up" />
                  <span>Pindahkan ke jendela atas</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  class="jk-pane-menu-item"
                  disabled={canMoveDown !== true}
                  aria-disabled={canMoveDown !== true}
                  onClick={() => {
                    onOptionsClose?.();
                    onMoveDown?.();
                  }}
                >
                  <Icon name="down" />
                  <span>Pindahkan ke jendela bawah</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  class="jk-pane-menu-item"
                  onClick={() => {
                    onOptionsClose?.();
                    onToggleMaximize?.();
                  }}
                >
                  <Icon name={maximized === true ? "collapse" : "expand"} />
                  <span>{maximized === true ? "Pulihkan ukuran" : "Perbesar jendela"}</span>
                </button>
              </div>
            )}
          </div>
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

/** Satu jendela bertumpuk: menangani menu tambah tab, menu opsi, dan fokus strip tab. */
export function PaneWindow(props: PaneWindowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionsRef = useRef<HTMLButtonElement | null>(null);
  const optionsMenuRef = useRef<HTMLDivElement | null>(null);
  const internalTabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabRefs = props.tabRefs ?? internalTabRefs.current;

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

  // Menu opsi tertutup saat klik di luar atau tekan Escape; fokus kembali ke tombol opsi.
  useEffect(() => {
    if (!optionsOpen) return;
    const onPointer = (event: Event): void => {
      const target = event.target as Node;
      const diTombol = optionsRef.current?.contains(target) === true;
      const diMenu = optionsMenuRef.current?.contains(target) === true;
      if (!diTombol && !diMenu) setOptionsOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOptionsOpen(false);
      optionsRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [optionsOpen]);

  // Menu ditutup sendiri bila semua alat sudah terbuka.
  useEffect(() => {
    if (menuOpen && props.availableTools.length === 0) setMenuOpen(false);
  }, [menuOpen, props.availableTools.length]);

  // Layar sempit tidak punya tombol opsi; menu yang terbuka ditutup.
  useEffect(() => {
    if (props.narrow === true && optionsOpen) setOptionsOpen(false);
  }, [props.narrow, optionsOpen]);

  // Layar sempit: strip tab meluber, jadi tab aktif digulir ke tampak saat
  // dipilih dari luar (rel ikon, palette, atau tab rencana).
  const activeTab = props.pane.active;
  useEffect(() => {
    if (props.narrow !== true) return;
    const tombol = tabRefs[activeTab];
    tombol?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [props.narrow, activeTab, tabRefs]);

  const onTabKeyDown = (event: KeyboardEvent, tab: PanelTab): void => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = props.pane.tabs.indexOf(tab);
    const next = props.pane.tabs[nextPaneTabIndex(event.key, index, props.pane.tabs.length)];
    if (next === undefined) return;
    props.onSelectTab(next);
    tabRefs[next]?.focus();
  };

  return (
    <PaneWindowView
      {...props}
      menuOpen={menuOpen}
      optionsOpen={optionsOpen}
      addRef={addRef}
      menuRef={menuRef}
      optionsRef={optionsRef}
      optionsMenuRef={optionsMenuRef}
      tabRefs={tabRefs}
      onMenuToggle={() => {
        setMenuOpen((current) => !current);
        setOptionsOpen(false);
      }}
      onMenuClose={() => setMenuOpen(false)}
      onOptionsToggle={() => {
        setOptionsOpen((current) => !current);
        setMenuOpen(false);
      }}
      onOptionsClose={() => setOptionsOpen(false)}
      onTabKeyDown={onTabKeyDown}
    />
  );
}
