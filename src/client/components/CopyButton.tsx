import { copyText } from "../lib/clipboard";
import { Icon } from "./Icon";

export interface CopyButtonProps {
  text: string | (() => string);
  /** Kata kerja pada aria-label, mis. "Salin perintah". */
  label?: string;
}

/**
 * Tombol salin kecil. Sengaja tanpa hook: umpan balik "Disalin" ditulis ke DOM
 * lewat ref, sehingga komponen ini juga aman ditelusuri tes VNode tanpa DOM
 * (dipakai di Markdown yang diuji dengan penelusuran pohon).
 */
const RESET_MS = 1500;
const timers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

function showFeedback(button: HTMLButtonElement, message: string): void {
  button.classList.toggle("jk-copy-done", message === "Disalin");
  button.classList.toggle("jk-copy-failed", message === "Gagal menyalin");
  const note = button.querySelector(".jk-copy-text");
  if (note !== null) note.textContent = message;
}

export function CopyButton({ text, label = "Salin" }: CopyButtonProps) {
  const onClick = (event: MouseEvent): void => {
    const button = event.currentTarget as HTMLButtonElement;
    void (async () => {
      const ok = await copyText(typeof text === "function" ? text() : text);
      showFeedback(button, ok ? "Disalin" : "Gagal menyalin");
      const previous = timers.get(button);
      if (previous !== undefined) clearTimeout(previous);
      timers.set(
        button,
        setTimeout(() => {
          timers.delete(button);
          showFeedback(button, "");
        }, RESET_MS),
      );
    })();
  };

  // Ref dibuat per render agar pembersihan timer tidak saling menimpa antar tombol.
  // Preact memanggil cleanup juga saat re-render dengan elemen yang sama; timer
  // hanya dibersihkan bila elemen benar-benar sudah lepas dari dokumen.
  const bindRef = (node: HTMLButtonElement | null): (() => void) | undefined => {
    if (node === null) return undefined;
    return () => {
      queueMicrotask(() => {
        if (node.isConnected) return;
        const timer = timers.get(node);
        if (timer !== undefined) {
          clearTimeout(timer);
          timers.delete(node);
        }
      });
    };
  };

  return (
    <button
      type="button"
      class="jk-copy"
      aria-label={label}
      title={label}
      onClick={onClick}
      ref={bindRef}
    >
      <Icon name="copy" />
      <span class="jk-copy-text" aria-live="polite" />
    </button>
  );
}
