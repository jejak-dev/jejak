import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { jejakHome } from "../provider-store";
import {
  budgetFromEnv,
  parseBudgetConfig,
  type BudgetConfig,
} from "./budget";

export interface BudgetStore {
  get(): BudgetConfig;
  set(config: BudgetConfig): void;
}

export const BUDGET_VERSION = 1;

export function budgetPath(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "budget.json");
}

export function defaultBudgetStore(
  env: Record<string, string | undefined> = process.env,
): BudgetStore | undefined {
  if (env.JEJAK_BUDGET?.trim() === "0") return undefined;
  const defaults = budgetFromEnv(env);
  if (env.JEJAK_PERSIST?.trim() === "0") {
    // Anggaran tetap berjalan di memori walau persistensi dimatikan.
    return new FileBudgetStore(":memory:", defaults);
  }
  return new FileBudgetStore(budgetPath(env), defaults);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyConfig(config: BudgetConfig): BudgetConfig {
  const copy: BudgetConfig = { warnAt: config.warnAt };
  if (config.sessionUsd !== undefined) copy.sessionUsd = config.sessionUsd;
  if (config.dailyUsd !== undefined) copy.dailyUsd = config.dailyUsd;
  return copy;
}

/** Penyimpanan berkas JSON atomik; `:memory:` untuk tes tanpa berkas. */
export class FileBudgetStore implements BudgetStore {
  private readonly path: string;
  private readonly inMemory: boolean;
  private readonly defaults: BudgetConfig;
  private config: BudgetConfig | undefined;
  private loaded = false;

  constructor(path: string, defaults: BudgetConfig = budgetFromEnv()) {
    this.path = path;
    this.inMemory = path === ":memory:" || path === "";
    this.defaults = copyConfig(defaults);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.config = copyConfig(this.defaults);
    if (this.inMemory) return;

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      // Berkas rusak atau versi tak dikenal diperlakukan default; tidak ditimpa
      // sampai ada `set` pertama.
      if (!isRecord(parsed) || parsed.version !== BUDGET_VERSION) return;
      const candidate: Record<string, unknown> = {};
      if ("sessionUsd" in parsed) candidate.sessionUsd = parsed.sessionUsd;
      if ("dailyUsd" in parsed) candidate.dailyUsd = parsed.dailyUsd;
      if ("warnAt" in parsed) candidate.warnAt = parsed.warnAt;
      const result = parseBudgetConfig(candidate);
      if (result.config === undefined) return;
      this.config = result.config;
    } catch {
      // JSON rusak: pakai default env.
    }
  }

  get(): BudgetConfig {
    this.load();
    return copyConfig(this.config ?? this.defaults);
  }

  set(config: BudgetConfig): void {
    this.load();
    const next = copyConfig(config);
    this.config = next;
    if (this.inMemory) return;

    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Direktori induk bisa milik sistem; berkas tetap 0600 di bawah.
    }

    const body: Record<string, unknown> = { version: BUDGET_VERSION };
    if (next.sessionUsd !== undefined) body.sessionUsd = next.sessionUsd;
    if (next.dailyUsd !== undefined) body.dailyUsd = next.dailyUsd;
    body.warnAt = next.warnAt;

    const tempPath = `${this.path}.${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, this.path);
      chmodSync(this.path, 0o600);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Berkas sementara mungkin sudah hilang; galat asli yang dilempar.
      }
      throw error;
    }
  }
}

/** `true` bila berkas anggaran ada (dipakai tes/diagnostik). */
export function budgetFileExists(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return existsSync(budgetPath(env));
}
