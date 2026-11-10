import { useRef, useState } from "preact/hooks";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebarWidth,
  widthForKey,
} from "../lib/sidebar-width";

export interface SidebarResizerProps {
  width: number;
  onChange: (width: number) => void;
  /** Dipanggil saat geseran selesai atau tombol dipakai; untuk menyimpan. */
  onCommit: (width: number) => void;
}

/** Pegangan tipis di tepi kanan sidebar: seret, panah kiri/kanan, atau klik dua kali untuk reset. */
export function SidebarResizer({ width, onChange, onCommit }: SidebarResizerProps) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, width });

  return (
    <div
      class={`jk-resizer${dragging ? " jk-resizer-active" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Lebar sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      style={{ left: `${width - 3}px` }}
      onPointerDown={(event) => {
        event.preventDefault();
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        startRef.current = { x: event.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        onChange(clampSidebarWidth(startRef.current.width + event.clientX - startRef.current.x));
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        setDragging(false);
        (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
        onCommit(clampSidebarWidth(startRef.current.width + event.clientX - startRef.current.x));
      }}
      onPointerCancel={() => setDragging(false)}
      onDblClick={() => {
        onChange(SIDEBAR_DEFAULT);
        onCommit(SIDEBAR_DEFAULT);
      }}
      onKeyDown={(event) => {
        const next = widthForKey(width, event.key);
        if (next === undefined) return;
        event.preventDefault();
        onChange(next);
        onCommit(next);
      }}
    />
  );
}
