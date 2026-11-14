import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef } from "preact/hooks";
import {
  canDismiss,
  confirmButtonClass,
  initialFocusTarget,
  nextFocusIndex,
  type ConfirmTone,
} from "../lib/confirm-dialog";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: ComponentChildren;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  busy?: boolean;
  busyLabel?: string;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Referensi DOM + penagan keyboard milik satu modal. */
export interface ConfirmDialogBindings {
  cardRef: { current: HTMLDivElement | null };
  confirmRef: { current: HTMLButtonElement | null };
  cancelRef: { current: HTMLButtonElement | null };
  onKeyDown: (event: KeyboardEvent) => void;
  onOverlayPointerDown: (event: PointerEvent) => void;
  onOverlayWheel: (event: WheelEvent) => void;
}

export interface ConfirmDialogViewProps extends ConfirmDialogProps {
  cardRef?: ConfirmDialogBindings["cardRef"];
  confirmRef?: ConfirmDialogBindings["confirmRef"];
  cancelRef?: ConfirmDialogBindings["cancelRef"];
  onKeyDown?: ConfirmDialogBindings["onKeyDown"];
  onOverlayPointerDown?: ConfirmDialogBindings["onOverlayPointerDown"];
  onOverlayWheel?: ConfirmDialogBindings["onOverlayWheel"];
  idPrefix?: string;
}

/**
 * Tampilan modal tanpa hook; dipakai uji render tanpa DOM.
 * Perilaku fokus dan keyboard disediakan lewat props bindings.
 */
export function ConfirmDialogView(props: ConfirmDialogViewProps) {
  const {
    open,
    title,
    message,
    confirmLabel,
    cancelLabel = "Batal",
    tone = "default",
    busy = false,
    busyLabel,
    error,
    onConfirm,
    onCancel,
    cardRef,
    confirmRef,
    cancelRef,
    onKeyDown,
    onOverlayPointerDown,
    onOverlayWheel,
    idPrefix = "jk-confirm",
  } = props;

  if (!open) return null;

  const titleId = `${idPrefix}-title`;
  const messageId = `${idPrefix}-message`;
  const confirmText = busy ? (busyLabel ?? confirmLabel) : confirmLabel;

  return (
    <div
      class="jk-overlay jk-confirm-overlay"
      onPointerDown={onOverlayPointerDown}
      onWheel={onOverlayWheel}
    >
      <div
        class={`jk-confirm-card jk-confirm-card-${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message === undefined ? undefined : messageId}
        ref={cardRef}
        onKeyDown={onKeyDown}
      >
        <h2 class="jk-confirm-title" id={titleId}>
          {title}
        </h2>

        {message !== undefined && (
          <div class="jk-confirm-message" id={messageId}>
            {message}
          </div>
        )}

        {error !== undefined && (
          <p class="jk-confirm-error" role="alert">
            {error}
          </p>
        )}

        <div class="jk-confirm-actions">
          <button
            ref={confirmRef}
            type="button"
            class={confirmButtonClass(tone)}
            disabled={busy}
            aria-busy={busy ? "true" : undefined}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
          <button
            ref={cancelRef}
            type="button"
            class="jk-button"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Menyiapkan fokus awal, jebakan fokus, Escape, pembatalan saat busy,
 * kunci gulir latar, dan pengembalian fokus setelah modal ditutup.
 */
export function useConfirmDialogBindings(props: {
  open: boolean;
  busy: boolean;
  tone: ConfirmTone;
  onCancel: () => void;
}): ConfirmDialogBindings {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const previousRef = useRef<HTMLElement | null>(null);

  // Fokus awal saat modal dibuka; elemen sebelumnya disimpan untuk dikembalikan.
  useEffect(() => {
    if (!props.open) return;
    if (previousRef.current === null) {
      const previous = document.activeElement;
      previousRef.current = previous instanceof HTMLElement ? previous : null;
    }
    const target =
      initialFocusTarget(props.tone) === "cancel" ? cancelRef.current : confirmRef.current;
    target?.focus();
  }, [props.open, props.tone]);

  // Fokus dikembalikan ke elemen sebelum modal dibuka.
  useEffect(() => {
    if (props.open) return;
    const previous = previousRef.current;
    previousRef.current = null;
    previous?.focus();
  }, [props.open]);

  // Latar tidak boleh bisa digulir selama modal terbuka.
  useEffect(() => {
    if (!props.open) return;
    const body = document.body;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previous;
    };
  }, [props.open]);

  // Pengaman: Escape menutup modal meski fokus berada di luar kartu.
  useEffect(() => {
    if (!props.open) return;
    const onDocKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (!canDismiss(props.busy)) return;
      props.onCancel();
    };
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
  }, [props.open, props.busy, props.onCancel]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        if (!canDismiss(props.busy)) return;
        event.preventDefault();
        event.stopPropagation();
        props.onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const card = cardRef.current;
      if (card === null) return;
      const items = Array.from(card.querySelectorAll<HTMLElement>("button:not([disabled])"));
      if (items.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const direction: 1 | -1 = event.shiftKey ? -1 : 1;
      const next =
        current === -1
          ? direction === 1
            ? 0
            : items.length - 1
          : nextFocusIndex(current, items.length, direction);
      items[next]?.focus();
    },
    [props.busy, props.onCancel],
  );

  const onOverlayPointerDown = useCallback(
    (event: PointerEvent): void => {
      if (event.target !== event.currentTarget) return;
      if (!canDismiss(props.busy)) return;
      props.onCancel();
    },
    [props.busy, props.onCancel],
  );

  const onOverlayWheel = useCallback((event: WheelEvent): void => {
    // Latar di belakang modal tidak boleh tergulir; isi modal tetap bisa digulir.
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
  }, []);

  return { cardRef, confirmRef, cancelRef, onKeyDown, onOverlayPointerDown, onOverlayWheel };
}

/** Modal konfirmasi siap pakai; pasang di mana saja dalam satu halaman. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const bindings = useConfirmDialogBindings({
    open: props.open,
    busy: props.busy ?? false,
    tone: props.tone ?? "default",
    onCancel: props.onCancel,
  });

  return <ConfirmDialogView {...props} {...bindings} />;
}
