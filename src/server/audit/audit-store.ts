import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { jejakHome } from "../provider-store";
import { redactSecrets } from "../security/redact";

export const AUDIT_KINDS = [
  "sesi-mulai",
  "sesi-berhenti",
  "tool",
  "izin",
  "berkas",
  "git",
  "rahasia-disamarkan",
  "rahasia-diblokir",
  "mcp",
  "pengaturan",
  "anggaran",
  "provider",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export type AuditMeta = Record<string, string | number | boolean | null>;

export interface AuditEntryInput {
  kind: AuditKind;
  sessionId?: string;
  summary: string;
  meta?: AuditMeta;
  ts?: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  sessionId: string | null;
  kind: AuditKind;
  summary: string;
  meta: AuditMeta;
}

export interface AuditQuery {
  session?: string;
  kind?: AuditKind;
  before?: number;
  limit?: number;
}

export interface AuditSummary {
  days: number;
  since: string;
  total: number;
  byKind: Record<string, number>;
  redactedSessions: number;
}

export interface AuditStore {
  append(input: AuditEntryInput): void;
  list(query?: AuditQuery): AuditEntry[];
  summary(now?: Date): AuditSummary;
  prune(now?: Date): number;
  close(): void;
}

export const AUDIT_SCHEMA_VERSION = 1;
export const AUDIT_SUMMARY_DAYS = 7;
export const DEFAULT_AUDIT_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_MAX = 500;
const META_VALUE_MAX = 200;
const META_JSON_MAX = 2000;
const META_KEYS_MAX = 20;
const META_KEY_PATTERN = /^[a-z][A-Za-z0-9_]{0,31}$/;
const PLACEHOLDER_PREFIX = "[disembunyikan:";
const TRUNCATED_META = JSON.stringify({ dipotong: true });

interface AuditRow {
  id: number;
  ts: string;
  session_id: string | null;
  kind: string;
  summary: string;
  meta: string;
}

interface MetaRow {
  key: string;
  value: string;
}

/** Potong tanpa meninggalkan penanda `[disembunyikan:...]` yang terbuka. */
function truncateRedacted(text: string, max: number): string {
  if (text.length <= max) return text;
  const out = text.slice(0, max);
  const open = out.lastIndexOf(PLACEHOLDER_PREFIX);
  if (open >= 0 && out.indexOf("]", open) === -1) {
    return out.slice(0, open);
  }
  // Potongan bisa jatuh di tengah prefiks penanda.
  const bracket = out.lastIndexOf("[");
  if (bracket >= 0) {
    const tail = out.slice(bracket);
    if (
      tail.length >= 2 &&
      !tail.includes("]") &&
      PLACEHOLDER_PREFIX.startsWith(tail)
    ) {
      return out.slice(0, bracket);
    }
  }
  return out;
}

function sanitizeMeta(meta: AuditMeta | undefined): AuditMeta {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return {};
  }
  const output: AuditMeta = {};
  let count = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (count >= META_KEYS_MAX) break;
    if (!META_KEY_PATTERN.test(key)) continue;
    if (typeof value === "string") {
      output[key] = truncateRedacted(redactSecrets(value).text, META_VALUE_MAX);
      count += 1;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      output[key] = value;
      count += 1;
      continue;
    }
    if (typeof value === "boolean" || value === null) {
      output[key] = value;
      count += 1;
    }
  }
  return output;
}

function parseMeta(text: string): AuditMeta {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as AuditMeta;
  } catch {
    return {};
  }
}

function isAuditKind(value: unknown): value is AuditKind {
  return typeof value === "string" && (AUDIT_KINDS as readonly string[]).includes(value);
}

function parseDayCount(value: string | undefined): number {
  if (value === undefined) return DEFAULT_AUDIT_DAYS;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_AUDIT_DAYS;
  const days = Number(trimmed);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    return DEFAULT_AUDIT_DAYS;
  }
  return days;
}

export function auditPath(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "audit.db");
}

export function defaultAuditStore(
  env: Record<string, string | undefined> = process.env,
): AuditStore | undefined {
  if (env.JEJAK_AUDIT?.trim() === "0" || env.JEJAK_PERSIST?.trim() === "0") {
    return undefined;
  }
  return new SqliteAuditStore(auditPath(env), {
    retentionDays: parseDayCount(env.JEJAK_AUDIT_DAYS),
  });
}

export class SqliteAuditStore implements AuditStore {
  private readonly db: Database;
  private readonly retentionDays: number;
  private readonly stmtInsert: Statement;
  private readonly stmtSelectMeta: Statement;
  private readonly stmtWriteMeta: Statement;
  private readonly stmtDeleteOld: Statement;
  private lastPruneMs = 0;
  private closed = false;

  constructor(path: string, options: { retentionDays?: number } = {}) {
    const requested = options.retentionDays;
    this.retentionDays =
      typeof requested === "number" && Number.isFinite(requested) && requested >= 1
        ? Math.floor(requested)
        : DEFAULT_AUDIT_DAYS;

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

    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }

    this.stmtInsert = this.db.prepare(
      "INSERT INTO audit (ts, session_id, kind, summary, meta) VALUES (?, ?, ?, ?, ?)",
    );
    this.stmtSelectMeta = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    this.stmtWriteMeta = this.db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.stmtDeleteOld = this.db.prepare("DELETE FROM audit WHERE ts < ?");

    if (!inMemory) {
      this.restrictPermissions(path);
    }

    this.lastPruneMs = this.readLastPruneMs();
    this.prune();
    this.restrictPermissions(path);
  }

  private migrate(): void {
    this.db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL,
         session_id TEXT,
         kind TEXT NOT NULL,
         summary TEXT NOT NULL,
         meta TEXT NOT NULL DEFAULT '{}'
       )`,
    );
    this.db.run("CREATE INDEX IF NOT EXISTS audit_session_id ON audit (session_id, id)");
    this.db.run("CREATE INDEX IF NOT EXISTS audit_kind_id ON audit (kind, id)");

    const row = this.db
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as MetaRow | null;
    if (row === null) {
      this.db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [
        String(AUDIT_SCHEMA_VERSION),
      ]);
      return;
    }

    const version = Number(row.value);
    if (!Number.isSafeInteger(version)) {
      throw new Error(`Versi skema log audit tidak valid: "${row.value}".`);
    }
    if (version > AUDIT_SCHEMA_VERSION) {
      throw new Error(
        `Versi skema log audit ${version} lebih baru dari versi ${AUDIT_SCHEMA_VERSION} yang dikenal.`,
      );
    }
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

  private readLastPruneMs(): number {
    try {
      const row = this.stmtSelectMeta.get("last_prune") as MetaRow | null;
      if (row === null) return 0;
      const parsed = Date.parse(row.value);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  private maybePrune(): void {
    if (Date.now() - this.lastPruneMs <= DAY_MS) return;
    try {
      this.prune();
    } catch {
      // Pemangkasan malas tidak boleh menggagalkan pembacaan/penulisan.
    }
  }

  append(input: AuditEntryInput): void {
    try {
      if (this.closed) return;
      const record = input as Partial<AuditEntryInput> | null | undefined;
      if (typeof record !== "object" || record === null) return;
      if (!isAuditKind(record.kind)) return;
      if (typeof record.summary !== "string") return;

      const ts =
        typeof record.ts === "string" && record.ts !== ""
          ? record.ts
          : new Date().toISOString();
      const sessionId =
        typeof record.sessionId === "string" && record.sessionId !== ""
          ? record.sessionId
          : null;
      const summary = truncateRedacted(redactSecrets(record.summary).text, SUMMARY_MAX);

      let metaJson = JSON.stringify(
        sanitizeMeta(record.meta as AuditMeta | undefined),
      );
      if (metaJson.length > META_JSON_MAX) {
        metaJson = TRUNCATED_META;
      }

      this.maybePrune();
      this.stmtInsert.run(ts, sessionId, record.kind, summary, metaJson);
    } catch {
      // Audit tidak boleh merusak sesi.
    }
  }

  list(query: AuditQuery = {}): AuditEntry[] {
    this.maybePrune();

    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (typeof query.session === "string") {
      conditions.push("session_id = ?");
      params.push(query.session);
    }
    if (isAuditKind(query.kind)) {
      conditions.push("kind = ?");
      params.push(query.kind);
    }
    if (Number.isSafeInteger(query.before) && (query.before ?? 0) > 0) {
      conditions.push("id < ?");
      params.push(query.before!);
    }

    let limit = 50;
    if (Number.isSafeInteger(query.limit)) {
      limit = Math.min(200, Math.max(1, query.limit!));
    }

    const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
    const rows = this.db
      .query(`SELECT id, ts, session_id, kind, summary, meta FROM audit${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as AuditRow[];

    return rows.map((row) => ({
      id: Number(row.id),
      ts: row.ts,
      sessionId: row.session_id,
      kind: isAuditKind(row.kind) ? row.kind : "pengaturan",
      summary: row.summary,
      meta: parseMeta(row.meta),
    }));
  }

  summary(now: Date = new Date()): AuditSummary {
    const since = new Date(now.getTime() - AUDIT_SUMMARY_DAYS * DAY_MS).toISOString();
    const rows = this.db
      .query("SELECT kind, COUNT(*) AS jumlah FROM audit WHERE ts >= ? GROUP BY kind")
      .all(since) as Array<{ kind: string; jumlah: number }>;

    const byKind: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.jumlah);
      byKind[row.kind] = count;
      total += count;
    }

    const redacted = this.db
      .query(
        "SELECT COUNT(DISTINCT session_id) AS jumlah FROM audit WHERE ts >= ? AND kind = 'rahasia-disamarkan' AND session_id IS NOT NULL",
      )
      .get(since) as { jumlah: number } | null;

    return {
      days: AUDIT_SUMMARY_DAYS,
      since,
      total,
      byKind,
      redactedSessions: Number(redacted?.jumlah ?? 0),
    };
  }

  prune(now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - this.retentionDays * DAY_MS).toISOString();
    const result = this.stmtDeleteOld.run(cutoff);
    this.stmtWriteMeta.run("last_prune", now.toISOString());
    this.lastPruneMs = now.getTime();
    return Number(result.changes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
