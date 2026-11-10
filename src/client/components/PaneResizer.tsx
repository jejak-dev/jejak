import { useRef, useState } from "preact/hooks";

export interface PaneResizerProps {
  width: number;
  min: number;
  max: number;
  def: number;
  label: string;
  /** "end": pegangan di tepi kanan panel (seret ke kanan melebarkan); "start": di tepi kiri (seret ke kiri melebarkan). */
  edge: "end" | "start";
  /** Posisi absolut pegangan, mis. `{ left: "261px" }`. */
  style: Record<string, string>;
  clamp: (value: number) => number;
  keyFor: (current: number, key: string) => number | undefined;
  onChange: (width: number) => void;
  /** Dipanggil saat geseran selesai atau tombol dipakai; untuk menyimpan. */
  onCommit: (width: number) => void;
}

/** Pegangan tipis: seret, panah kiri/kanan, atau klik dua kali untuk reset. */
export function PaneResizer(props: PaneResizerProps) {
  const { width, min, max, def, label, edge, style, clamp, keyFor, onChange, onCommit } = props;
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, width });
  const sign = edge === "end" ? 1 : -1;
  const widthAt = (clientX: number): number =>
    clamp(startRef.current.width + sign * (clientX - startRef.current.x));

  return (
    <div
      class={`jk-resizer${dragging ? " jk-resizer-active" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      style={style}
      onPointerDown={(event) => {
        event.preventDefault();
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        startRef.current = { x: event.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (dragging) onChange(widthAt(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        setDragging(false);
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
        onCommit(widthAt(event.clientX));
      }}
      onPointerCancel={() => setDragging(false)}
      onDblClick={() => {
        onChange(def);
        onCommit(def);
      }}
      onKeyDown={(event) => {
        const next = keyFor(width, event.key);
        if (next === undefined) return;
        event.preventDefault();
        onChange(next);
        onCommit(next);
      }}
    />
  );
}
