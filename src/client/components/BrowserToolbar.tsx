import { Icon } from "./Icon";
import type { BrowserStateInfo } from "../lib/browser";

export interface BrowserToolbarProps {
  /** State browser terakhir (dari server). */
  state?: BrowserStateInfo;
  /** Teks yang diketik pengguna; dipakai bila kolom URL sedang disunting. */
  urlText?: string;
  /** Apakah kolom URL sedang disunting (pengguna fokus)? */
  editing?: boolean;
  /** Teks tombol muat ulang / berhenti memuat. */
  onUrlInput?: (value: string) => void;
  onUrlFocus?: () => void;
  onUrlBlur?: () => void;
  onUrlSubmit?: () => void;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  onStop?: () => void;
  onClose?: () => void;
}

/**
 * Toolbar browser (murni, tanpa hook).
 * Kolom URL mengikuti state server kecuali pengguna sedang menyunting.
 */
export function BrowserToolbar(props: BrowserToolbarProps) {
  const state = props.state;
  const memuat = state?.loading === true;
  // Saat disunting, teks pengguna tidak ditimpa state.
  const alamat = props.editing === true ? (props.urlText ?? "") : (state?.url ?? "");
  return (
    <div class="jk-browser-toolbar">
      <button
        type="button"
        class="jk-icon-btn jk-browser-nav-back"
        aria-label="Kembali"
        disabled={state?.canGoBack !== true}
        onClick={() => props.onBack?.()}
      >
        <Icon name="chevron" />
      </button>
      <button
        type="button"
        class="jk-icon-btn"
        aria-label="Maju"
        disabled={state?.canGoForward !== true}
        onClick={() => props.onForward?.()}
      >
        <Icon name="chevron" />
      </button>
      {memuat ? (
        <button
          type="button"
          class="jk-icon-btn"
          aria-label="Berhenti memuat"
          onClick={() => props.onStop?.()}
        >
          <Icon name="stop" />
        </button>
      ) : (
        <button
          type="button"
          class="jk-icon-btn"
          aria-label="Muat ulang"
          onClick={() => props.onReload?.()}
        >
          <Icon name="refresh" />
        </button>
      )}
      <input
        class="jk-input jk-browser-url"
        type="text"
        value={alamat}
        placeholder="https://example.com"
        aria-label="Alamat"
        onInput={(event) => props.onUrlInput?.((event.currentTarget as HTMLInputElement).value)}
        onFocus={() => props.onUrlFocus?.()}
        onBlur={() => props.onUrlBlur?.()}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          props.onUrlSubmit?.();
        }}
      />
      <button
        type="button"
        class="jk-icon-btn"
        aria-label="Tutup browser"
        onClick={() => props.onClose?.()}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
