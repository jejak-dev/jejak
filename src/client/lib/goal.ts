/**
 * Mode Goal di sisi klien: parsing perintah, label, dan validasi batas.
 *
 * Modul ini murni: tidak menyentuh DOM, jaringan, atau penyimpanan.
 */
import type { GoalEndReason, GoalStatus, GoalView } from "../../server/goals/goal";
import { formatCost } from "./format";

/** Bawaan giliran otomatis (sama dengan server). */
export const DEFAULT_MAX_TURNS = 10;
/** Batas keras giliran otomatis (sama dengan server). */
export const HARD_MAX_TURNS = 50;
/** Batas atas plafon biaya yang boleh diminta pengguna. */
export const MAX_COST_CAP_USD = 1000;

export type { GoalEndReason, GoalStatus, GoalView };

/**
 * Perintah `/goal <tujuan>` (huruf besar/kecil tak dibedakan) yang diikuti
 * spasi atau baris baru adalah perintah Goal, bukan giliran biasa.
 * `/goal` tanpa isi dan `/goalx` bukan perintah.
 */
export function parseGoalCommand(text: string): string | undefined {
  const trimmed = text.trim();
  const match = /^\/goal(?:[ \t]+|\r?\n)([\s\S]*)$/i.exec(trimmed);
  if (match === null) return undefined;
  const objective = (match[1] ?? "").trim();
  return objective === "" ? undefined : objective;
}

/** Progres giliran otomatis: "giliran 3 dari 10". */
export function goalProgressLabel(goal: Pick<GoalView, "autoTurns" | "maxTurns">): string {
  return `giliran ${goal.autoTurns} dari ${goal.maxTurns}`;
}

const STATUS_LABELS: Record<GoalStatus, string> = {
  active: "Berjalan",
  paused: "Dijeda",
  achieved: "Tercapai",
  blocked: "Buntu",
  stopped: "Dihentikan",
};

/** Label status tujuan dalam Bahasa Indonesia. */
export function goalStatusLabel(goal: Pick<GoalView, "status">): string {
  return STATUS_LABELS[goal.status];
}

const REASON_LABELS: Record<GoalEndReason, string> = {
  selesai: "Tujuan tercapai",
  buntu: "Agent melaporkan buntu",
  "plafon-giliran": "Batas giliran otomatis tercapai",
  "plafon-biaya": "Plafon biaya tercapai",
  "anggaran-sesi": "Anggaran sesi terlampaui",
  "tanpa-kemajuan": "Dua giliran tanpa kemajuan",
  gagal: "Giliran gagal",
  dihentikan: "Dihentikan",
};

/** Label alasan berakhirnya tujuan; alasan tak dikenal jatuh ke umum. */
export function goalReasonLabel(reason: GoalEndReason): string {
  return REASON_LABELS[reason] ?? REASON_LABELS.dihentikan;
}

/** Tujuan masih berjalan (loop otomatis hidup). */
export function goalIsLive(goal: Pick<GoalView, "status">): boolean {
  return goal.status === "active";
}

/** Tujuan dijeda dan boleh dilanjutkan. */
export function goalCanResume(goal: Pick<GoalView, "status">): boolean {
  return goal.status === "paused";
}

/** Tujuan sudah berakhir (hasil akhir, bukan jeda). */
export function goalIsFinished(goal: Pick<GoalView, "status">): boolean {
  return goal.status === "achieved" || goal.status === "blocked" || goal.status === "stopped";
}

/**
 * Plafon biaya sebagai label, mis. "plafon $5,00". Tanpa plafon: `undefined`.
 * Biaya sejak mulai tidak dikirim server, jadi tidak pernah dihitung di klien.
 */
export function goalCostCapLabel(goal: Pick<GoalView, "costCapUsd">): string | undefined {
  if (goal.costCapUsd === undefined) return undefined;
  return `plafon ${formatCost(goal.costCapUsd)}`;
}

export interface GoalOptionsInput {
  maxTurns?: string;
  costCapUsd?: string;
}

export type GoalOptionsResult =
  | { ok: true; maxTurns?: number; costCapUsd?: number }
  | { ok: false; error: string };

/**
 * Validasi batas yang diisi pengguna di konfirmasi Goal. String kosong berarti
 * field tidak diisi (bawaan server dipakai). Galat dalam Bahasa Indonesia.
 */
export function validateGoalOptions(input: GoalOptionsInput): GoalOptionsResult {
  const result: { ok: true; maxTurns?: number; costCapUsd?: number } = { ok: true };

  const rawTurns = (input.maxTurns ?? "").trim();
  if (rawTurns !== "") {
    const value = Number(rawTurns);
    if (!Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_TURNS) {
      return {
        ok: false,
        error: `Maks. giliran otomatis harus bilangan bulat 1-${HARD_MAX_TURNS}.`,
      };
    }
    result.maxTurns = value;
  }

  const rawCost = (input.costCapUsd ?? "").trim();
  if (rawCost !== "") {
    const value = Number(rawCost);
    if (!Number.isFinite(value) || value <= 0 || value > MAX_COST_CAP_USD) {
      return {
        ok: false,
        error: `Plafon biaya harus lebih dari 0 dan maksimal ${MAX_COST_CAP_USD}.`,
      };
    }
    result.costCapUsd = value;
  }

  return result;
}
