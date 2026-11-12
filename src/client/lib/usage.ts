/**
 * Fungsi murni untuk halaman Usage. Tidak menyentuh DOM, jadi bisa diuji
 * tanpa browser.
 */

/** Biaya dolar: `$0.00` untuk nol, `$0.0123` untuk di bawah satu dolar. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 1) {
    const trimmed = usd.toFixed(4).replace(/0+$/, "");
    return `$${trimmed.endsWith(".") ? `${trimmed}00` : trimmed}`;
  }
  return `$${usd.toFixed(2)}`;
}

/** Token ringkas: `950`, `1.2k`, `3.4M`. */
export function formatTokensShort(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1000) return `${trimDecimal(value / 1000)}k`;
  return String(Math.round(value));
}

function trimDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return String(rounded).replace(/\.0$/, "");
}

/**
 * Tinggi batang relatif terhadap nilai terbesar. Nilai positif minimal
 * 2px supaya batang tidak hilang; nilai nol tetap 0.
 */
export function barHeights(values: readonly number[], maxPx: number): number[] {
  const limit = Number.isFinite(maxPx) && maxPx > 0 ? maxPx : 0;
  const safe = values.map((value) =>
    Number.isFinite(value) && value > 0 ? value : 0,
  );
  const max = safe.reduce((highest, value) => (value > highest ? value : highest), 0);
  if (max <= 0 || limit <= 0) return safe.map(() => 0);
  return safe.map((value) => {
    if (value <= 0) return 0;
    return Math.max(2, Math.round((value / max) * limit));
  });
}

/** Porsi nilai terhadap total, antara 0 dan 1. */
export function shareOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  const share = part / total;
  if (!Number.isFinite(share) || share <= 0) return 0;
  return Math.min(1, share);
}

/** Label rentang: "7 hari terakhir". */
export function rangeLabel(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return "rentang ini";
  return `${Math.round(days)} hari terakhir`;
}
