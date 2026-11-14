import { useRef, useState } from "preact/hooks";
import { draggedSizeAbove } from "../lib/pane-layout";

export interface PaneDividerViewProps {
  /** Indeks pembatas: antara jendela `index` dan `index + 1`. */
  index: number;
  /** Pecahan tinggi jendela di atas pembatas. */
  sizeAbove: number;
  /** Sedang diseret. */
  dragging?: boolean;
  onPointerDown?: (event: PointerEvent) => void;
  onPointerMove?: (event: PointerEvent) => void;
  onPointerUp?: (event: PointerEvent) => void;
  onPointerCancel?: (event: PointerEvent) => void;
  onDblClick?: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

/**
 * Pembatas tinggi antar jendela; tampilan murni tanpa hook supaya bisa diuji
 * tanpa DOM. Perilaku seret dan keyboard diberikan lewat props.
 */
export function PaneDividerView(props: PaneDividerViewProps) {
  const persen = Math.round(props.sizeAbove * 100);
  return (
    <div
      class={`jk-pane-divider${props.dragging === true ? " jk-pane-divider-active" : ""}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Ukuran jendela"
      aria-valuenow={persen}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
      onDblClick={props.onDblClick}
      onKeyDown={props.onKeyDown}
    />
  );
}

export interface PaneDividerProps {
  /** Indeks pembatas: antara jendela `index` dan `index + 1`. */
  index: number;
  /** Pecahan tinggi jendela di atas pembatas. */
  sizeAbove: number;
  /** Dipanggil saat ukuran jendela di atas berubah (pecahan 0..1). */
  onResize: (sizeAbove: number) => void;
  /** Dipanggil saat seretan dimulai; dipakai untuk menunda penyimpanan. */
  onDragStart?: () => void;
  /** Dipanggil saat seret selesai; dipakai untuk menyimpan tata letak. */
  onCommit: () => void;
  /** Dipanggil saat panah atau Home/End ditekan. */
  onKeyResize?: (key: string) => void;
  /** Dipanggil saat klik dua kali: bagi rata dua jendela tetangga. */
  onEven?: () => void;
}

/** Kunci yang mengubah tinggi jendela lewat keyboard. */
const RESIZE_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * Pembatas antar jendela: seret dengan pointer, panah atau Home/End untuk
 * keyboard, dan klik dua kali untuk membagi rata dua tetangga.
 */
export function PaneDivider(props: PaneDividerProps) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ y: 0, sizeAbove: 0 });

  /** Tinggi tumpukan jendela; dasar perhitungan perpindahan pecahan. */
  const tinggiTumpukan = (element: HTMLElement): number =>
    element.parentElement?.getBoundingClientRect().height ?? 0;

  return (
    <PaneDividerView
      index={props.index}
      sizeAbove={props.sizeAbove}
      dragging={dragging}
      onPointerDown={(event) => {
        event.preventDefault();
        const element = event.currentTarget as HTMLElement;
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // Pointer tiruan tanpa id valid; seretan tetap jalan tanpa capture.
        }
        startRef.current = { y: event.clientY, sizeAbove: props.sizeAbove };
        setDragging(true);
        props.onDragStart?.();
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        const element = event.currentTarget as HTMLElement;
        const tinggi = tinggiTumpukan(element);
        if (tinggi <= 0) return;
        const geser = event.clientY - startRef.current.y;
        props.onResize(draggedSizeAbove(startRef.current.sizeAbove, geser, tinggi));
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        setDragging(false);
        const element = event.currentTarget as HTMLElement;
        try {
          if (element.hasPointerCapture(event.pointerId)) {
            element.releasePointerCapture(event.pointerId);
          }
        } catch {
          // Capture tidak pernah aktif; abaikan.
        }
        props.onCommit();
      }}
      onPointerCancel={() => {
        if (!dragging) return;
        setDragging(false);
      }}
      onDblClick={() => props.onEven?.()}
      onKeyDown={(event) => {
        if (!RESIZE_KEYS.has(event.key)) return;
        event.preventDefault();
        props.onKeyResize?.(event.key);
      }}
    />
  );
}
