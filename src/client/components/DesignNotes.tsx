import { useRef } from "preact/hooks";
import type { DesignNote } from "../lib/api";

export interface DesignNotesProps {
  notes: readonly DesignNote[];
  zoom: number;
  /** Teks catatan berubah; baru disimpan lokal. */
  onTextChange: (id: string, text: string) => void;
  /** Teks selesai diketik (blur atau jeda); simpan bila berubah. */
  onTextCommit: (id: string) => void;
  /** Posisi catatan berubah saat pegangan diseret. */
  onMove: (id: string, x: number, y: number) => void;
  /** Seretan selesai; simpan posisi bila berubah. */
  onMoveCommit: (id: string) => void;
  /** Catatan dihapus dari kanvas. */
  onDelete: (id: string) => void;
  /** Ada textarea catatan yang terfokus (atau tak ada). */
  onFocusChange: (focused: boolean) => void;
  /** Seretan mulai atau selesai. */
  onDragChange?: (dragging: boolean) => void;
  /** Daftarkan textarea agar bisa difokuskan setelah catatan baru dibuat. */
  registerTextarea?: (id: string, element: HTMLTextAreaElement | null) => void;
}

interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

/**
 * Catatan tempel di kanvas: kotak kecil berisi teks bebas pada koordinat
 * dunia. Ukuran di layar tetap (lebar 180 px) walau zoom kanvas berubah;
 * pegangan di atasnya untuk memindahkan catatan.
 */
export function DesignNotes(props: DesignNotesProps) {
  const dragRef = useRef<DragState | null>(null);
  const zoom = props.zoom > 0 ? props.zoom : 1;

  const onHandleDown = (note: DesignNote, event: PointerEvent): void => {
    if (event.button !== 0) return;
    // Catatan tak memulai pan kanvas: pointer berhenti di sini.
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      id: note.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: note.x,
      originY: note.y,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    props.onDragChange?.(true);
  };

  const onHandleMove = (event: PointerEvent): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    props.onMove(
      drag.id,
      drag.originX + (event.clientX - drag.startX) / zoom,
      drag.originY + (event.clientY - drag.startY) / zoom,
    );
  };

  const onHandleUp = (event: PointerEvent): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.stopPropagation();
    props.onDragChange?.(false);
    props.onMoveCommit(drag.id);
  };

  return (
    <>
      {props.notes.map((note) => (
        <div
          key={note.id}
          class="jk-design-note"
          data-note={note.id}
          style={{
            left: `${note.x}px`,
            top: `${note.y}px`,
            transform: `scale(${1 / zoom})`,
          }}
        >
          <div
            class="jk-design-note-handle"
            title="Geser catatan"
            aria-label="Geser catatan"
            onPointerDown={(event) => onHandleDown(note, event)}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
          />
          <textarea
            class="jk-design-note-text"
            aria-label="Catatan"
            maxLength={500}
            rows={3}
            value={note.text}
            ref={(element) => props.registerTextarea?.(note.id, element)}
            onInput={(event) =>
              props.onTextChange(
                note.id,
                (event.currentTarget as HTMLTextAreaElement).value,
              )
            }
            onFocus={() => props.onFocusChange(true)}
            onBlur={() => {
              props.onFocusChange(false);
              props.onTextCommit(note.id);
            }}
          />
          <button
            type="button"
            class="jk-design-note-delete"
            aria-label="Hapus catatan"
            onClick={() => props.onDelete(note.id)}
          >
            Hapus
          </button>
        </div>
      ))}
    </>
  );
}
