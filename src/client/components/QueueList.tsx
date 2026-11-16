import { queuePreview, type QueuedMessageView } from "../lib/queue";
import { Icon } from "./Icon";

export interface QueueListProps {
  /** Isi antrean; teks penuh (klien yang memotong tampilan). */
  items: readonly QueuedMessageView[];
  /** Kirim pesan ini sekarang (giliran berjalan dihentikan dulu). */
  onSendNow: (id: string) => void;
  /** Arahkan pesan ini ke giliran yang berjalan tanpa menghentikannya. */
  onSteer?: (id: string) => void;
  /** Buang pesan ini dari antrean. */
  onRemove: (id: string) => void;
  /** Tombol "Kirim sekarang" tak aktif (mis. sesi tak sedang berjalan). */
  disabled?: boolean;
  /** Tombol hapus tak aktif (mis. permintaan sebelumnya masih jalan). */
  removeDisabled?: boolean;
}

/**
 * Daftar pesan yang menunggu giliran: satu baris per pesan dengan tombol
 * "Arahkan", "Kirim sekarang" dan tombol hapus.
 */
export function QueueList({
  items,
  onSendNow,
  onSteer,
  onRemove,
  disabled = false,
  removeDisabled,
}: QueueListProps) {
  if (items.length === 0) return null;
  const removeMati = removeDisabled === true;
  return (
    <ul class="jk-queue" aria-label="Pesan antrean">
      {items.map((item) => (
        <li key={item.id} class="jk-queue-row">
          <span class="jk-queue-text" title={item.text}>
            {queuePreview(item.text)}
          </span>
          {onSteer !== undefined && (
            <button
              type="button"
              class="jk-pill-btn jk-queue-send"
              title="Sisipkan ke giliran yang berjalan tanpa menghentikannya"
              disabled={disabled}
              onClick={() => onSteer(item.id)}
            >
              Arahkan
            </button>
          )}
          <button
            type="button"
            class="jk-pill-btn jk-queue-send"
            title="Hentikan giliran lalu jalankan pesan ini"
            disabled={disabled}
            onClick={() => onSendNow(item.id)}
          >
            Kirim sekarang
          </button>
          <button
            type="button"
            class="jk-icon-btn jk-queue-remove"
            aria-label="Hapus dari antrean"
            title="Hapus dari antrean"
            disabled={removeMati}
            onClick={() => onRemove(item.id)}
          >
            <Icon name="close" />
          </button>
        </li>
      ))}
    </ul>
  );
}
