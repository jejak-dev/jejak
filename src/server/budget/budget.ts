export interface BudgetConfig {
  sessionUsd?: number;
  dailyUsd?: number;
  warnAt: number;
}

export type BudgetLevel = "ok" | "warn" | "over";

export const DEFAULT_WARN_AT = 0.8;
export const MIN_WARN_AT = 0.5;
export const MAX_WARN_AT = 0.95;
export const MAX_LIMIT_USD = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tingkat pemakaian; `undefined` bila tidak ada batas. */
export function levelFor(
  spent: number,
  limit: number | undefined,
  warnAt: number,
): BudgetLevel | undefined {
  if (limit === undefined) return undefined;
  if (spent >= limit) return "over";
  if (spent >= limit * warnAt) return "warn";
  return "ok";
}

export function evaluateBudget(input: {
  config: BudgetConfig;
  sessionUsd: number;
  dayUsd: number;
}): { session?: BudgetLevel; day?: BudgetLevel } {
  const result: { session?: BudgetLevel; day?: BudgetLevel } = {};
  const session = levelFor(input.sessionUsd, input.config.sessionUsd, input.config.warnAt);
  if (session !== undefined) result.session = session;
  const day = levelFor(input.dayUsd, input.config.dailyUsd, input.config.warnAt);
  if (day !== undefined) result.day = day;
  return result;
}

/** Awal hari lokal server sebagai ISO UTC. */
export function localDayStartIso(now: Date): string {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  ).toISOString();
}

function parseLimit(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0 || value > MAX_LIMIT_USD) return null;
  return value;
}

function parseWarnAt(value: unknown): number | null {
  if (value === undefined) return DEFAULT_WARN_AT;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < MIN_WARN_AT || value > MAX_WARN_AT) return null;
  return value;
}

const CONFIG_KEYS = new Set(["sessionUsd", "dailyUsd", "warnAt"]);

/** Validasi ketat; field tak dikenal ditolak. `null` pada batas berarti dihapus. */
export function parseBudgetConfig(raw: unknown): { config?: BudgetConfig; error?: string } {
  if (!isRecord(raw)) {
    return { error: "Pengaturan anggaran harus berupa objek." };
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      return { error: `Field "${key}" tidak dikenal.` };
    }
  }

  const sessionUsd = parseLimit(raw.sessionUsd);
  if (sessionUsd === null) {
    return { error: "sessionUsd harus angka lebih dari 0 dan paling banyak 100000." };
  }
  const dailyUsd = parseLimit(raw.dailyUsd);
  if (dailyUsd === null) {
    return { error: "dailyUsd harus angka lebih dari 0 dan paling banyak 100000." };
  }
  const warnAt = parseWarnAt(raw.warnAt);
  if (warnAt === null) {
    return { error: "warnAt harus angka antara 0.5 dan 0.95." };
  }

  const config: BudgetConfig = { warnAt };
  if (sessionUsd !== undefined) config.sessionUsd = sessionUsd;
  if (dailyUsd !== undefined) config.dailyUsd = dailyUsd;
  return { config };
}

function envNumber(
  env: Record<string, string | undefined>,
  key: string,
  validate: (value: number) => boolean,
): number | undefined {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !validate(value)) return undefined;
  return value;
}

export function budgetFromEnv(
  env: Record<string, string | undefined> = process.env,
): BudgetConfig {
  const config: BudgetConfig = {
    warnAt:
      envNumber(env, "JEJAK_BUDGET_WARN", (value) => value >= MIN_WARN_AT && value <= MAX_WARN_AT) ??
      DEFAULT_WARN_AT,
  };
  const sessionUsd = envNumber(
    env,
    "JEJAK_BUDGET_SESSION_USD",
    (value) => value > 0 && value <= MAX_LIMIT_USD,
  );
  if (sessionUsd !== undefined) config.sessionUsd = sessionUsd;
  const dailyUsd = envNumber(
    env,
    "JEJAK_BUDGET_DAY_USD",
    (value) => value > 0 && value <= MAX_LIMIT_USD,
  );
  if (dailyUsd !== undefined) config.dailyUsd = dailyUsd;
  return config;
}

/** Format rupiah dolar dua desimal gaya Indonesia: `US$1,23`. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0.01) return "<US$0,01";
  return `US$${value.toFixed(2).replace(".", ",")}`;
}
