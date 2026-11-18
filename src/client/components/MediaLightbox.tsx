import { useEffect, useRef } from "preact/hooks";
import { mediaUrl, type MediaRef } from "../lib/media";
import { Icon } from "./Icon";

export interface MediaLightboxProps {
  /** Sesi media; boleh kosong bila `urlFor` diberikan (mis. lampiran). */
  sessionId?: string;
  items: readonly MediaRef[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
  /** URL kustom per item; bawaannya endpoint media sesi. */
  urlFor?: (item: MediaRef) => string;
}

/** Pratinjau besar media sesi: Esc menutup, panah berpindah item. */
export function MediaLightbox({
  sessionId,
  items,
  index,
  onClose,
  onNavigate,
  urlFor,
}: MediaLightboxProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const item = items[index];
  const srcOf = (media: MediaRef): string =>
    urlFor !== undefined ? urlFor(media) : mediaUrl(sessionId ?? "", media.rel);

  // Hentikan pemutaran saat pindah item atau menutup.
  useEffect(() => {
    const video = videoRef.current;
    if (video !== null) video.pause();
  }, [index]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (items.length < 2) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onNavigate((index - 1 + items.length) % items.length);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onNavigate((index + 1) % items.length);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [index, items.length, onClose, onNavigate]);

  if (item === undefined) return null;

  return (
    <div
      class="jk-media-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Pratinjau ${item.name}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div class="jk-media-lightbox-bar">
        <span class="jk-media-lightbox-name">{item.name}</span>
        {items.length > 1 && (
          <span class="jk-media-lightbox-count">
            {index + 1} dari {items.length}
          </span>
        )}
        <button
          type="button"
          class="jk-media-lightbox-close"
          aria-label="Tutup pratinjau"
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div class="jk-media-lightbox-body">
        {items.length > 1 && (
          <button
            type="button"
            class="jk-media-lightbox-nav"
            aria-label="Media sebelumnya"
            onClick={() => onNavigate((index - 1 + items.length) % items.length)}
          >
            <Icon name="back" size={16} />
          </button>
        )}
        {item.kind === "video" ? (
          <video
            ref={videoRef}
            class="jk-media-lightbox-view"
            src={srcOf(item)}
            controls
            autoplay
            playsInline
          />
        ) : (
          <img
            class="jk-media-lightbox-view"
            src={srcOf(item)}
            alt={item.name}
          />
        )}
        {items.length > 1 && (
          <button
            type="button"
            class="jk-media-lightbox-nav"
            aria-label="Media berikutnya"
            onClick={() => onNavigate((index + 1) % items.length)}
          >
            <Icon name="chevron" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
