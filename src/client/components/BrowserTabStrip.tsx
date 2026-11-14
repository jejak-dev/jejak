import { Icon } from "./Icon";
import { MAX_BROWSER_TABS, tabLabel, type BrowserTabInfo } from "../lib/browser";

export interface BrowserTabStripProps {
  /** Semua tab yang terbuka. */
  tabs: BrowserTabInfo[];
  /** Pengenal tab aktif. */
  activeId?: string;
  /** Klik tab: aktifkan tab itu. */
  onActivate?: (id: string) => void;
  /** Klik tanda tutup: tutup tab itu. */
  onClose?: (id: string) => void;
  /** Klik tanda tambah: buat tab baru. */
  onNew?: () => void;
}

/**
 * Strip tab browser (murni, tanpa hook).
 * Setiap tab punya tombol buka, tombol tutup, dan penanda memuat.
 */
export function BrowserTabStrip(props: BrowserTabStripProps) {
  const tabs = props.tabs;
  const penuh = tabs.length >= MAX_BROWSER_TABS;
  return (
    <div class="jk-browser-tabs" role="tablist" aria-label="Tab browser">
      {tabs.map((tab) => {
        const aktif = tab.active || tab.id === props.activeId;
        const label = tabLabel(tab);
        return (
          <div class="jk-browser-tab" key={tab.id}>
            <button
              type="button"
              class="jk-browser-tab-btn"
              role="tab"
              aria-selected={aktif}
              aria-label={label}
              onClick={() => props.onActivate?.(tab.id)}
            >
              {tab.loading && <span class="jk-browser-tab-load" aria-hidden="true" />}
              <span class="jk-browser-tab-label">{label}</span>
            </button>
            <button
              type="button"
              class="jk-icon-btn jk-browser-tab-close"
              aria-label={`Tutup tab ${label}`}
              onClick={() => props.onClose?.(tab.id)}
            >
              <Icon name="close" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        class="jk-icon-btn jk-browser-tab-new"
        aria-label="Tab baru"
        disabled={penuh}
        onClick={() => props.onNew?.()}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
