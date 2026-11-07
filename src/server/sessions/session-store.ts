import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import type { AgentEvent } from "../agent";
import { jejakHome } from "../provider-store";
import type { SequencedEvent, SessionInfo } from "./session-manager";

export interface StoredSession {
  info: SessionInfo;
  sdkSessionId?: string;
  nextSeq: number;
}

export interface SessionStore {
  loadSessions(): StoredSession[];
  loadEvents(id: string): SequencedEvent[];
  saveSession(info: SessionInfo, sdkSessionId: string | undefined): void;
  appendEvent(id: string, item: SequencedEvent): void;
  trimEvents(id: string, keepFromSeq: number): void;
  deleteSession(id: string): void;
  close(): void;
}

export const SESSIONS_SCHEMA_VERSION = 1;

interface SessionRow {
  id: string;
  created_at: string;
  data: string;
  sdk_session_id: string | null;
  next_seq: number;
}

interface EventRow {
  seq: number;
  data: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function sessionsPath(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "sessions.db");
}

export function defaultSessionStore(
  env: Record<string, string | undefined> = process.env,
): SessionStore | undefined {
  if (env.JEJAK_PERSIST?.trim() === "0") {
    return undefined;
  }
  return new SqliteSessionStore(sessionsPath(env));
}

export function readSchemaVersion(path: string): number | null {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const row = db
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | null;
    if (row === null) {
      return null;
    }
    const version = Number(row.value);
    return Number.isSafeInteger(version) ? version : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export class SqliteSessionStore implements SessionStore {
  private readonly db: Database;
  private readonly stmtLoadSessions: Statement;
  private readonly stmtLoadEvents: Statement;
  private readonly stmtSaveSession: Statement;
  private readonly stmtAppendEvent: Statement;
  private readonly stmtTrimEvents: Statement;
  private readonly stmtDeleteEvents: Statement;
  private readonly stmtDeleteSession: Statement;
  private readonly stmtSyncNextSeq: Statement;
  private readonly stmtBumpNextSeq: Statement;

  constructor(path: string) {
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
    this.db.run("PRAGMA foreign_keys = ON");

    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }

    this.stmtLoadSessions = this.db.prepare(
      "SELECT id, created_at, data, sdk_session_id, next_seq FROM sessions ORDER BY created_at ASC, id ASC",
    );
    this.stmtLoadEvents = this.db.prepare(
      "SELECT seq, data FROM events WHERE session_id = ? ORDER BY seq ASC",
    );
    this.stmtSaveSession = this.db.prepare(
      `INSERT INTO sessions (id, created_at, data, sdk_session_id, next_seq)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         created_at = excluded.created_at,
         data = excluded.data,
         sdk_session_id = excluded.sdk_session_id,
         next_seq = MAX(sessions.next_seq, excluded.next_seq)`,
    );
    this.stmtAppendEvent = this.db.prepare(
      `INSERT INTO events (session_id, seq, data) VALUES (?, ?, ?)
       ON CONFLICT(session_id, seq) DO UPDATE SET data = excluded.data`,
    );
    this.stmtTrimEvents = this.db.prepare("DELETE FROM events WHERE session_id = ? AND seq < ?");
    this.stmtDeleteEvents = this.db.prepare("DELETE FROM events WHERE session_id = ?");
    this.stmtDeleteSession = this.db.prepare("DELETE FROM sessions WHERE id = ?");
    this.stmtSyncNextSeq = this.db.prepare(
      `UPDATE sessions
       SET next_seq = MAX(next_seq, COALESCE((SELECT MAX(seq) + 1 FROM events WHERE session_id = ?), next_seq))
       WHERE id = ?`,
    );
    this.stmtBumpNextSeq = this.db.prepare(
      "UPDATE sessions SET next_seq = MAX(next_seq, ?) WHERE id = ?",
    );

    if (!inMemory) {
      this.restrictPermissions(path);
    }
  }

  private migrate(): void {
    this.db.run(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.db.run(
      `CREATE TABLE IF NOT EXISTS sessions (
         id TEXT PRIMARY KEY,
         created_at TEXT NOT NULL,
         data TEXT NOT NULL,
         sdk_session_id TEXT,
         next_seq INTEGER NOT NULL DEFAULT 1
       )`,
    );
    this.db.run(
      `CREATE TABLE IF NOT EXISTS events (
         session_id TEXT NOT NULL,
         seq INTEGER NOT NULL,
         data TEXT NOT NULL,
         PRIMARY KEY (session_id, seq),
         FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
       )`,
    );

    const row = this.db
      .query("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | null;
    if (row === null) {
      this.db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [
        String(SESSIONS_SCHEMA_VERSION),
      ]);
      return;
    }

    const version = Number(row.value);
    if (!Number.isSafeInteger(version)) {
      throw new Error(`Versi skema penyimpanan sesi tidak valid: "${row.value}".`);
    }
    if (version > SESSIONS_SCHEMA_VERSION) {
      throw new Error(
        `Versi skema penyimpanan sesi ${version} lebih baru dari versi ${SESSIONS_SCHEMA_VERSION} yang dikenal.`,
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

  loadSessions(): StoredSession[] {
    const rows = this.stmtLoadSessions.all() as SessionRow[];
    const sessions: StoredSession[] = [];
    for (const row of rows) {
      const data = parseJson(row.data);
      if (typeof data !== "object" || data === null) continue;
      const info = data as Partial<SessionInfo>;
      if (typeof info.id !== "string" || typeof info.status !== "string") continue;

      const nextSeq =
        Number.isSafeInteger(row.next_seq) && row.next_seq > 0 ? row.next_seq : 1;
      const stored: StoredSession = { info: data as SessionInfo, nextSeq };
      if (typeof row.sdk_session_id === "string") {
        stored.sdkSessionId = row.sdk_session_id;
      }
      sessions.push(stored);
    }
    return sessions;
  }

  loadEvents(id: string): SequencedEvent[] {
    const rows = this.stmtLoadEvents.all(id) as EventRow[];
    const events: SequencedEvent[] = [];
    for (const row of rows) {
      const data = parseJson(row.data);
      if (typeof data !== "object" || data === null) continue;
      events.push({ seq: Number(row.seq), event: data as AgentEvent });
    }
    return events;
  }

  saveSession(info: SessionInfo, sdkSessionId: string | undefined): void {
    this.stmtSaveSession.run(
      info.id,
      info.createdAt,
      JSON.stringify(info),
      sdkSessionId ?? null,
      info.eventCount + 1,
    );
    this.stmtSyncNextSeq.run(info.id, info.id);
  }

  appendEvent(id: string, item: SequencedEvent): void {
    this.stmtAppendEvent.run(id, item.seq, JSON.stringify(item.event));
    this.stmtBumpNextSeq.run(item.seq + 1, id);
  }

  trimEvents(id: string, keepFromSeq: number): void {
    this.stmtTrimEvents.run(id, keepFromSeq);
  }

  deleteSession(id: string): void {
    this.stmtDeleteEvents.run(id);
    this.stmtDeleteSession.run(id);
  }

  close(): void {
    this.db.close();
  }
}
