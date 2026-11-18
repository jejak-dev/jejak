import { useRef, useState } from "preact/hooks";
import { mediaUrl, type MediaRef } from "../lib/media";
import { MediaLightbox } from "./MediaLightbox";

export interface MediaStripProps {
  sessionId: string;
  items: readonly MediaRef[];
}

/** Thumbnail media di timeline; klik membuka pratinjau besar. */
export function MediaStrip({ sessionId, items }: MediaStripProps) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  if (items.length === 0) return null;

  const close = (): void => {
    setOpen(undefined);
    // Fokus kembali ke thumbnail pemicu setelah overlay dilepas.
    queueMicrotask(() => triggerRef.current?.focus());
  };

  return (
    <div class="jk-media-strip">
      {items.map((item, index) => (
        <button
          key={item.rel}
          type="button"
          class="jk-media-thumb"
          aria-label={`Buka pratinjau ${item.name}`}
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            setOpen(index);
          }}
        >
          {broken[item.rel] === true ? (
            <span class="jk-media-fallback">{item.name}</span>
          ) : item.kind === "video" ? (
            <>
              <video
                class="jk-media-thumb-img"
                src={mediaUrl(sessionId, item.rel)}
                preload="metadata"
                muted
                playsInline
                onError={() => setBroken((prev) => ({ ...prev, [item.rel]: true }))}
              />
              <span class="jk-media-badge" aria-hidden="true">
                ▶
              </span>
            </>
          ) : (
            <img
              class="jk-media-thumb-img"
              src={mediaUrl(sessionId, item.rel)}
              alt={item.name}
              loading="lazy"
              decoding="async"
              onError={() => setBroken((prev) => ({ ...prev, [item.rel]: true }))}
            />
          )}
        </button>
      ))}
      {open !== undefined && (
        <MediaLightbox
          sessionId={sessionId}
          items={items}
          index={open}
          onClose={close}
          onNavigate={setOpen}
        />
      )}
    </div>
  );
}
