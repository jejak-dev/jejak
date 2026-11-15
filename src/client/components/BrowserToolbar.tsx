import { Icon } from "./Icon";
import { statusLabel, type BrowserStateInfo, type FullscreenPath } from "../lib/browser";

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
  /** Tombol layar penuh ditampilkan? (peramban tak mendukungnya → disembunyikan). */
  fullscreenAvailable?: boolean;
  /** Cadangan tersedia: perbesar jendela panel (bila layar penuh ditolak). */
  maximizeAvailable?: boolean;
  /** Apakah browser sedang layar penuh? */
  fullscreen?: boolean;
  /** Jendela panel sedang diperbesar? (status tombol pada jalur cadangan). */
  maximized?: boolean;
  /** Masuk atau keluar layar penuh, atau memperbesar jendela panel. */
  onFullscreen?: () => void;
}

/**
 * Toolbar browser (murni, tanpa hook).
 * Kolom URL mengikuti state server kecuali pengguna sedang menyunting.
 * Saat difokus atau diklik, seluruh teks kolom URL terpilih seperti bilah alamat.
 */
export function BrowserToolbar(props: BrowserToolbarProps) {
  const state = props.state;
  const memuat = state?.loading === true;
  // Saat disunting, teks pengguna tidak ditimpa state.
  const alamat = props.editing === true ? (props.urlText ?? "") : (state?.url ?? "");
  // Jalur tombol: layar penuh asli, atau perbesaran jendela panel sebagai
  // cadangan. Tanpa keduanya tombol disembunyikan.
  const jalur: FullscreenPath | undefined =
    props.fullscreenAvailable === true
      ? "layarPenuh"
      : props.maximizeAvailable === true
        ? "perbesar"
        : undefined;
  // Status tombol mengikuti jalur yang sedang dipakai.
  const ditekan = jalur === "perbesar" ? props.maximized === true : props.fullscreen === true;
  const label =
    jalur === "perbesar"
      ? ditekan
        ? "Pulihkan ukuran"
        : "Perbesar jendela"
      : ditekan
        ? "Keluar layar penuh"
        : "Layar penuh";
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
        title={statusLabel(state)}
        onInput={(event) => props.onUrlInput?.((event.currentTarget as HTMLInputElement).value)}
        onFocus={(event) => {
          // Bilah alamat: seluruh teks dipilih begitu difokus.
          props.onUrlFocus?.();
          event.currentTarget.select();
        }}
        onMouseDown={(event) => {
          // Ingat apakah klik ini yang memberi fokus; klik berikutnya boleh menaruh kursor.
          event.currentTarget.dataset.baruFokus = document.activeElement === event.currentTarget ? "0" : "1";
        }}
        onClick={(event) => {
          const el = event.currentTarget;
          if (el.dataset.baruFokus === "1") el.select();
          el.dataset.baruFokus = "0";
        }}
        onBlur={() => props.onUrlBlur?.()}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          props.onUrlSubmit?.();
        }}
      />
      {jalur !== undefined && (
        <button
          type="button"
          class="jk-icon-btn jk-browser-fullscreen"
          aria-label={label}
          title={label}
          aria-pressed={ditekan}
          onClick={() => props.onFullscreen?.()}
        >
          <Icon name={ditekan ? "collapse" : "expand"} />
        </button>
      )}
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
