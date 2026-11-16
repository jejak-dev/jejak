export interface SecretBadge {
  /** Teks pendek pada lencana header. */
  label: string;
  title: string;
  /** Label untuk pembaca layar; menyebut keadaan utuh. */
  ariaLabel: string;
}

/**
 * Lencana header untuk sesi yang punya event tersamarkan. `undefined` bila
 * tidak ada (atau nol), agar header tetap ringkas.
 */
export function secretBadge(session: { redactedEvents?: number }): SecretBadge | undefined {
  const count = session.redactedEvents;
  if (count === undefined || !Number.isFinite(count) || count <= 0) return undefined;
  return {
    label: "Disamarkan",
    ariaLabel: "Rahasia disamarkan",
    title: `${count} event disamarkan di sesi ini. Lihat Audit log untuk rinciannya.`,
  };
}
