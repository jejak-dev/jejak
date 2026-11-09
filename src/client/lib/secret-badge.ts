export interface SecretBadge {
  label: string;
  title: string;
}

/**
 * Lencana header untuk sesi yang punya event tersamarkan. `undefined` bila
 * tidak ada (atau nol), agar header tetap ringkas.
 */
export function secretBadge(session: { redactedEvents?: number }): SecretBadge | undefined {
  const count = session.redactedEvents;
  if (count === undefined || !Number.isFinite(count) || count <= 0) return undefined;
  return {
    label: "Rahasia disamarkan",
    title: `${count} event disamarkan di sesi ini. Lihat Log audit untuk rinciannya.`,
  };
}
