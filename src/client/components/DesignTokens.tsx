import type { DesignToken } from "../lib/api";
import {
  diffTokens,
  groupTokens,
  hexForColorInput,
  isValidTokenName,
  isValidTokenValue,
} from "../lib/design-tokens";
import { useEffect, useRef, useState } from "preact/hooks";

export interface DesignTokensProps {
  /** Token tersimpan terakhir yang dibaca dari server. */
  tokens: DesignToken[];
  /** Galat terakhir dari server; ditampilkan sebagai alert. */
  error?: string;
  /** Simpan draf token; menolak bila galat. */
  onSave: (tokens: DesignToken[]) => Promise<void>;
  /** Tutup panel tanpa menyimpan. */
  onCancel: () => void;
  /**
   * Perbarui blok otomatis `DESIGN.md`. Bila tak ada, tombol tak tampil.
   */
  onSyncDoc?: () => Promise<{ changed: boolean }>;
}

const EMPTY_TEXT = "Belum ada token. Tambahkan variabel CSS seperti --warna-aksen.";
const STALE_TEXT = "Token berubah di tempat lain.";
const DOC_UPDATED_TEXT = "DESIGN.md diperbarui.";
const DOC_CURRENT_TEXT = "DESIGN.md sudah terbaru.";
const DOC_FAILED_TEXT = "DESIGN.md tidak dapat diperbarui.";
const INVALID_NAME = "Nama token tidak valid.";
const INVALID_VALUE = "Nilai token tidak valid.";
const DUPLICATE_NAME = "Nama token sudah ada.";

/** Dua daftar token sama bila nama dan nilainya sama. */
function samaDengan(a: DesignToken[], b: DesignToken[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((token, index) => {
    const lain = b[index];
    return lain !== undefined && lain.name === token.name && lain.value === token.value;
  });
}

/**
 * Panel token desain: daftar token per kelompok, penyuntingan nilai, token
 * baru, dan tombol simpan. Draf disimpan lokal; token yang berubah dari luar
 * tidak menimpa draf yang sedang disunting.
 */
export function DesignTokens(props: DesignTokensProps) {
  const { tokens } = props;
  const [draft, setDraft] = useState<DesignToken[]>(tokens);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | undefined>(undefined);
  const [syncError, setSyncError] = useState<string | undefined>(undefined);

  // Token tersimpan yang jadi dasar draf; dasar dirty dihitung terhadap ini.
  const baseRef = useRef<DesignToken[]>(tokens);
  // Token tersimpan yang terakhir dilihat; dipakai untuk mendeteksi bahwa
  // token dari luar benar-benar berubah (bukan hanya draf yang berubah).
  const seenTokens = useRef<DesignToken[]>(tokens);
  // Warna hex terakhir yang diketahui per token; mencegah kontrol warna
  // hilang saat nilainya diubah ke bentuk lain.
  const hexCache = useRef(new Map<string, string>());

  // Draf di-reset bila token tersimpan berubah dari luar dan draf tak kotor.
  useEffect(() => {
    if (samaDengan(seenTokens.current, tokens)) return;
    seenTokens.current = tokens;
    if (diffTokens(baseRef.current, draft) > 0) {
      // Draf sedang disunting; jangan timpa, tapi beri tahu.
      setStale(true);
      return;
    }
    baseRef.current = tokens;
    setDraft(tokens);
    setStale(false);
  }, [tokens, draft]);

  const groups = groupTokens(draft);
  const jumlah = diffTokens(tokens, draft);
  const barisTakSah = draft.filter((token) => !isValidTokenValue(token.value));
  const bisaSimpan = jumlah > 0 && barisTakSah.length === 0 && !saving;

  const gantiNilai = (name: string, value: string): void => {
    setDraft((prev) =>
      prev.map((token) => (token.name === name ? { ...token, value } : token)),
    );
    setLocalError(undefined);
  };

  const hapus = (name: string): void => {
    setDraft((prev) => prev.filter((token) => token.name !== name));
    setLocalError(undefined);
  };

  const tambah = (): void => {
    const name = newName.trim();
    const value = newValue.trim();
    if (!isValidTokenName(name)) {
      setAddError(INVALID_NAME);
      return;
    }
    if (!isValidTokenValue(value)) {
      setAddError(INVALID_VALUE);
      return;
    }
    if (draft.some((token) => token.name === name)) {
      setAddError(DUPLICATE_NAME);
      return;
    }
    setDraft((prev) => [...prev, { name, value }]);
    setNewName("");
    setNewValue("");
    setAddError(undefined);
  };

  const simpan = async (): Promise<void> => {
    if (!bisaSimpan) return;
    setSaving(true);
    setLocalError(undefined);
    try {
      await props.onSave(draft);
      // Draf yang tersimpan menjadi dasar baru.
      baseRef.current = draft;
      setStale(false);
    } catch (caught) {
      setLocalError(
        caught instanceof Error && caught.message !== ""
          ? caught.message
          : "token tidak dapat disimpan",
      );
    } finally {
      setSaving(false);
    }
  };

  /** Perbarui DESIGN.md; hasil ditunjukkan sebagai status atau galat. */
  const perbaruiDoc = async (): Promise<void> => {
    const sinkron = props.onSyncDoc;
    if (sinkron === undefined || syncBusy) return;
    setSyncBusy(true);
    setSyncStatus(undefined);
    setSyncError(undefined);
    try {
      const hasil = await sinkron();
      setSyncStatus(hasil.changed ? DOC_UPDATED_TEXT : DOC_CURRENT_TEXT);
    } catch (caught) {
      setSyncError(
        caught instanceof Error && caught.message !== "" ? caught.message : DOC_FAILED_TEXT,
      );
    } finally {
      setSyncBusy(false);
    }
  };

  const galat = props.error ?? localError;

  return (
    <aside class="jk-design-tokens" aria-label="Token desain">
      {galat !== undefined && (
        <p class="jk-design-tokens-error" role="alert">
          {galat}
        </p>
      )}
      {stale && <p class="jk-design-tokens-stale">{STALE_TEXT}</p>}

      {draft.length === 0 ? (
        <p class="jk-design-tokens-empty">{EMPTY_TEXT}</p>
      ) : (
        groups.map((group) => (
          <section class="jk-design-tokens-group" key={group.title}>
            <h3 class="jk-design-tokens-group-title">{group.title}</h3>
            <ul class="jk-design-tokens-list">
              {group.tokens.map((token) => {
                const hexBaru = hexForColorInput(token.value);
                if (hexBaru !== undefined) hexCache.current.set(token.name, hexBaru);
                const hex = hexBaru ?? hexCache.current.get(token.name);
                const sah = isValidTokenValue(token.value);
                return (
                  <li class="jk-design-token" key={token.name}>
                    <code class="jk-design-token-name">{token.name}</code>
                    <div class="jk-design-token-controls">
                      {hex !== undefined && (
                        <input
                          type="color"
                          class="jk-design-token-swatch"
                          aria-label={`Warna ${token.name}`}
                          value={hex}
                          onInput={(event) =>
                            gantiNilai(
                              token.name,
                              (event.currentTarget as HTMLInputElement).value,
                            )
                          }
                        />
                      )}
                      <input
                        type="text"
                        class="jk-design-token-value"
                        aria-label={`Nilai ${token.name}`}
                        aria-invalid={sah ? undefined : "true"}
                        value={token.value}
                        onInput={(event) =>
                          gantiNilai(
                            token.name,
                            (event.currentTarget as HTMLInputElement).value,
                          )
                        }
                      />
                      <button
                        type="button"
                        class="jk-design-chip jk-design-token-hapus"
                        title={`Hapus ${token.name}`}
                        onClick={() => hapus(token.name)}
                      >
                        Hapus
                      </button>
                    </div>
                    {!sah && <p class="jk-design-token-invalid">{INVALID_VALUE}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      <div class="jk-design-tokens-add">
        <input
          type="text"
          class="jk-design-token-value"
          aria-label="Nama token baru"
          placeholder="--nama-token"
          value={newName}
          onInput={(event) => {
            setNewName((event.currentTarget as HTMLInputElement).value);
            setAddError(undefined);
          }}
        />
        <input
          type="text"
          class="jk-design-token-value"
          aria-label="Nilai token baru"
          placeholder="nilai"
          value={newValue}
          onInput={(event) => {
            setNewValue((event.currentTarget as HTMLInputElement).value);
            setAddError(undefined);
          }}
        />
        <button type="button" class="jk-design-chip" onClick={tambah}>
          Tambah token
        </button>
        {addError !== undefined && (
          <p class="jk-design-tokens-error" role="alert">
            {addError}
          </p>
        )}
      </div>

      <div class="jk-design-tokens-footer">
        <button
          type="button"
          class="jk-design-chip"
          disabled={!bisaSimpan}
          onClick={() => void simpan()}
        >
          {`Simpan token (${jumlah})`}
        </button>
        <button type="button" class="jk-design-chip" onClick={props.onCancel}>
          Batalkan
        </button>
        {props.onSyncDoc !== undefined && (
          <button
            type="button"
            class="jk-design-chip"
            disabled={syncBusy}
            onClick={() => void perbaruiDoc()}
          >
            Perbarui DESIGN.md
          </button>
        )}
      </div>

      {syncStatus !== undefined && (
        <p class="jk-design-tokens-stale" role="status">
          {syncStatus}
        </p>
      )}
      {syncError !== undefined && (
        <p class="jk-design-tokens-error" role="alert">
          {syncError}
        </p>
      )}
    </aside>
  );
}
