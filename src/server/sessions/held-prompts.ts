import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { jejakHome } from "../provider-store";
import { redactSecrets } from "../security/redact";
import {
  SessionError,
  type CreateSessionInput,
  type SessionInfo,
  type SessionManager,
} from "./session-manager";

/**
 * Prompt tertahan: prompt sesi baru yang disimpan server sampai sesi yang
 * ditunggu benar-benar selesai. Tahanannya hidup di server (bukan di klien)
 * supaya selamat dari muat ulang halaman dan tab yang ditutup.
 */
export type HeldStatus = "menunggu" | "terkirim" | "gagal" | "dibatalkan";

export interface HeldPrompt {
  id: string;
  /** Input pembuatan sesi; sama persis dengan input yang diberikan pengguna. */
  input: CreateSessionInput;
  /** Id sesi yang harus selesai sebelum prompt dikirim. */
  waitForSessionId: string;
  /** Waktu tahanan dibuat (ISO). */
  createdAt: string;
  status: HeldStatus;
  /** Terisi saat status "terkirim": sesi yang dibuat dari prompt ini. */
  sessionId?: string;
  /** Terisi saat status "gagal": pesan galat pengiriman. */
  error?: string;
}

export interface HeldPromptStore {
  /** Semua tahanan yang tersimpan, urut waktu dibuat. */
  list(): HeldPrompt[];
  /** Simpan satu tahanan (tambah atau perbarui). */
  save(item: HeldPrompt): void;
  /** Hapus satu tahanan. */
  delete(id: string): void;
  /** Tutup sumber daya store (mis. berkas SQLite). */
  close?(): void;
}

/** Batas jumlah tahanan yang menunggu sesi yang ditunggu. */
export const MAX_HELD_PROMPTS = 20;

/** Jeda minimum antara sesi yang selesai dan prompt yang dikirim (ms). */
export const HELD_GRACE_MS = 1500;

/** Selang sapuan tahanan (ms). */
export const HELD_SWEEP_MS = 1000;

/** Pesan galat saat server mati di tengah pengiriman tahanan. */
export const HELD_RESTART_MESSAGE = "Server dimulai ulang sebelum sesi dibuat.";

const STATUSES: readonly HeldStatus[] = ["menunggu", "terkirim", "gagal", "dibatalkan"];

function isStatus(value: unknown): value is HeldStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Samarkan prompt tahanan sebelum disimpan. Pola sama dengan `SessionManager`:
 * nilai yang dikenali sebagai rahasia diganti penanda, bukan teks aslinya.
 */
function redactInput(input: CreateSessionInput): CreateSessionInput {
  if (typeof input.prompt !== "string") return input;
  try {
    const prompt = redactSecrets(input.prompt).text;
    if (prompt === input.prompt) return input;
    return { ...input, prompt };
  } catch {
    return input;
  }
}

/** Id tahanan: `h_` + 8 hex dari UUID. */
function newHeldId(): string {
  return `h_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Baca satu tahanan dari JSON tersimpan; bentuk rusak diabaikan. */
function parseItem(text: string): HeldPrompt | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Partial<HeldPrompt>;
  if (typeof record.id !== "string" || record.id === "") return undefined;
  if (typeof record.waitForSessionId !== "string") return undefined;
  if (typeof record.createdAt !== "string") return undefined;
  if (!isStatus(record.status)) return undefined;
  if (typeof record.input !== "object" || record.input === null) return undefined;

  const item: HeldPrompt = {
    id: record.id,
    input: record.input as CreateSessionInput,
    waitForSessionId: record.waitForSessionId,
    createdAt: record.createdAt,
    status: record.status,
  };
  if (typeof record.sessionId === "string") item.sessionId = record.sessionId;
  if (typeof record.error === "string") item.error = record.error;
  return item;
}

/** Store di memori: isi hilang saat server mati. */
export class MemoryHeldPromptStore implements HeldPromptStore {
  private readonly items = new Map<string, HeldPrompt>();

  list(): HeldPrompt[] {
    return [...this.items.values()];
  }

  save(item: HeldPrompt): void {
    this.items.set(item.id, item);
  }

  delete(id: string): void {
    this.items.delete(id);
  }
}

interface HeldRow {
  id: string;
  created_at: string;
  data: string;
}

/** Store SQLite: satu berkas `held.db` di JEJAK_HOME, hanya bisa dibaca pemiliknya. */
export class SqliteHeldPromptStore implements HeldPromptStore {
  private readonly db: Database;
  private readonly stmtList: Statement;
  private readonly stmtSave: Statement;
  private readonly stmtDelete: Statement;

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
    try {
      this.db.run(
        `CREATE TABLE IF NOT EXISTS held (
           id TEXT PRIMARY KEY,
           created_at TEXT NOT NULL,
           data TEXT NOT NULL
         )`,
      );
    } catch (error) {
      this.db.close();
      throw error;
    }

    this.stmtList = this.db.prepare(
      "SELECT id, created_at, data FROM held ORDER BY created_at ASC, id ASC",
    );
    this.stmtSave = this.db.prepare(
      `INSERT INTO held (id, created_at, data)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         created_at = excluded.created_at,
         data = excluded.data`,
    );
    this.stmtDelete = this.db.prepare("DELETE FROM held WHERE id = ?");

    if (!inMemory) {
      this.restrictPermissions(path);
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

  list(): HeldPrompt[] {
    const rows = this.stmtList.all() as HeldRow[];
    const items: HeldPrompt[] = [];
    for (const row of rows) {
      const item = parseItem(row.data);
      if (item === undefined) continue;
      items.push(item);
    }
    return items;
  }

  save(item: HeldPrompt): void {
    this.stmtSave.run(item.id, item.createdAt, JSON.stringify(item));
  }

  delete(id: string): void {
    this.stmtDelete.run(id);
  }

  close(): void {
    this.db.close();
  }
}

/** Lokasi berkas tahanan di JEJAK_HOME. */
export function heldPromptsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "held.db");
}

/**
 * Store bawaan: SQLite, atau store memori bila persistensi dimatikan
 * (`JEJAK_PERSIST=0`).
 */
export function defaultHeldPromptStore(
  env: Record<string, string | undefined> = process.env,
): HeldPromptStore {
  if (env.JEJAK_PERSIST?.trim() === "0") {
    return new MemoryHeldPromptStore();
  }
  return new SqliteHeldPromptStore(heldPromptsPath(env));
}

/**
 * Apakah sesi yang ditunggu sudah selesai: bukan berjalan, antrean pesan
 * kosong, dan sudah lewat jeda (`graceMs`) sejak pembaruan terakhir.
 *
 * Antrean pesan ikut diperhitungkan: pesan antre dikirim otomatis begitu
 * giliran selesai, jadi prompt tertahan tak boleh mendahului pesan itu.
 */
export function isSettled(info: SessionInfo, now: number, graceMs: number): boolean {
  if (info.status === "berjalan") return false;
  if ((info.queued ?? 0) > 0) return false;
  const updated = Date.parse(info.updatedAt);
  if (!Number.isFinite(updated)) return false;
  return now - updated >= graceMs;
}

export interface HeldPromptServiceOptions {
  manager: SessionManager;
  store: HeldPromptStore;
  /** Jam Epoch (ms) untuk jeda selesai; dipakai tes untuk mengatur waktu. */
  now?: () => number;
  /** Jeda minimum sebelum prompt dikirim (ms). */
  graceMs?: number;
  /** Selang sapuan (ms). */
  sweepMs?: number;
}

/**
 * Layanan tahanan: menyimpan prompt yang menunggu sesi lain selesai, lalu
 * mengirimnya lewat `SessionManager.create` saat sesi itu benar-benar selesai.
 *
 * Semua keputusan sendsi dibuat server; klien hanya menyimpan draf.
 */
export class HeldPromptService {
  private readonly manager: SessionManager;
  private readonly store: HeldPromptStore;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly sweepMs: number;
  private readonly items = new Map<string, HeldPrompt>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private storeWarned = false;

  constructor(options: HeldPromptServiceOptions) {
    this.manager = options.manager;
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.graceMs = options.graceMs ?? HELD_GRACE_MS;
    this.sweepMs = options.sweepMs ?? HELD_SWEEP_MS;
    this.restore();
  }

  private restore(): void {
    let stored: HeldPrompt[];
    try {
      stored = this.store.list();
    } catch (error) {
      this.storeWarned = true;
      console.warn(`Penyimpanan prompt tertahan gagal dimuat: ${errorMessage(error)}`);
      return;
    }
    for (const item of stored) {
      this.items.set(item.id, item);
    }
  }

  private persist(item: HeldPrompt): void {
    try {
      this.store.save(item);
    } catch (error) {
      if (!this.storeWarned) {
        this.storeWarned = true;
        console.warn(`Penyimpanan prompt tertahan gagal: ${errorMessage(error)}`);
      }
    }
  }

  private forget(id: string): void {
    this.items.delete(id);
    try {
      this.store.delete(id);
    } catch (error) {
      if (!this.storeWarned) {
        this.storeWarned = true;
        console.warn(`Penyimpanan prompt tertahan gagal: ${errorMessage(error)}`);
      }
    }
  }

  /** Semua tahanan, urut waktu dibuat. */
  list(): HeldPrompt[] {
    return [...this.items.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((item) => ({ ...item, input: { ...item.input } }));
  }

  /** Satu tahanan; `undefined` bila tak dikenal. */
  get(id: string): HeldPrompt | undefined {
    const item = this.items.get(id);
    return item === undefined ? undefined : { ...item, input: { ...item.input } };
  }

  /**
   * Simpan prompt yang menunggu sesi `waitForSessionId` selesai. Prompt
   * ditahan; sesi BARU dibuat nanti saat sesi yang ditunggu selesai.
   */
  hold(input: CreateSessionInput, waitForSessionId: string): HeldPrompt {
    if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
      throw new SessionError("Prompt tidak boleh kosong.", "tidak-valid");
    }
    const target = this.manager.get(waitForSessionId);
    if (target === undefined) {
      throw new SessionError(
        `Sesi "${waitForSessionId}" tidak ditemukan.`,
        "tidak-ditemukan",
      );
    }
    if (target.status !== "berjalan") {
      throw new SessionError("Sesi yang ditunggu tidak sedang berjalan.", "konflik");
    }
    const menunggu = [...this.items.values()].filter(
      (item) => item.status === "menunggu",
    );
    if (menunggu.length >= MAX_HELD_PROMPTS) {
      throw new SessionError("Terlalu banyak prompt tertahan.", "tidak-valid");
    }

    const item: HeldPrompt = {
      id: newHeldId(),
      input: redactInput(input),
      waitForSessionId,
      createdAt: new Date(this.now()).toISOString(),
      status: "menunggu",
    };
    this.items.set(item.id, item);
    this.persist(item);
    return { ...item, input: { ...item.input } };
  }

  /**
   * Batalkan tahanan yang masih menunggu. Tahanannya dihapus dari storage;
   * isinya dikembalikan supaya klien bisa memulihkan draf.
   */
  cancel(id: string): HeldPrompt {
    const item = this.items.get(id);
    if (item === undefined) {
      throw new SessionError(`Tertahan "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    if (item.status !== "menunggu") {
      throw new SessionError("Tertahan ini tak bisa dibatalkan.", "konflik");
    }
    const cancelled: HeldPrompt = { ...item, status: "dibatalkan" };
    this.forget(id);
    return { ...cancelled, input: { ...cancelled.input } };
  }

  /**
   * Tutup kartu tahanan yang tak menunggu apa pun (terkirim, gagal, atau
   * dibatalkan): barisnya dihapus dari storage.
   */
  dismiss(id: string): void {
    const item = this.items.get(id);
    if (item === undefined) {
      throw new SessionError(`Tertahan "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    if (item.status === "menunggu") {
      throw new SessionError("Tertahan ini masih menunggu; batalkan dulu.", "konflik");
    }
    this.forget(id);
  }

  /**
   * Periksa tahanan yang menunggu: sesi yang ditunggu sudah selesai, lalu
   * prompt dikirim sebagai sesi baru.
   *
   * Klaim dibuat sinkron (status diubah ke "terkirim" sebelum `await`) supaya
   * dua sapuan yang berjalan bersamaan tidak membuat dua sesi untuk satu
   * tahanan.
   */
  async sweep(): Promise<void> {
    let pending: HeldPrompt[];
    try {
      pending = [...this.items.values()]
        .filter((item) => item.status === "menunggu")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch (error) {
      console.error(errorMessage(error));
      return;
    }

    for (const item of pending) {
      try {
        await this.dispatch(item);
      } catch (error) {
        // Sapuan tak boleh melempar; galat tak terduga dicatat lalu diabaikan.
        console.error(errorMessage(error));
      }
    }
  }

  /** Kirim satu tahanan bila sesi yang ditunggu sudah selesai. */
  private async dispatch(item: HeldPrompt): Promise<void> {
    const target = this.manager.get(item.waitForSessionId);
    if (target !== undefined && !isSettled(target, this.now(), this.graceMs)) {
      return;
    }
    // Sesi yang ditunggu sudah dihapus: perlakukan sebagai selesai.

    // Klaim sinkron: status berubah sebelum `await` supaya dua sapuan yang
    // berjalan bersamaan tidak membuat dua sesi untuk satu tahanan.
    const claimed: HeldPrompt = { ...item, status: "terkirim" };
    this.items.set(item.id, claimed);
    this.persist(claimed);

    try {
      const session = await this.manager.create(claimed.input);
      const terkirim: HeldPrompt = { ...claimed, sessionId: session.id };
      this.items.set(item.id, terkirim);
      this.persist(terkirim);
    } catch (error) {
      const gagal: HeldPrompt = {
        ...claimed,
        status: "gagal",
        error: errorMessage(error),
      };
      this.items.set(item.id, gagal);
      this.persist(gagal);
    }
  }

  /**
   * Nyalakan jam tahanan: pulihkan tahanan yang tertinggal dari proses
   * sebelumnya, lalu sapuan berjalan tiap `sweepMs`.
   */
  start(): void {
    this.recover();
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.sweepMs);
    // Timer tak boleh menahan proses keluar.
    (this.timer as { unref?: () => void }).unref?.();
    void this.sweep();
  }

  /** Matikan jam tahanan. */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Hentikan jam dan tutup store. */
  close(): void {
    this.stop();
    try {
      this.store.close?.();
    } catch {
      // Penutupan store tak boleh menggagalkan penutupan server.
    }
  }

  /**
   * Pulihkan tahanan dari proses sebelumnya: tahanan yang sudah diklaim tapi
   * belum punya sesi berarti server mati di tengah pengiriman.
   */
  private recover(): void {
    for (const item of [...this.items.values()]) {
      if (item.status !== "terkirim" || item.sessionId !== undefined) continue;
      const gagal: HeldPrompt = {
        ...item,
        status: "gagal",
        error: HELD_RESTART_MESSAGE,
      };
      this.items.set(item.id, gagal);
      this.persist(gagal);
    }
  }
}
