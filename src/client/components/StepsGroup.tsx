import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon";

export interface StepsGroupProps {
  /** Ringkasan saat selesai, mis. "Berpikir, menjalankan 2 perintah". */
  summary: string;
  /** Judul saat berjalan: deskripsi langkah terbaru. */
  liveLabel: string;
  live: boolean;
  failed: number;
  children: ComponentChildren;
}

/** "37 dtk", "1 mnt 2 dtk". */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds} dtk`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} mnt` : `${minutes} mnt ${rest} dtk`;
}

/**
 * Lama berjalan dihitung di klien sejak blok terlihat berjalan; blok yang sudah
 * selesai saat dimuat tidak punya lama (server tidak mencatat waktu per langkah).
 */
function useElapsed(live: boolean): number | undefined {
  const startedAt = useRef<number | undefined>(undefined);
  const [seconds, setSeconds] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!live) return;
    if (startedAt.current === undefined) startedAt.current = Date.now();
    const tick = (): void => {
      if (startedAt.current !== undefined) setSeconds((Date.now() - startedAt.current) / 1000);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
      tick();
    };
  }, [live]);

  return seconds;
}

/** Blok langkah terlipat ala Claude: judul (langkah terbaru + lama) di atas kartu daftar langkah. */
export function StepsGroup({ summary, liveLabel, live, failed, children }: StepsGroupProps) {
  const elapsed = useElapsed(live);
  const title = live && liveLabel !== "" ? liveLabel : summary;
  return (
    <details class="jk-step jk-steps">
      <summary>
        {live && (
          <span class="jk-dots" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        <span class="jk-steps-text">{title}</span>
        {elapsed !== undefined && elapsed >= 1 && <span class="jk-steps-time">{formatElapsed(elapsed)}</span>}
        {failed > 0 && <span class="jk-step-status jk-step-gagal">{failed} gagal</span>}
        <span class="jk-chev">
          <Icon name="chevron" />
        </span>
      </summary>
      <div class="jk-steps-list">{children}</div>
    </details>
  );
}
