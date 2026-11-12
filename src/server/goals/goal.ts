/**
 * Mode Goal: satu tujuan per sesi, agent bekerja lintas giliran tanpa
 * supervision, dan berhenti sendiri saat batas-batas keras tersentuh.
 *
 * Modul ini murni: tidak menyentuh sesi, jaringan, atau penyimpanan.
 */

export type GoalStatus = "active" | "paused" | "achieved" | "blocked" | "stopped";

export type GoalEndReason =
  | "selesai"
  | "buntu"
  | "plafon-giliran"
  | "plafon-biaya"
  | "anggaran-sesi"
  | "tanpa-kemajuan"
  | "gagal"
  | "dihentikan";

/** Status yang dilaporkan agent lewat tool `goal_update`. */
export type GoalReportedStatus = "progress" | "done" | "blocked";

/** Bawaan giliran otomatis; tidak bisa dimatikan. */
export const DEFAULT_MAX_TURNS = 10;
/** Batas keras giliran otomatis. */
export const HARD_MAX_TURNS = 50;
/** Panjang maksimum tujuan (karakter). */
export const MAX_OBJECTIVE = 2000;
/** Panjang maksimum ringkasan dari agent. */
export const MAX_SUMMARY = 1000;
/** Dua giliran otomatis tanpa tool call = tanpa kemajuan. */
export const IDLE_TURN_LIMIT = 2;
/** Batas atas plafon biaya yang boleh diminta pengguna. */
export const MAX_COST_CAP_USD = 1000;

export interface Goal {
  /** Acak; dipakai untuk audit. */
  id: string;
  objective: string;
  status: GoalStatus;
  /** Giliran otomatis maksimum. */
  maxTurns: number;
  /** Plafon biaya sejak tujuan dimulai (USD). */
  costCapUsd?: number;
  /** Giliran otomatis yang sudah dimulai. */
  autoTurns: number;
  /** `sumForSession` saat tujuan dimulai; dasar hitung plafon biaya. */
  startCostUsd: number;
  /** Giliran otomatis beruntun tanpa tool call. */
  idleTurns: number;
  /** Ringkasan terakhir dari agent (tidak masuk audit). */
  summary?: string;
  endedReason?: GoalEndReason;
  /** Status terakhir yang dilaporkan agent. */
  reportedStatus?: GoalReportedStatus;
  startedAt: string;
  updatedAt: string;
}

/** Bentuk goal yang dikirim ke klien (tanpa field internal). */
export type GoalView = Omit<Goal, "startCostUsd">;

export interface GoalInput {
  objective: string;
  maxTurns?: number;
  costCapUsd?: number;
}

export interface GoalOutcome {
  /** Status giliran yang baru selesai. */
  turnStatus: "selesai" | "gagal" | "dibatalkan";
  /** Status yang dilaporkan agent pada giliran ini. */
  reportedStatus?: GoalReportedStatus;
  /** Jumlah tool call pada giliran ini. */
  toolCalls: number;
  /** Biaya sejak tujuan dimulai. */
  costSinceStartUsd: number;
  /** Tingkat anggaran sesi terakhir. */
  sessionBudget?: "ok" | "warn" | "over";
}

export type GoalDecision =
  | { action: "continue" }
  | { action: "end"; status: GoalStatus; reason: GoalEndReason; summary?: string };

/** Laporan agent untuk tool `goal_update`. */
export interface GoalReport {
  status: GoalReportedStatus;
  summary: string;
}

export interface GoalReportResult {
  ok: boolean;
  error?: string;
}

/** Penunjuk pelapor laporan goal; dipakai jembatan MCP dan tool memory. */
export type GoalReporter = (sessionId: string, report: GoalReport) => GoalReportResult;

/** Galat input tujuan; dipetakan rute ke 400. */
export class GoalInputError extends Error {
  readonly code = "tidak-valid" as const;

  constructor(message: string) {
    super(message);
    this.name = "GoalInputError";
  }
}

/**
 * Rentetan giliran otomatis tanpa tool call termasuk giliran ini.
 * `goal.idleTurns` adalah rentetan SEBELUM giliran berjalan.
 */
export function nextIdleTurns(goal: Goal, toolCalls: number): number {
  return toolCalls === 0 ? goal.idleTurns + 1 : 0;
}

/**
 * Keputusan setelah satu giliran selesai. Fungsi murni: `goal` tidak diubah.
 *
 * Urutan pemeriksaan mengikuti desain: batas keras diperiksa SEBELUM
 * memutuskan melanjutkan.
 */
export function decideNext(goal: Goal, outcome: GoalOutcome): GoalDecision {
  const summary = goal.summary;

  if (outcome.reportedStatus === "done") {
    return {
      action: "end",
      status: "achieved",
      reason: "selesai",
      ...(summary === undefined ? {} : { summary }),
    };
  }
  if (outcome.reportedStatus === "blocked") {
    return {
      action: "end",
      status: "blocked",
      reason: "buntu",
      ...(summary === undefined ? {} : { summary }),
    };
  }
  if (outcome.turnStatus === "gagal") {
    return { action: "end", status: "stopped", reason: "gagal" };
  }
  if (outcome.turnStatus === "dibatalkan") {
    return { action: "end", status: "stopped", reason: "dihentikan" };
  }
  if (goal.autoTurns >= goal.maxTurns) {
    return { action: "end", status: "paused", reason: "plafon-giliran" };
  }
  if (
    goal.costCapUsd !== undefined &&
    outcome.costSinceStartUsd >= goal.costCapUsd
  ) {
    return { action: "end", status: "paused", reason: "plafon-biaya" };
  }
  if (outcome.sessionBudget === "over") {
    return { action: "end", status: "paused", reason: "anggaran-sesi" };
  }
  if (nextIdleTurns(goal, outcome.toolCalls) >= IDLE_TURN_LIMIT) {
    return { action: "end", status: "paused", reason: "tanpa-kemajuan" };
  }
  return { action: "continue" };
}

/** Validasi input pengguna; galat dalam Bahasa Indonesia. */
export function parseGoalInput(body: unknown): GoalInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new GoalInputError("Body permintaan harus berupa objek.");
  }
  const record = body as Record<string, unknown>;

  const rawObjective = record.objective;
  if (typeof rawObjective !== "string") {
    throw new GoalInputError("Field objective harus berupa teks.");
  }
  const objective = rawObjective.trim();
  if (objective === "") {
    throw new GoalInputError("Tujuan tidak boleh kosong.");
  }
  if (objective.length > MAX_OBJECTIVE) {
    throw new GoalInputError(
      `Tujuan terlalu panjang; maksimal ${MAX_OBJECTIVE} karakter.`,
    );
  }

  let maxTurns = DEFAULT_MAX_TURNS;
  if (record.maxTurns !== undefined) {
    const raw = record.maxTurns;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
      throw new GoalInputError("Field maxTurns harus bilangan bulat.");
    }
    if (raw < 1 || raw > HARD_MAX_TURNS) {
      throw new GoalInputError(
        `Field maxTurns harus 1-${HARD_MAX_TURNS}.`,
      );
    }
    maxTurns = raw;
  }

  let costCapUsd: number | undefined;
  if (record.costCapUsd !== undefined) {
    const raw = record.costCapUsd;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new GoalInputError("Field costCapUsd harus berupa angka.");
    }
    if (raw <= 0 || raw > MAX_COST_CAP_USD) {
      throw new GoalInputError(
        `Field costCapUsd harus lebih dari 0 dan maksimal ${MAX_COST_CAP_USD}.`,
      );
    }
    costCapUsd = raw;
  }

  const input: GoalInput = { objective, maxTurns };
  if (costCapUsd !== undefined) input.costCapUsd = costCapUsd;
  return input;
}

/** Goal baru; `startCostUsd` adalah dasar hitung plafon biaya. */
export function createGoal(
  input: GoalInput,
  options: { id: string; startCostUsd: number; now: string },
): Goal {
  const goal: Goal = {
    id: options.id,
    objective: input.objective,
    status: "active",
    maxTurns: input.maxTurns ?? DEFAULT_MAX_TURNS,
    autoTurns: 0,
    startCostUsd: options.startCostUsd,
    idleTurns: 0,
    startedAt: options.now,
    updatedAt: options.now,
  };
  if (input.costCapUsd !== undefined) goal.costCapUsd = input.costCapUsd;
  return goal;
}

/** Bentuk yang dikirim ke klien: tujuan dipotong 200 karakter, tanpa field internal. */
export function goalView(goal: Omit<Goal, "startCostUsd">): GoalView {
  return {
    id: goal.id,
    objective: goal.objective.slice(0, 200),
    status: goal.status,
    maxTurns: goal.maxTurns,
    ...(goal.costCapUsd === undefined ? {} : { costCapUsd: goal.costCapUsd }),
    autoTurns: goal.autoTurns,
    idleTurns: goal.idleTurns,
    ...(goal.summary === undefined ? {} : { summary: goal.summary }),
    ...(goal.endedReason === undefined ? {} : { endedReason: goal.endedReason }),
    ...(goal.reportedStatus === undefined ? {} : { reportedStatus: goal.reportedStatus }),
    startedAt: goal.startedAt,
    updatedAt: goal.updatedAt,
  };
}

/**
 * Pulihkan goal dari baris sesi yang tersimpan. Data rusak diabaikan;
 * `startCostUsd` yang hilang dianggap nol.
 */
export function parseStoredGoal(raw: unknown): Goal | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const objective = record.objective;
  const status = record.status;
  if (typeof id !== "string" || typeof objective !== "string") return undefined;
  if (
    status !== "active" &&
    status !== "paused" &&
    status !== "achieved" &&
    status !== "blocked" &&
    status !== "stopped"
  ) {
    return undefined;
  }
  const maxTurns = record.maxTurns;
  const autoTurns = record.autoTurns;
  const idleTurns = record.idleTurns;
  const startCostUsd = record.startCostUsd;
  const startedAt = record.startedAt;
  const updatedAt = record.updatedAt;
  const goal: Goal = {
    id,
    objective,
    status,
    maxTurns:
      typeof maxTurns === "number" && Number.isSafeInteger(maxTurns) && maxTurns >= 1
        ? Math.min(maxTurns, HARD_MAX_TURNS)
        : DEFAULT_MAX_TURNS,
    autoTurns:
      typeof autoTurns === "number" && Number.isSafeInteger(autoTurns) && autoTurns >= 0
        ? autoTurns
        : 0,
    startCostUsd:
      typeof startCostUsd === "number" && Number.isFinite(startCostUsd) ? startCostUsd : 0,
    idleTurns:
      typeof idleTurns === "number" && Number.isSafeInteger(idleTurns) && idleTurns >= 0
        ? idleTurns
        : 0,
    startedAt: typeof startedAt === "string" ? startedAt : "",
    updatedAt: typeof updatedAt === "string" ? updatedAt : "",
  };
  const costCapUsd = record.costCapUsd;
  if (typeof costCapUsd === "number" && Number.isFinite(costCapUsd)) {
    goal.costCapUsd = costCapUsd;
  }
  const summary = record.summary;
  if (typeof summary === "string") goal.summary = summary;
  const endedReason = record.endedReason;
  if (typeof endedReason === "string") {
    goal.endedReason = endedReason as GoalEndReason;
  }
  const reportedStatus = record.reportedStatus;
  if (
    reportedStatus === "progress" ||
    reportedStatus === "done" ||
    reportedStatus === "blocked"
  ) {
    goal.reportedStatus = reportedStatus;
  }
  return goal;
}
