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

export interface UsageDayBucket {
  /** Hari lokal "YYYY-MM-DD". */
  day: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface UsageModelBucket {
  /** Nama model; "(tidak diketahui)" bila baris tidak menyebut model. */
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface UsageProfileBucket {
  profileId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export interface UsageSessionBucket {
  sessionId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  /** ISO terakhir giliran sesi itu dalam rentang. */
  lastTs: string;
}

export interface UsageSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  turns: number;
  /** Urut naik; hari tanpa data diisi nol sampai rentang penuh. */
  byDay: UsageDayBucket[];
  /** Urut biaya turun. */
  byModel: UsageModelBucket[];
  /** Urut biaya turun. */
  byProfile: UsageProfileBucket[];
  /** Sepuluh sesi teratas menurut biaya. */
  bySession: UsageSessionBucket[];
}

export interface UsageSummarizeOptions {
  /** Batas bawah rentang (ISO, inklusif). */
  sinceIso: string;
  /** Batas atas rentang (ISO, eksklusif). Bawaan: sekarang. */
  untilIso?: string;
  /**
   * Menit timurnya dari UTC (mis. +420 untuk UTC+7, -300 untuk UTC-5).
   * Sama dengan `Date.getTimezoneOffset()` dengan tanda dibalik; dipakai
   * untuk mengelompokkan baris ke hari lokal klien.
   */
  tzOffsetMinutes?: number;
}

export interface UsageLedger {
  record(entry: UsageEntry): void;
  sumSince(isoTs: string): number;
  sumForSession(id: string): number;
  /** Ringkasan pemakaian dalam rentang; hanya membaca. */
  summarize(options: UsageSummarizeOptions): UsageSummary;
  prune(days?: number): void;
  close(): void;
}

export const DEFAULT_USAGE_DAYS = 90;
/** Batas jumlah hari pada ringkasan (hari tanpa data tetap diisi nol). */
export const MAX_SUMMARY_DAYS = 366;
/** Label model bila baris pemakaian tidak menyebut model. */
export const UNKNOWN_MODEL = "(tidak diketahui)";

const DAY_MS = 24 * 60 * 60 * 1000;

interface UsageRow {
  total: number | null;
}

interface UsageAggRow {
  cost: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  turns: number | null;
}

interface UsageDayRow extends UsageAggRow {
  day: string | null;
}

interface UsageModelRow extends UsageAggRow {
  model: string | null;
}

interface UsageProfileRow extends UsageAggRow {
  profile_id: string | null;
}

interface UsageSessionRow extends UsageAggRow {
  session_id: string | null;
  last_ts: string | null;
}

interface UsageBucket {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bucketOf(row: UsageAggRow): UsageBucket {
  return {
    costUsd: num(row.cost),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    turns: num(row.turns),
  };
}

/** Modifier SQLite untuk menggeser waktu UTC sejauh menit tertentu. */
function tzModifier(tzOffsetMinutes: number): string {
  const sign = tzOffsetMinutes < 0 ? "-" : "+";
  return `${sign}${Math.abs(Math.trunc(tzOffsetMinutes))} minutes`;
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

/** Lama retensi pemakaian dalam hari (bawaan 90). */
export function usageRetentionDays(
  env: Record<string, string | undefined> = process.env,
): number {
  return parseDayCount(env.JEJAK_USAGE_DAYS);
}

export function defaultUsageLedger(
  env: Record<string, string | undefined> = process.env,
): UsageLedger | undefined {
  if (env.JEJAK_PERSIST?.trim() === "0" || env.JEJAK_BUDGET?.trim() === "0") {
    return undefined;
  }
  return new SqliteUsageLedger(usagePath(env), {
    retentionDays: usageRetentionDays(env),
  });
}

/**
 * Kunci hari lokal ("YYYY-MM-DD") dari satu momen ISO.
 * `tzOffsetMinutes` adalah menit timur dari UTC (mis. +420 untuk UTC+7),
 * sama dengan `Date.getTimezoneOffset()` dengan tanda dibalik.
 */
export function localDayKey(iso: string, tzOffsetMinutes: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Awal hari lokal (momen UTC) dari satu waktu, memakai zona klien. */
export function localDayStartIsoUtc(now: Date, tzOffsetMinutes: number): string {
  const shifted = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const start = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(start - tzOffsetMinutes * 60_000).toISOString();
}

/**
 * Awal rentang "N hari terakhir": tengah malam lokal hari ini mundur
 * N-1 hari, dinyatakan sebagai momen ISO UTC.
 */
export function usageRangeStartIso(
  now: Date,
  days: number,
  tzOffsetMinutes: number,
): string {
  const start = Date.parse(localDayStartIsoUtc(now, tzOffsetMinutes));
  const span = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 1;
  return new Date(start - (span - 1) * DAY_MS).toISOString();
}

/** Deret hari ("YYYY-MM-DD") dari `first` sampai `last`; maksimum `limit` hari. */
function dayRange(first: string, last: string, limit: number): string[] {
  const start = Date.parse(`${first}T00:00:00.000Z`);
  const end = Date.parse(`${last}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  let count = Math.round((end - start) / DAY_MS) + 1;
  let from = start;
  if (count > limit) {
    from = end - (limit - 1) * DAY_MS;
    count = limit;
  }
  const days: string[] = [];
  for (let index = 0; index < count; index += 1) {
    days.push(new Date(from + index * DAY_MS).toISOString().slice(0, 10));
  }
  return days;
}

/** Buku catatan pemakaian biaya; `:memory:` untuk tes. Tidak menyimpan isi pesan. */
export class SqliteUsageLedger implements UsageLedger {
  private readonly db: Database;
  private readonly retentionDays: number;
  private readonly stmtInsert: Statement;
  private readonly stmtSumSince: Statement;
  private readonly stmtSumSession: Statement;
  private readonly stmtDeleteOld: Statement;
  private readonly stmtTotal: Statement;
  private readonly stmtByDay: Statement;
  private readonly stmtByModel: Statement;
  private readonly stmtByProfile: Statement;
  private readonly stmtBySession: Statement;
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

    // Kueri ringkasan: agregasi di SQL, bukan memuat semua baris ke memori.
    this.stmtTotal = this.db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COUNT(*) AS turns
         FROM usage
        WHERE ts >= ? AND ts < ?`,
    );
    // `strftime` memakai modifier zona: geser waktu UTC lalu ambil tanggalnya.
    this.stmtByDay = this.db.prepare(
      `SELECT COALESCE(strftime('%Y-%m-%d', ts, ?), substr(ts, 1, 10)) AS day,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COUNT(*) AS turns
         FROM usage
        WHERE ts >= ? AND ts < ?
        GROUP BY day
        ORDER BY day ASC`,
    );
    this.stmtByModel = this.db.prepare(
      `SELECT COALESCE(model, '${UNKNOWN_MODEL}') AS model,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COUNT(*) AS turns
         FROM usage
        WHERE ts >= ? AND ts < ?
        GROUP BY model
        ORDER BY cost DESC, model ASC`,
    );
    this.stmtByProfile = this.db.prepare(
      `SELECT profile_id AS profile_id,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COUNT(*) AS turns
         FROM usage
        WHERE ts >= ? AND ts < ?
        GROUP BY profile_id
        ORDER BY cost DESC, profile_id ASC`,
    );
    this.stmtBySession = this.db.prepare(
      `SELECT session_id AS session_id,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COUNT(*) AS turns,
              MAX(ts) AS last_ts
         FROM usage
        WHERE ts >= ? AND ts < ?
        GROUP BY session_id
        ORDER BY cost DESC, session_id ASC
        LIMIT 10`,
    );

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

  summarize(options: UsageSummarizeOptions): UsageSummary {
    const summary: UsageSummary = {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      turns: 0,
      byDay: [],
      byModel: [],
      byProfile: [],
      bySession: [],
    };
    try {
      if (this.closed) return summary;
      const sinceIso = options.sinceIso;
      if (typeof sinceIso !== "string" || sinceIso === "") return summary;
      const untilIso =
        typeof options.untilIso === "string" && options.untilIso !== ""
          ? options.untilIso
          : new Date().toISOString();
      const tz = num(options.tzOffsetMinutes);
      const modifier = tzModifier(tz);

      const total = this.stmtTotal.get(sinceIso, untilIso) as UsageAggRow | null;
      const totals = bucketOf(total ?? { cost: null, input_tokens: null, output_tokens: null, turns: null });
      summary.totalCostUsd = totals.costUsd;
      summary.totalInputTokens = totals.inputTokens;
      summary.totalOutputTokens = totals.outputTokens;
      summary.turns = totals.turns;

      // Per hari: hari tanpa data diisi nol sampai rentang penuh.
      const dayRows = this.stmtByDay.all(modifier, sinceIso, untilIso) as UsageDayRow[];
      const perDay = new Map<string, UsageBucket>();
      for (const row of dayRows) {
        const key = row.day ?? "";
        if (key === "") continue;
        perDay.set(key, bucketOf(row));
      }
      const firstDay = localDayKey(sinceIso, tz);
      // Batas atas eksklusif: hari terakhir adalah hari yang memuat
      // `untilIso` dikurangi sedetik.
      const untilMs = Date.parse(untilIso);
      const lastDay = localDayKey(
        new Date((Number.isFinite(untilMs) ? untilMs : Date.now()) - 1000).toISOString(),
        tz,
      );
      for (const day of dayRange(firstDay, lastDay, MAX_SUMMARY_DAYS)) {
        const bucket = perDay.get(day);
        summary.byDay.push({
          day,
          costUsd: bucket?.costUsd ?? 0,
          inputTokens: bucket?.inputTokens ?? 0,
          outputTokens: bucket?.outputTokens ?? 0,
          turns: bucket?.turns ?? 0,
        });
      }

      const modelRows = this.stmtByModel.all(sinceIso, untilIso) as UsageModelRow[];
      summary.byModel = modelRows.map((row) => ({
        model: row.model ?? UNKNOWN_MODEL,
        ...bucketOf(row),
      }));

      const profileRows = this.stmtByProfile.all(sinceIso, untilIso) as UsageProfileRow[];
      summary.byProfile = profileRows.map((row) => ({
        profileId: row.profile_id ?? "",
        ...bucketOf(row),
      }));

      const sessionRows = this.stmtBySession.all(sinceIso, untilIso) as UsageSessionRow[];
      summary.bySession = sessionRows.map((row) => ({
        sessionId: row.session_id ?? "",
        ...bucketOf(row),
        lastTs: row.last_ts ?? "",
      }));
      return summary;
    } catch {
      // Ringkasan tidak boleh menggagalkan pembacaan halaman.
      return summary;
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
