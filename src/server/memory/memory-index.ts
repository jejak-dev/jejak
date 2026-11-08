import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import {
  readMemoryFile,
  scanMemoryFiles,
  type Memory,
  type MemoryConfidence,
  type MemoryLayer,
  type MemoryOrigin,
  type MemoryStatus,
} from "./memory-files";

export const MEMORY_SCHEMA_VERSION = 1;

export interface MemoryProblem {
  file: string;
  reason: string;
}

export type MemoryMatch = "all" | "any";

export interface MemoryListQuery {
  status?: MemoryStatus;
  layer?: MemoryLayer;
  project?: string;
  q?: string;
  /** `all` = AND antar token (bawaan); `any` = OR, diurutkan bm25. */
  match?: MemoryMatch;
  limit?: number;
  /** Bila true, `q` kosong berarti tanpa filter (bawaan). */
}

export interface MemoryCounts {
  proposed: number;
  active: number;
}

interface MemoryRow {
  id: string;
  path: string;
  layer: string;
  project_key: string | null;
  title: string;
  body: string;
  status: string;
  confidence: string;
  origin: string;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

function rowToMemory(row: MemoryRow): Memory {
  let origin: MemoryOrigin;
  try {
    origin = JSON.parse(row.origin) as MemoryOrigin;
  } catch {
    origin = { kind: "manual", at: row.created_at };
  }
  return {
    id: row.id,
    layer: row.layer as MemoryLayer,
    projectKey: row.project_key,
    title: row.title,
    body: row.body,
    status: row.status as MemoryStatus,
    confidence: row.confidence as MemoryConfidence,
    origin,
    staleReason: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

/**
 * Stopword dan token 1 karakter yang dibuang hanya pada mode `any` supaya
 * kueri alami model tidak menambah noise. Bila semuanya terbuang, token asli dipakai.
 */
const ANY_MODE_STOPWORDS = new Set([
  "yang",
  "dan",
  "di",
  "ke",
  "dari",
  "ini",
  "itu",
  "untuk",
  "the",
  "a",
  "an",
  "of",
  "to",
  "is",
]);

function ftsTokens(input: string): string[] {
  const tokens: string[] = [];
  for (const token of input.split(/\s+/)) {
    const cleaned = token.replace(/["]/g, "");
    if (cleaned === "") continue;
    tokens.push(cleaned);
  }
  return tokens;
}

/**
 * Mengubah input pengguna menjadi kueri FTS5 yang aman: setiap token dibungkus
 * tanda kutip ganda, kutip ganda di dalam token dibuang, token kosong dilewati.
 * Token yang hanya berisi kutip ganda dibuang supaya `MATCH ""` tidak melempar.
 * Kueri kosong berarti tanpa filter.
 */
export function toFtsQuery(input: string): string {
  return ftsTokens(input)
    .map((token) => `"${token}"`)
    .join(" ");
}

/**
 * Kueri FTS5 mode `any` (OR antar token), tetap dengan token yang dibungkus dan
 * disanitasi. Stopword dan token 1 karakter dibuang bila masih ada token lain.
 */
export function toFtsAnyQuery(input: string): string {
  const tokens = ftsTokens(input);
  const filtered = tokens.filter(
    (token) => token.length > 1 && !ANY_MODE_STOPWORDS.has(token.toLowerCase()),
  );
  const chosen = filtered.length > 0 ? filtered : tokens;
  return chosen.map((token) => `"${token}"`).join(" OR ");
}

export class MemoryIndex {
  private readonly db: Database;
  private readonly stmtUpsert: Statement;
  private readonly stmtDeleteById: Statement;
  private readonly stmtDeleteByPath: Statement;
  private readonly stmtRowId: Statement;
  private readonly stmtFtsDelete: Statement;
  private readonly stmtFtsInsert: Statement;
  private readonly stmtFileGet: Statement;
  private readonly stmtFileUpsert: Statement;
  private readonly stmtDeleteFile: Statement;

  constructor(path = ":memory:") {
    const inMemory = path === ":memory:" || path === "";
    this.db = MemoryIndex.open(inMemory ? ":memory:" : path, inMemory);

    this.stmtUpsert = this.db.prepare(
      `INSERT INTO memories (id, path, layer, project_key, title, body, status, confidence, origin, created_at, updated_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         path = excluded.path,
         layer = excluded.layer,
         project_key = excluded.project_key,
         title = excluded.title,
         body = excluded.body,
         status = excluded.status,
         confidence = excluded.confidence,
         origin = excluded.origin,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         decided_at = excluded.decided_at`,
    );
    this.stmtDeleteById = this.db.prepare("DELETE FROM memories WHERE id = ?");
    this.stmtDeleteByPath = this.db.prepare("DELETE FROM memories WHERE path = ?");
    this.stmtRowId = this.db.prepare("SELECT rowid, id FROM memories WHERE path = ?");
    this.stmtFtsDelete = this.db.prepare("DELETE FROM memories_fts WHERE rowid = ?");
    this.stmtFtsInsert = this.db.prepare(
      "INSERT INTO memories_fts (rowid, title, body) VALUES (?, ?, ?)",
    );
    this.stmtFileGet = this.db.prepare(
      "SELECT mtime_ms, size, sha256 FROM files WHERE path = ?",
    );
    this.stmtFileUpsert = this.db.prepare(
      `INSERT INTO files (path, mtime_ms, size, sha256) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, sha256 = excluded.sha256`,
    );
    this.stmtDeleteFile = this.db.prepare("DELETE FROM files WHERE path = ?");
  }

  private static open(path: string, inMemory: boolean): Database {
    if (inMemory) {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      MemoryIndex.migrate(db);
      return db;
    }

    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Direktori induk mungkin milik sistem; berkas tetap dibatasi di bawah.
    }

    const attempt = (): Database => {
      const db = new Database(path);
      try {
        MemoryIndex.migrate(db);
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    };

    let db: Database;
    try {
      db = attempt();
    } catch {
      // Indeks turunan; berkas rusak atau versi tak cocok dibuang lalu dibangun ulang.
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          unlinkSync(`${path}${suffix}`);
        } catch {
          // Berkas mungkin tidak ada; abaikan.
        }
      }
      db = attempt();
    }

    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${path}${suffix}`;
      if (!existsSync(target)) continue;
      try {
        chmodSync(target, 0o600);
      } catch {
        // Berkas sementara bisa hilang/berpindah; abaikan.
      }
    }
    return db;
  }

  private static migrate(db: Database): void {
    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run(
      `CREATE TABLE IF NOT EXISTS memories (
         id TEXT PRIMARY KEY,
         path TEXT NOT NULL UNIQUE,
         layer TEXT NOT NULL,
         project_key TEXT,
         title TEXT NOT NULL,
         body TEXT NOT NULL,
         status TEXT NOT NULL,
         confidence TEXT NOT NULL,
         origin TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         decided_at TEXT
       )`,
    );
    db.run("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, body)");
    db.run(
      `CREATE TABLE IF NOT EXISTS files (
         path TEXT PRIMARY KEY,
         mtime_ms REAL NOT NULL,
         size INTEGER NOT NULL,
         sha256 TEXT NOT NULL
       )`,
    );

    const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | null;
    if (row === null) {
      db.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [
        String(MEMORY_SCHEMA_VERSION),
      ]);
      return;
    }
    const version = Number(row.value);
    if (!Number.isSafeInteger(version) || version !== MEMORY_SCHEMA_VERSION) {
      throw new Error(`Versi skema indeks memory tidak cocok: "${row.value}".`);
    }
  }

  /** Menghapus seluruh isi indeks (untuk membangun ulang dari berkas). */
  reset(): void {
    this.db.run("DELETE FROM memories_fts");
    this.db.run("DELETE FROM memories");
    this.db.run("DELETE FROM files");
  }

  private upsertMemory(memory: Memory, relPath: string): void {
    const existing = this.stmtRowId.get(relPath) as { rowid: number; id: string } | null;
    if (existing !== null && existing.id !== memory.id) {
      this.stmtFtsDelete.run(existing.rowid);
      this.stmtDeleteById.run(existing.id);
    }

    this.stmtUpsert.run(
      memory.id,
      relPath,
      memory.layer,
      memory.projectKey,
      memory.title,
      memory.body,
      memory.status,
      memory.confidence,
      JSON.stringify(memory.origin),
      memory.createdAt,
      memory.updatedAt,
      memory.decidedAt,
    );

    const row = this.stmtRowId.get(relPath) as { rowid: number } | null;
    if (row === null) return;
    this.stmtFtsDelete.run(row.rowid);
    this.stmtFtsInsert.run(row.rowid, memory.title, memory.body);
  }

  private removePath(relPath: string): void {
    const row = this.stmtRowId.get(relPath) as { rowid: number } | null;
    if (row !== null) {
      this.stmtFtsDelete.run(row.rowid);
    }
    this.stmtDeleteByPath.run(relPath);
  }

  /** Memasukkan satu memory ke indeks tanpa memindai folder (dipakai store setelah menulis berkas). */
  upsertFromFile(
    memory: Memory,
    relPath: string,
    sha256: string,
    mtimeMs: number,
    size: number,
  ): void {
    this.upsertMemory(memory, relPath);
    this.stmtFileUpsert.run(relPath, mtimeMs, size, sha256);
  }

  /**
   * Memindai folder memory dan menyelaraskan indeks: berkas baru/berubah diurai
   * ulang, berkas hilang dibuang, berkas rusak dilaporkan tanpa menggagalkan
   * yang lain. Hanya berkas yang mtime/size-nya berubah yang dibaca ulang.
   */
  async sync(dir: string): Promise<MemoryProblem[]> {
    const scanned = await scanMemoryFiles(dir);
    const seen = new Set<string>();
    const problems: MemoryProblem[] = [];

    for (const file of scanned) {
      seen.add(file.relPath);

      let mtimeMs: number;
      let size: number;
      try {
        const info = await Bun.file(file.absPath).stat();
        mtimeMs = info.mtimeMs;
        size = info.size;
      } catch {
        problems.push({ file: file.relPath, reason: "berkas tidak dapat dibaca" });
        continue;
      }

      const known = this.stmtFileGet.get(file.relPath) as
        | { mtime_ms: number; size: number; sha256: string }
        | null;
      const unchanged = known !== null && known.mtime_ms === mtimeMs && known.size === size;

      if (unchanged && this.stmtRowId.get(file.relPath) !== null) {
        continue;
      }

      const read = await readMemoryFile(dir, file.relPath, file.layer, file.projectKey);
      if (!read.ok) {
        const reason = read.reason === "pemetaan proyek tidak ditemukan" && file.projectError !== undefined
          ? file.projectError
          : read.reason;
        this.removePath(file.relPath);
        this.stmtFileUpsert.run(file.relPath, mtimeMs, size, known?.sha256 ?? "");
        problems.push({ file: file.relPath, reason });
        continue;
      }

      this.upsertMemory(read.memory, file.relPath);
      this.stmtFileUpsert.run(file.relPath, mtimeMs, size, read.sha256);
    }

    for (const row of this.db.query("SELECT path FROM files").all() as { path: string }[]) {
      if (seen.has(row.path)) continue;
      this.removePath(row.path);
      this.stmtDeleteFile.run(row.path);
    }

    problems.sort((left, right) => left.file.localeCompare(right.file));
    return problems;
  }

  list(query: MemoryListQuery = {}): Memory[] {
    const match: MemoryMatch = query.match ?? "all";
    const q = query.q?.trim() ?? "";
    const fts =
      q === ""
        ? ""
        : match === "any"
          ? toFtsAnyQuery(q)
          : toFtsQuery(q);
    if (q !== "" && fts === "") return [];

    const byAny = match === "any" && fts !== "";
    const prefix = byAny ? "m." : "";
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (query.status !== undefined) {
      clauses.push(`${prefix}status = ?`);
      params.push(query.status);
    }
    if (query.layer !== undefined) {
      clauses.push(`${prefix}layer = ?`);
      params.push(query.layer);
    }
    if (query.project !== undefined) {
      clauses.push(`(${prefix}layer = 'profile' OR ${prefix}project_key = ?)`);
      params.push(query.project);
    }

    if (fts !== "") {
      if (byAny) {
        clauses.push("memories_fts MATCH ?");
      } else {
        clauses.push(
          "rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)",
        );
      }
      params.push(fts);
    }

    const limit = query.limit ?? 100;
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const sql = byAny
      ? `SELECT m.* FROM memories m
         JOIN memories_fts ON memories_fts.rowid = m.rowid${where}
         ORDER BY bm25(memories_fts) ASC, m.updated_at DESC, m.id ASC LIMIT ?`
      : `SELECT * FROM memories${where} ORDER BY updated_at DESC, id ASC LIMIT ?`;
    params.push(limit);
    const rows = this.db.query(sql).all(...params) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  get(id: string): Memory | null {
    const row = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | null;
    return row === null ? null : rowToMemory(row);
  }

  counts(): MemoryCounts {
    const rows = this.db
      .query("SELECT status, COUNT(*) AS total FROM memories GROUP BY status")
      .all() as { status: string; total: number }[];
    let proposed = 0;
    let active = 0;
    for (const row of rows) {
      if (row.status === "proposed") proposed = row.total;
      if (row.status === "active") active = row.total;
    }
    return { proposed, active };
  }

  countActive(layer: MemoryLayer, projectKey: string | null): number {
    const row = this.db
      .query(
        "SELECT COUNT(*) AS total FROM memories WHERE status = 'active' AND layer = ? AND project_key IS ?",
      )
      .get(layer, projectKey) as { total: number };
    return row.total;
  }

  countProposed(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS total FROM memories WHERE status = 'proposed'")
      .get() as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}
