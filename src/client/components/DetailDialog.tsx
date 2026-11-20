import type { ComponentChildren } from "preact";
import {
  useConfirmDialogBindings,
  type ConfirmDialogBindings,
} from "./ConfirmDialog";
import { Icon } from "./Icon";

export interface DetailDialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  /** Ada modal lain menumpuk di atasnya: Escape dan klik latar tak menutup ini. */
  suspended?: boolean;
  busy?: boolean;
  idPrefix?: string;
}

export interface DetailDialogViewProps extends DetailDialogProps {
  bindings: ConfirmDialogBindings;
}

/** Pemilih elemen yang menerima fokus awal: tombol Tutup. */
export const DETAIL_FOCUS_SELECTOR = ".jk-detail-close";

/**
 * Tampilan modal detail tanpa hook; dipakai uji render tanpa DOM.
 * Memakai kartu dan latar modal yang sama dengan modal konfirmasi.
 */
export function DetailDialogView(props: DetailDialogViewProps) {
  const { open, title, onClose, children, suspended = false, bindings } = props;
  if (!open) return null;

  const titleId = `${props.idPrefix ?? "jk-detail"}-title`;

  return (
    <div
      class="jk-overlay jk-confirm-overlay"
      onPointerDown={suspended ? undefined : bindings.onOverlayPointerDown}
      onWheel={bindings.onOverlayWheel}
    >
      <div
        class="jk-confirm-card jk-detail-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={bindings.cardRef}
        onKeyDown={suspended ? undefined : bindings.onKeyDown}
      >
        <div class="jk-detail-head">
          <h2 class="jk-confirm-title jk-detail-title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            class="jk-icon-btn jk-detail-close"
            aria-label="Tutup"
            disabled={props.busy === true}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="jk-detail-body">{children}</div>
      </div>
    </div>
  );
}

/** Modal detail siap pakai: fokus, Escape, jebakan fokus, dan kunci gulir. */
export function DetailDialog(props: DetailDialogProps) {
  const bindings = useConfirmDialogBindings({
    open: props.open && props.suspended !== true,
    busy: props.busy ?? false,
    tone: "default",
    initialFocusSelector: DETAIL_FOCUS_SELECTOR,
    onCancel: props.onClose,
  });
  return <DetailDialogView {...props} bindings={bindings} />;
}
