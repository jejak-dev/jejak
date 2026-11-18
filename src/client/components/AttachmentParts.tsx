import { useState } from "preact/hooks";
import { attachmentUrl, formatSize, type Attachment, type AttachmentRef } from "../lib/attachments";
import type { MediaRef } from "../lib/media";
import { Icon } from "./Icon";
import { MediaLightbox } from "./MediaLightbox";

/** MediaRef untuk lampiran bergambar; `rel` memuat id lampiran. */
export function attachmentMediaRefs(files: readonly AttachmentRef[]): MediaRef[] {
  return files
    .filter((file) => file.image)
    .map((file) => ({ rel: file.id, kind: "image", name: file.name }));
}

/** URL pratinjau untuk MediaRef lampiran. */
export function attachmentMediaUrl(ref: MediaRef): string {
  return attachmentUrl({ id: ref.rel, name: ref.name });
}

export interface AttachmentTrayProps {
  items: Attachment[];
  pending: number;
  error?: string;
  onRemove: (id: string) => void;
}

/** Baris lampiran di atas kotak teks: gambar jadi thumbnail, berkas jadi chip. */
export function AttachmentTray({ items, pending, error, onRemove }: AttachmentTrayProps) {
  // Id lampiran yang sedang dipratinjau; hilang otomatis bila lampirannya dihapus.
  const [preview, setPreview] = useState<string | undefined>(undefined);
  if (items.length === 0 && pending === 0 && error === undefined) return null;

  const images = items.filter((item) => item.image);
  const previewIndex = preview === undefined ? -1 : images.findIndex((item) => item.id === preview);

  return (
    <div class="jk-att-tray">
      {items.map((item) => (
        <div class="jk-att" key={item.id} title={`${item.name} · ${formatSize(item.size)}`}>
          {item.image ? (
            <button
              type="button"
              class="jk-att-thumb-btn"
              aria-label={`Pratinjau ${item.name}`}
              onClick={() => setPreview(item.id)}
            >
              <img class="jk-att-thumb" src={attachmentUrl(item)} alt={item.name} />
            </button>
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
            onClick={() => {
              if (preview === item.id) setPreview(undefined);
              onRemove(item.id);
            }}
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
      {previewIndex >= 0 && (
        <MediaLightbox
          items={attachmentMediaRefs(items)}
          index={previewIndex}
          onClose={() => setPreview(undefined)}
          onNavigate={(index) => setPreview(images[index]?.id)}
          urlFor={attachmentMediaUrl}
        />
      )}
    </div>
  );
}

export interface AttachmentImagesProps {
  files: readonly AttachmentRef[];
}

/** Thumbnail gambar lampiran pesan; klik membuka pratinjau besar. */
export function AttachmentImages({ files }: AttachmentImagesProps) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  const images = files.filter((file) => file.image);
  if (images.length === 0) return null;

  return (
    <>
      {images.map((file, index) => (
        <button
          key={file.path}
          type="button"
          class="jk-user-att-btn"
          aria-label={`Pratinjau ${file.name}`}
          onClick={() => setOpen(index)}
        >
          <img class="jk-user-att-img" src={attachmentUrl(file)} alt={file.name} />
        </button>
      ))}
      {open !== undefined && (
        <MediaLightbox
          items={attachmentMediaRefs(files)}
          index={open}
          onClose={() => setOpen(undefined)}
          onNavigate={setOpen}
          urlFor={attachmentMediaUrl}
        />
      )}
    </>
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
