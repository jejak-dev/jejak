/** Nada lencana status: menyala (hijau) atau mati (redup). */
export type StatusTone = "success" | "muted";

export interface StatusBadgeProps {
  /** Label singkat, mis. "Aktif" atau "Mati". */
  label: string;
  /** Nada warna titik. */
  tone: StatusTone;
}

/**
 * Lencana status kecil: titik berwarna plus label. Titik memakai kelas
 * `.jk-dot` yang sudah dipakai titik status sesi, jadi warnanya ikut token.
 */
export function StatusBadge({ label, tone }: StatusBadgeProps) {
  return (
    <span class={`jk-status-badge${tone === "success" ? " jk-status-badge-on" : ""}`}>
      <span class="jk-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
