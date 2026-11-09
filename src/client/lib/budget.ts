import type { BudgetStatusResult } from "./api";

export const MIN_WARN_PERCENT = 50;
export const MAX_WARN_PERCENT = 95;
export const MAX_USD = 100_000;

export interface UsdParseResult {
  /** `null` berarti hapus batas; `undefined` saat galat. */
  value?: number | null;
  error?: string;
}

/** Kosong -> hapus batas; koma atau titik desimal; > 0 dan <= 100000. */
export function parseUsdInput(text: string): UsdParseResult {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null };
  const normalized = trimmed.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return { error: "Batas harus angka lebih dari 0." };
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: "Batas harus angka lebih dari 0." };
  }
  if (value > MAX_USD) {
    return { error: "Batas paling banyak 100000." };
  }
  return { value };
}

/** Persen 50–95 menjadi 0.5–0.95; kosong -> 0.8 bawaan. */
export function parseWarnPercent(text: string): { value?: number; error?: string } {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return { value: 0.8 };
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { error: "Peringatan harus angka antara 50 dan 95." };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < MIN_WARN_PERCENT || value > MAX_WARN_PERCENT) {
    return { error: "Peringatan harus angka antara 50 dan 95." };
  }
  return { value: Number((value / 100).toFixed(4)) };
}

/** `US$1,23`; di bawah satu sen menjadi `<US$0,01`; nilai tak valid `US$0,00`. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "US$0,00";
  if (value < 0.01) return "<US$0,01";
  return `US$${value.toFixed(2).replace(".", ",")}`;
}

function percentOf(spent: number, limit: number): number {
  return Math.round((spent / limit) * 100);
}

/** `Hari ini US$1,20 dari US$5,00 (24%)` atau `Hari ini US$1,20 · tanpa batas harian`. */
export function budgetLine(status: BudgetStatusResult): string {
  const spent = formatUsd(status.todayUsd);
  const limit = status.config.dailyUsd;
  if (limit === undefined) return `Hari ini ${spent} · tanpa batas harian`;
  return `Hari ini ${spent} dari ${formatUsd(limit)} (${percentOf(status.todayUsd, limit)}%)`;
}

export interface BudgetBadge {
  label: string;
  title: string;
  tone: "warn" | "bad";
}

function scopeText(scope: "sesi" | "hari", level: "warn" | "over"): string {
  const batas = level === "over" ? "terlewati" : "hampir habis";
  return `Batas anggaran ${scope} ${batas}`;
}

/**
 * Lencana header dari `session.budget`; `over` di cakupan mana pun menang.
 * `undefined` bila tidak ada tingkat warn/over.
 */
export function budgetBadge(
  session: { budget?: { session?: string; day?: string } },
): BudgetBadge | undefined {
  const sessionLevel = session.budget?.session;
  const dayLevel = session.budget?.day;
  const order = (level: string | undefined): number =>
    level === "over" ? 2 : level === "warn" ? 1 : 0;
  const sessionRank = order(sessionLevel);
  const dayRank = order(dayLevel);
  const rank = Math.max(sessionRank, dayRank);
  if (rank === 0) return undefined;

  const tone: "warn" | "bad" = rank === 2 ? "bad" : "warn";
  const label = rank === 2 ? "Anggaran terlewati" : "Anggaran hampir habis";

  const scopes: string[] = [];
  if (sessionRank === rank) scopes.push("sesi");
  if (dayRank === rank) scopes.push("hari");
  const text =
    scopes.length === 2
      ? "Batas anggaran sesi dan hari " + (rank === 2 ? "terlewati" : "hampir habis")
      : scopeText(scopes[0] === "hari" ? "hari" : "sesi", rank === 2 ? "over" : "warn");

  return {
    label,
    title: `${text}. Sesi tidak dihentikan; anggaran hanya peringatan.`,
    tone,
  };
}
