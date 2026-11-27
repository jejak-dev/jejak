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

/** Baris sesi dari ringkasan pemakaian (bentuk `UsageSessionBucket`). */
export interface UsageSessionRow {
  sessionId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  lastTs: string;
}

export interface UsageSessionGroup extends UsageSessionRow {
  /** Id induk untuk tim; untuk sesi biasa sama dengan `sessionId`. */
  id: string;
  /** true bila sesi ini punya anak (tim). */
  team: boolean;
  /** Jumlah anak menurut daftar sesi klien. */
  childCount: number;
  /** Anggota yang tampil saat baris dibuka; induk lebih dulu bila ada. */
  members: UsageSessionRow[];
}

export interface UsageTeamLookup {
  /** Induk dari satu sesi; `undefined` untuk sesi biasa. */
  parentOf: (sessionId: string) => string | undefined;
  /** Jumlah anak milik satu induk; 0 untuk sesi biasa. */
  childCount: (parentId: string) => number;
}

/**
 * Gabungkan baris sesi menjadi satu baris per tim (induk + anak) dan biarkan
 * sesi biasa apa adanya. Urutan mengikuti biaya grup menurun; nilai anggota
 * tidak diubah sehingga total keseluruhan tetap. Tanpa tim hasilnya identik
 * dengan masukan.
 */
export function groupUsageSessions(
  rows: readonly UsageSessionRow[],
  lookup: UsageTeamLookup,
): UsageSessionGroup[] {
  const groups = new Map<string, UsageSessionGroup>();
  for (const row of rows) {
    const parentId = lookup.parentOf(row.sessionId);
    const id = parentId ?? row.sessionId;
    let group = groups.get(id);
    if (group === undefined) {
      const childCount = lookup.childCount(id);
      group = {
        id,
        sessionId: id,
        team: childCount > 0,
        childCount,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        turns: 0,
        lastTs: row.lastTs,
        members: [],
      };
      groups.set(id, group);
    }
    group.costUsd += row.costUsd;
    group.inputTokens += row.inputTokens;
    group.outputTokens += row.outputTokens;
    group.turns += row.turns;
    if (row.lastTs > group.lastTs) group.lastTs = row.lastTs;
    group.members.push(row);
  }
  return Array.from(groups.values()).sort(
    (a, b) => b.costUsd - a.costUsd || a.id.localeCompare(b.id),
  );
}
