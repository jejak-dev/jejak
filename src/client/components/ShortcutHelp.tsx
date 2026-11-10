import { useEffect, useRef } from "preact/hooks";
import { SHORTCUT_LIST } from "../lib/shortcuts";

export interface ShortcutHelpProps {
  onClose: () => void;
}

export function ShortcutHelp({ onClose }: ShortcutHelpProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Pengaman: Escape menutup overlay meski fokus berada di luar dialog.
  useEffect(() => {
    const onDocKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.isComposing) onClose();
    };
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      closeRef.current?.focus();
    }
  };

  return (
    <div
      class="jk-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        class="jk-palette jk-shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onKeyDown={onKeyDown}
      >
        <header class="jk-shortcut-head">
          <h2 class="jk-shortcut-title">Keyboard shortcuts</h2>
          <button
            ref={closeRef}
            type="button"
            class="jk-icon-btn"
            aria-label="Tutup bantuan pintasan"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <dl class="jk-shortcut-list">
          {SHORTCUT_LIST.map((item) => (
            <div class="jk-shortcut-row" key={item.label}>
              <dt class="jk-shortcut-label">{item.label}</dt>
              <dd class="jk-shortcut-keys">{item.keys}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
