import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { jejakHome } from "../provider-store";

export interface UsageEntry {
  ts: string;
  sessionId: string;
  profileId: string;
  model?: string;
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface UsageLedger {
  record(entry: UsageEntry): void;
  sumSince(isoTs: string): number;
  sumForSession(id: string): number;
  prune(days?: number): void;
  close(): void;
}

export const DEFAULT_USAGE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

interface UsageRow {
  total: number | null;
}

function parseDayCount(value: string | undefined): number {
  if (value === undefined) return DEFAULT_USAGE_DAYS;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_USAGE_DAYS;
  const days = Number(trimmed);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    return DEFAULT_USAGE_DAYS;
  }
  return days;
}

export function usagePath(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "usage.db");
}

export function defaultUsageLedger(
  env: Record<string, string | undefined> = process.env,
): UsageLedger | undefined {
  if (env.JEJAK_PERSIST?.trim() === "0" || env.JEJAK_BUDGET?.trim() === "0") {
    return undefined;
  }
  return new SqliteUsageLedger(usagePath(env), {
    retentionDays: parseDayCount(env.JEJAK_USAGE_DAYS),
  });
}

/** Buku catatan pemakaian biaya; `:memory:` untuk tes. Tidak menyimpan isi pesan. */
export class SqliteUsageLedger implements UsageLedger {
  private readonly db: Database;
  private readonly retentionDays: number;
  private readonly stmtInsert: Statement;
  private readonly stmtSumSince: Statement;
  private readonly stmtSumSession: Statement;
  private readonly stmtDeleteOld: Statement;
  private closed = false;

  constructor(path: string, options: { retentionDays?: number } = {}) {
    const requested = options.retentionDays;
    this.retentionDays =
      typeof requested === "number" && Number.isFinite(requested) && requested >= 1
        ? Math.floor(requested)
        : DEFAULT_USAGE_DAYS;

    const inMemory = path === ":memory:" || path === "";
    if (!inMemory) {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        chmodSync(directory, 0o700);
      } catch {
        // Direktori induk mungkin milik sistem; berkas tetap dibatasi di bawah.
      }
    }

    this.db = new Database(inMemory ? ":memory:" : path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS usage (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL,
         session_id TEXT NOT NULL,
         profile_id TEXT NOT NULL,
         model TEXT,
         cost_usd REAL NOT NULL,
         input_tokens INTEGER,
         output_tokens INTEGER
       )`,
    );
    this.db.run("CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts)");
    this.db.run("CREATE INDEX IF NOT EXISTS usage_session ON usage (session_id)");

    this.stmtInsert = this.db.prepare(
      `INSERT INTO usage (ts, session_id, profile_id, model, cost_usd, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtSumSince = this.db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE ts >= ?",
    );
    this.stmtSumSession = this.db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE session_id = ?",
    );
    this.stmtDeleteOld = this.db.prepare("DELETE FROM usage WHERE ts < ?");

    if (!inMemory) {
      this.restrictPermissions(path);
    }
    this.prune();
    this.restrictPermissions(path);
  }

  private restrictPermissions(path: string): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${path}${suffix}`;
      if (!existsSync(target)) continue;
      try {
        chmodSync(target, 0o600);
      } catch {
        // Berkas sementara bisa hilang/berpindah; abaikan.
      }
    }
  }

  record(entry: UsageEntry): void {
    try {
      if (this.closed) return;
      const record = entry as Partial<UsageEntry> | null | undefined;
      if (typeof record !== "object" || record === null) return;
      if (typeof record.ts !== "string" || record.ts === "") return;
      if (typeof record.sessionId !== "string" || record.sessionId === "") return;
      if (typeof record.profileId !== "string" || record.profileId === "") return;
      if (
        typeof record.costUsd !== "number" ||
        !Number.isFinite(record.costUsd) ||
        record.costUsd < 0
      ) {
        return;
      }
      const model = typeof record.model === "string" ? record.model : null;
      const inputTokens =
        typeof record.inputTokens === "number" && Number.isFinite(record.inputTokens)
          ? Math.floor(record.inputTokens)
          : null;
      const outputTokens =
        typeof record.outputTokens === "number" && Number.isFinite(record.outputTokens)
          ? Math.floor(record.outputTokens)
          : null;
      this.stmtInsert.run(
        record.ts,
        record.sessionId,
        record.profileId,
        model,
        record.costUsd,
        inputTokens,
        outputTokens,
      );
    } catch {
      // Pencatatan pemakaian tidak boleh menggagalkan sesi.
    }
  }

  sumSince(isoTs: string): number {
    try {
      if (this.closed) return 0;
      const row = this.stmtSumSince.get(isoTs) as UsageRow | null;
      return Number(row?.total ?? 0);
    } catch {
      return 0;
    }
  }

  sumForSession(id: string): number {
    try {
      if (this.closed) return 0;
      const row = this.stmtSumSession.get(id) as UsageRow | null;
      return Number(row?.total ?? 0);
    } catch {
      return 0;
    }
  }

  prune(days: number = this.retentionDays): void {
    try {
      if (this.closed) return;
      const effective =
        Number.isFinite(days) && days >= 1 ? Math.floor(days) : this.retentionDays;
      const cutoff = new Date(Date.now() - effective * DAY_MS).toISOString();
      this.stmtDeleteOld.run(cutoff);
    } catch {
      // Pemangkasan tidak boleh menggagalkan pembukaan/pembacaan.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
