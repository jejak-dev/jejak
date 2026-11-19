import { useState } from "preact/hooks";
import { variantSuggestions } from "../lib/design-canvas";
import { ConfirmDialog } from "./ConfirmDialog";

export interface DesignVariantDialogProps {
  /** Judul halaman sumber varian; dipakai pada judul dialog. */
  sourceTitle: string;
  /** Simpan varian; galat dilempar supaya tampil di dalam dialog. */
  onCreate: (variant: string) => Promise<void>;
  onCancel: () => void;
}

/** Batas panjang label varian; sama dengan batas server. */
const MAX_VARIANT_LENGTH = 30;

const FAIL_TEXT = "varian tidak dapat dibuat";

/**
 * Dialog "Buat varian": satu kolom nama varian, saran nama siap pakai, dan
 * tombol simpan. Nama kosong atau terlalu panjang menonaktifkan tombol simpan;
 * galat dari server tampil sebagai alert.
 */
export function DesignVariantDialog(props: DesignVariantDialogProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const nama = value.trim();
  const sah = nama.length >= 1 && nama.length <= MAX_VARIANT_LENGTH;

  const buat = async (): Promise<void> => {
    if (!sah || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onCreate(nama);
      setValue("");
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message !== "" ? caught.message : FAIL_TEXT,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open
      title={`Buat varian dari ${props.sourceTitle}`}
      confirmLabel="Buat varian"
      cancelLabel="Batal"
      busy={busy}
      busyLabel="Menyimpan…"
      error={error}
      confirmDisabled={!sah}
      initialFocusSelector=".jk-design-variant-input"
      onConfirm={() => void buat()}
      onCancel={props.onCancel}
      message={
        <div class="jk-design-variant">
          <input
            class="jk-input jk-design-variant-input"
            type="text"
            aria-label="Nama varian"
            maxLength={MAX_VARIANT_LENGTH}
            placeholder="gelap"
            value={value}
            onInput={(event) => {
              setValue((event.currentTarget as HTMLInputElement).value);
              setError(undefined);
            }}
          />
          <div class="jk-design-variant-suggestions">
            {variantSuggestions.map((saran) => (
              <button
                key={saran}
                type="button"
                class="jk-design-chip"
                onClick={() => {
                  setValue(saran);
                  setError(undefined);
                }}
              >
                {saran}
              </button>
            ))}
          </div>
        </div>
      }
    />
  );
}
