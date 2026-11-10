import { attachmentUrl, formatSize, type Attachment } from "../lib/attachments";
import { Icon } from "./Icon";

export interface AttachmentTrayProps {
  items: Attachment[];
  pending: number;
  error?: string;
  onRemove: (id: string) => void;
}

/** Baris lampiran di atas kotak teks: gambar jadi thumbnail, berkas jadi chip. */
export function AttachmentTray({ items, pending, error, onRemove }: AttachmentTrayProps) {
  if (items.length === 0 && pending === 0 && error === undefined) return null;
  return (
    <div class="jk-att-tray">
      {items.map((item) => (
        <div class="jk-att" key={item.id} title={`${item.name} · ${formatSize(item.size)}`}>
          {item.image ? (
            <img class="jk-att-thumb" src={attachmentUrl(item)} alt={item.name} />
          ) : (
            <span class="jk-att-icon">
              <Icon name="file" />
            </span>
          )}
          <span class="jk-att-name">{item.name}</span>
          <button
            type="button"
            class="jk-att-remove"
            aria-label={`Hapus lampiran ${item.name}`}
            onClick={() => onRemove(item.id)}
          >
            <Icon name="close" />
          </button>
        </div>
      ))}
      {pending > 0 && <span class="jk-att-pending">Mengunggah…</span>}
      {error !== undefined && (
        <span class="jk-att-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export interface AttachButtonProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

/** Tombol "+" yang membuka pemilih berkas. */
export function AttachButton({ onFiles, disabled }: AttachButtonProps) {
  return (
    <label
      class={`jk-attach-btn${disabled === true ? " jk-attach-disabled" : ""}`}
      title="Lampirkan berkas atau gambar (bisa juga tempel atau seret)"
    >
      <Icon name="plus" />
      <span class="jk-visually-hidden">Lampirkan berkas</span>
      <input
        type="file"
        multiple
        class="jk-visually-hidden"
        disabled={disabled}
        onChange={(event) => {
          const input = event.currentTarget as HTMLInputElement;
          onFiles(Array.from(input.files ?? []));
          input.value = "";
        }}
      />
    </label>
  );
}

/** Lapisan petunjuk saat berkas diseret ke atas kotak. */
export function DropHint() {
  return (
    <div class="jk-drop-hint" aria-hidden="true">
      Lepas untuk melampirkan
    </div>
  );
}
