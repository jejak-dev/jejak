import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { jejakHome } from "../provider-store";
import { redactSecrets } from "../security/redact";
import { nextRun, parseSpec, type ScheduleSpec } from "./schedule-time";
import {
  SessionError,
  type CreateSessionInput,
  type SessionManager,
} from "./session-manager";

/**
 * Tugas terjadwal: prompt yang dijalankan otomatis sebagai SESI BARU pada
 * waktu tertentu atau berulang. Jadwal memakai waktu lokal server.
 */

/** Hasil jalannya tugas terakhir. */
export type ScheduledTaskStatus = "ok" | "gagal";

export interface ScheduledTask {
  id: string;
  /** Nama tugas (1..80 karakter); dipakai juga sebagai judul sesi. */
  name: string;
  /** Input pembuatan sesi (prompt + cwd/workspace/izin/worktree/sandbox). */
  input: CreateSessionInput;
  spec: ScheduleSpec;
  enabled: boolean;
  /** Waktu jalan berikutnya (ISO); kosong bila tak ada jadwal lagi. */
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: ScheduledTaskStatus;
  lastError?: string;
  /** Id sesi yang dibuat dari jalannya terakhir. */
  lastSessionId?: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskStore {
  /** Semua tugas yang tersimpan, urut waktu dibuat. */
  list(): ScheduledTask[];
  /** Simpan satu tugas (tambah atau perbarui). */
  save(task: ScheduledTask): void;
  /** Hapus satu tugas. */
  delete(id: string): void;
  /** Tutup sumber daya store (mis. berkas SQLite). */
  close?(): void;
}

/** Batas jumlah tugas terjadwal yang aktif. */
export const MAX_SCHEDULED_TASKS = 50;

/** Selang sapuan tugas terjadwal (ms). */
export const SCHEDULE_SWEEP_MS = 15000;

/**
 * Batas tangkapan setelah server mati: tugas yang terlewat lebih dari satu
 * jam tak dijalankan; jadwalnya dihitung ulang dari sekarang.
 */
export const SCHEDULE_CATCHUP_LIMIT_MS = 60 * 60 * 1000;

/** Panjang maksimum nama tugas. */
const MAX_NAME_LENGTH = 80;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Samarkan prompt tugas sebelum disimpan. Pola sama dengan `HeldPromptService`:
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

/** Id tugas: `t_` + 8 hex dari UUID. */
function newTaskId(): string {
  return `t_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** Apakah jadwal tersimpan punya bentuk yang dikenal. */
function isSpec(value: unknown): value is ScheduleSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "once") return typeof record.at === "string";
  if (record.kind === "every") return typeof record.minutes === "number";
  if (record.kind === "daily") return typeof record.time === "string";
  return false;
}

/** Baca satu tugas dari JSON tersimpan; bentuk rusak diabaikan. */
function parseItem(text: string): ScheduledTask | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Partial<ScheduledTask>;
  if (typeof record.id !== "string" || record.id === "") return undefined;
  if (typeof record.name !== "string") return undefined;
  if (typeof record.createdAt !== "string") return undefined;
  if (typeof record.input !== "object" || record.input === null) return undefined;
  if (!isSpec(record.spec)) return undefined;

  const task: ScheduledTask = {
    id: record.id,
    name: record.name,
    input: record.input as CreateSessionInput,
    spec: record.spec as ScheduleSpec,
    enabled: record.enabled === true,
    runCount: typeof record.runCount === "number" ? record.runCount : 0,
    createdAt: record.createdAt,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : record.createdAt,
  };
  if (typeof record.nextRunAt === "string") task.nextRunAt = record.nextRunAt;
  if (typeof record.lastRunAt === "string") task.lastRunAt = record.lastRunAt;
  if (record.lastStatus === "ok" || record.lastStatus === "gagal") {
    task.lastStatus = record.lastStatus;
  }
  if (typeof record.lastError === "string") task.lastError = record.lastError;
  if (typeof record.lastSessionId === "string") task.lastSessionId = record.lastSessionId;
  return task;
}

/** Store di memori: isi hilang saat server mati. */
export class MemoryScheduledTaskStore implements ScheduledTaskStore {
  private readonly items = new Map<string, ScheduledTask>();

  list(): ScheduledTask[] {
    return [...this.items.values()];
  }

  save(task: ScheduledTask): void {
    this.items.set(task.id, task);
  }

  delete(id: string): void {
    this.items.delete(id);
  }
}

interface ScheduledRow {
  id: string;
  created_at: string;
  data: string;
}

/** Store SQLite: satu berkas `schedules.db` di JEJAK_HOME, hanya bisa dibaca pemiliknya. */
export class SqliteScheduledTaskStore implements ScheduledTaskStore {
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
        `CREATE TABLE IF NOT EXISTS schedules (
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
      "SELECT id, created_at, data FROM schedules ORDER BY created_at ASC, id ASC",
    );
    this.stmtSave = this.db.prepare(
      `INSERT INTO schedules (id, created_at, data)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         created_at = excluded.created_at,
         data = excluded.data`,
    );
    this.stmtDelete = this.db.prepare("DELETE FROM schedules WHERE id = ?");

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

  list(): ScheduledTask[] {
    const rows = this.stmtList.all() as ScheduledRow[];
    const tasks: ScheduledTask[] = [];
    for (const row of rows) {
      const task = parseItem(row.data);
      if (task === undefined) continue;
      tasks.push(task);
    }
    return tasks;
  }

  save(task: ScheduledTask): void {
    this.stmtSave.run(task.id, task.createdAt, JSON.stringify(task));
  }

  delete(id: string): void {
    this.stmtDelete.run(id);
  }

  close(): void {
    this.db.close();
  }
}

/** Lokasi berkas tugas terjadwal di JEJAK_HOME. */
export function schedulesPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "schedules.db");
}

/**
 * Store bawaan: SQLite, atau store memori bila persistensi dimatikan
 * (`JEJAK_PERSIST=0`).
 */
export function defaultScheduledTaskStore(
  env: Record<string, string | undefined> = process.env,
): ScheduledTaskStore {
  if (env.JEJAK_PERSIST?.trim() === "0") {
    return new MemoryScheduledTaskStore();
  }
  return new SqliteScheduledTaskStore(schedulesPath(env));
}

/** Badan permintaan pembuatan tugas. */
export interface ScheduledTaskCreate {
  name: unknown;
  spec: unknown;
  enabled?: unknown;
  input: CreateSessionInput;
}

/** Badan permintaan perubahan tugas. */
export interface ScheduledTaskPatch {
  name?: unknown;
  spec?: unknown;
  enabled?: unknown;
  input?: Partial<CreateSessionInput>;
}

export interface ScheduledTaskServiceOptions {
  manager: SessionManager;
  store: ScheduledTaskStore;
  /** Jam Epoch (ms); dipakai tes untuk mengatur waktu. */
  now?: () => number;
  /** Selang sapuan (ms). */
  sweepMs?: number;
  /** Batas jumlah tugas. */
  maxTasks?: number;
}

/**
 * Layanan tugas terjadwal: menyimpan tugas, menjalankan prompt-nya sebagai
 * sesi baru saat jadwalnya tiba, dan mencatat hasilnya.
 *
 * Semua keputusan jadwal dibuat server; klien hanya mengirim dan menampilkan.
 */
export class ScheduledTaskService {
  private readonly manager: SessionManager;
  private readonly store: ScheduledTaskStore;
  private readonly now: () => number;
  private readonly sweepMs: number;
  private readonly maxTasks: number;
  private readonly items = new Map<string, ScheduledTask>();
  /** Id tugas yang sedang berjalan; dipakai menahan dua jalan sekaligus. */
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private storeWarned = false;

  constructor(options: ScheduledTaskServiceOptions) {
    this.manager = options.manager;
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.sweepMs = options.sweepMs ?? SCHEDULE_SWEEP_MS;
    this.maxTasks = options.maxTasks ?? MAX_SCHEDULED_TASKS;
    this.restore();
  }

  private restore(): void {
    let stored: ScheduledTask[];
    try {
      stored = this.store.list();
    } catch (error) {
      this.storeWarned = true;
      console.warn(`Penyimpanan tugas terjadwal gagal dimuat: ${errorMessage(error)}`);
      return;
    }
    for (const task of stored) {
      this.items.set(task.id, task);
    }
  }

  private persist(task: ScheduledTask): void {
    try {
      this.store.save(task);
    } catch (error) {
      if (!this.storeWarned) {
        this.storeWarned = true;
        console.warn(`Penyimpanan tugas terjadwal gagal: ${errorMessage(error)}`);
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
        console.warn(`Penyimpanan tugas terjadwal gagal: ${errorMessage(error)}`);
      }
    }
  }

  private copy(task: ScheduledTask): ScheduledTask {
    return { ...task, input: { ...task.input } };
  }

  /** Semua tugas, urut waktu dibuat. */
  list(): ScheduledTask[] {
    return [...this.items.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((task) => this.copy(task));
  }

  /** Satu tugas; `undefined` bila tak dikenal. */
  get(id: string): ScheduledTask | undefined {
    const task = this.items.get(id);
    return task === undefined ? undefined : this.copy(task);
  }

  /**
   * Buat tugas baru. Nama, prompt, jadwal, dan input sesi diperiksa seperti
   * saat membuat sesi; galatnya apa adanya (kode "tidak-valid").
   */
  async create(body: ScheduledTaskCreate): Promise<ScheduledTask> {
    const name = this.validateName(body.name);
    const spec = parseSpec(body.spec, new Date(this.now()));
    const enabled = this.validateEnabled(body.enabled);
    const input = this.validateInput(body.input);
    // Aturan cwd/workspace/izin diperiksa lewat jalur yang sama dengan
    // pembuatan sesi; sesi sendiri baru dibuat saat jadwalnya tiba.
    await this.manager.checkCreateInput(input);
    if (this.items.size >= this.maxTasks) {
      throw new SessionError("Terlalu banyak tugas terjadwal.", "tidak-valid");
    }

    const timestamp = new Date(this.now()).toISOString();
    const task: ScheduledTask = {
      id: newTaskId(),
      name,
      input: redactInput(input),
      spec,
      enabled,
      runCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const next = nextRun(spec, new Date(this.now()));
    if (next !== undefined) task.nextRunAt = next.toISOString();
    this.items.set(task.id, task);
    this.persist(task);
    return this.copy(task);
  }

  /**
   * Ubah tugas: nama, jadwal, status aktif, atau input sesinya. Jadwal
   * dihitung ulang bila jadwal berubah atau tugas diaktifkan lagi.
   */
  async update(id: string, patch: ScheduledTaskPatch): Promise<ScheduledTask> {
    const task = this.items.get(id);
    if (task === undefined) {
      throw new SessionError(`Tugas "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    const now = new Date(this.now());

    const name = patch.name === undefined ? task.name : this.validateName(patch.name);
    const enabled =
      patch.enabled === undefined ? task.enabled : this.validateEnabled(patch.enabled);
    let spec = task.spec;
    let specChanged = false;
    if (patch.spec !== undefined) {
      spec = parseSpec(patch.spec, now);
      specChanged = true;
    }
    let input = task.input;
    if (patch.input !== undefined) {
      input = this.mergeInput(task.input, patch.input);
      this.validateInput(input);
      await this.manager.checkCreateInput(input);
    }

    const updated: ScheduledTask = {
      ...task,
      name,
      spec,
      enabled,
      input: redactInput(input),
      updatedAt: now.toISOString(),
    };
    if (specChanged || (enabled && !task.enabled)) {
      const next = nextRun(spec, now);
      if (next === undefined) delete updated.nextRunAt;
      else updated.nextRunAt = next.toISOString();
    }
    if (!enabled) delete updated.nextRunAt;
    this.items.set(id, updated);
    this.persist(updated);
    return this.copy(updated);
  }

  /** Hapus tugas. */
  delete(id: string): void {
    if (!this.items.has(id)) {
      throw new SessionError(`Tugas "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    this.forget(id);
  }

  /**
   * Jalankan tugas sekarang. Jadwal tak digeser; tugas yang sedang berjalan
   * ditolak sebagai konflik.
   */
  async runNow(id: string): Promise<ScheduledTask> {
    const task = this.items.get(id);
    if (task === undefined) {
      throw new SessionError(`Tugas "${id}" tidak ditemukan.`, "tidak-ditemukan");
    }
    if (this.inFlight.has(id)) {
      throw new SessionError("Tugas sedang berjalan.", "konflik");
    }
    this.inFlight.add(id);
    try {
      await this.runTask(task);
    } finally {
      this.inFlight.delete(id);
    }
    const updated = this.items.get(id);
    return updated === undefined ? this.copy(task) : this.copy(updated);
  }

  /**
   * Periksa tugas yang jatuh tempo: jalankan yang waktunya sudah tiba.
   *
   * Klaim dibuat sinkron (jadwal dimajukan sebelum `await`) supaya dua
   * sapuan yang berjalan bersamaan tak membuat dua sesi untuk satu tugas.
   */
  async sweep(): Promise<void> {
    const nowMs = this.now();
    const now = new Date(nowMs);
    for (const task of [...this.items.values()]) {
      try {
        if (!task.enabled) continue;
        if (task.nextRunAt === undefined) continue;
        const due = Date.parse(task.nextRunAt);
        if (!Number.isFinite(due) || due > nowMs) continue;
        if (this.inFlight.has(task.id)) continue;

        // Klaim sinkron: jadwal dimajukan dan tugas ditandai berjalan
        // sebelum `await` supaya dua sapuan tak membuat dua sesi.
        this.inFlight.add(task.id);
        const next = nextRun(task.spec, now, now);
        const claimed: ScheduledTask = { ...task, updatedAt: now.toISOString() };
        if (next === undefined) delete claimed.nextRunAt;
        else claimed.nextRunAt = next.toISOString();
        this.items.set(task.id, claimed);
        this.persist(claimed);

        try {
          await this.runTask(claimed);
        } finally {
          this.inFlight.delete(task.id);
        }

        // Tugas sekali jalan tak punya jadwal berikutnya: matikan.
        if (task.spec.kind === "once") {
          const settled = this.items.get(task.id);
          if (settled !== undefined) {
            const selesai: ScheduledTask = {
              ...settled,
              enabled: false,
              updatedAt: new Date(this.now()).toISOString(),
            };
            delete selesai.nextRunAt;
            this.items.set(task.id, selesai);
            this.persist(selesai);
          }
        }
      } catch (error) {
        // Sapuan tak boleh melempar; galat tak terduga dicatat lalu diabaikan.
        console.error(errorMessage(error));
      }
    }
  }

  /**
   * Nyalakan jam tugas: pulihkan tugas yang tertinggal dari proses
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

  /** Matikan jam tugas. */
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
   * Pulihkan tugas dari proses sebelumnya: tugas yang terlewat jauh (server
   * mati) tak dijalankan; jadwalnya dihitung ulang dari sekarang. Yang
   * terlewat tak lama dijalankan sekali oleh sapuan pertama.
   */
  private recover(): void {
    const nowMs = this.now();
    const now = new Date(nowMs);
    for (const task of [...this.items.values()]) {
      if (!task.enabled || task.nextRunAt === undefined) continue;
      const due = Date.parse(task.nextRunAt);
      if (!Number.isFinite(due)) continue;
      if (nowMs - due <= SCHEDULE_CATCHUP_LIMIT_MS) continue;
      const next = nextRun(task.spec, now, now);
      const fixed: ScheduledTask = { ...task, updatedAt: now.toISOString() };
      if (next === undefined) {
        delete fixed.nextRunAt;
        if (task.spec.kind === "once") fixed.enabled = false;
      } else {
        fixed.nextRunAt = next.toISOString();
      }
      this.items.set(task.id, fixed);
      this.persist(fixed);
    }
  }

  /**
   * Jalankan satu tugas: buat sesi baru dari inputnya, lalu catat hasilnya.
   * Galat tak pernah dilempar; kegagalan dicatat pada tugas.
   */
  private async runTask(task: ScheduledTask): Promise<void> {
    const startedAt = new Date(this.now()).toISOString();
    const input: CreateSessionInput = { ...task.input };
    if (input.selection !== undefined) input.selection = { ...input.selection };
    // Sesi terjadwal memakai nama tugas sebagai judul bila tak ada judul.
    if (input.title === undefined || input.title.trim() === "") {
      input.title = task.name;
    }
    try {
      const session = await this.manager.create(input);
      const ok: ScheduledTask = {
        ...task,
        lastStatus: "ok",
        lastSessionId: session.id,
        lastRunAt: startedAt,
        runCount: task.runCount + 1,
        updatedAt: startedAt,
      };
      delete ok.lastError;
      this.items.set(task.id, ok);
      this.persist(ok);
    } catch (error) {
      const gagal: ScheduledTask = {
        ...task,
        lastStatus: "gagal",
        lastError: errorMessage(error),
        lastRunAt: startedAt,
        updatedAt: startedAt,
      };
      this.items.set(task.id, gagal);
      this.persist(gagal);
    }
  }

  /** Nama tugas: teks 1..80 karakter. */
  private validateName(value: unknown): string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new SessionError("Nama tugas harus berupa teks yang tidak kosong.", "tidak-valid");
    }
    const name = value.trim();
    if (name.length > MAX_NAME_LENGTH) {
      throw new SessionError(
        `Nama tugas maksimal ${MAX_NAME_LENGTH} karakter.`,
        "tidak-valid",
      );
    }
    return name;
  }

  /** Status aktif; default aktif. */
  private validateEnabled(value: unknown): boolean {
    if (value === undefined) return true;
    if (typeof value !== "boolean") {
      throw new SessionError("Field enabled harus berupa boolean.", "tidak-valid");
    }
    return value;
  }

  /**
   * Input sesi tugas: prompt wajib, mode tanpa izin dilarang (sesi terjadwal
   * dijalankan tanpa pengawasan pengguna).
   */
  private validateInput(input: CreateSessionInput): CreateSessionInput {
    if (typeof input?.prompt !== "string" || input.prompt.trim() === "") {
      throw new SessionError("Prompt tidak boleh kosong.", "tidak-valid");
    }
    if (input.permissionMode === "bypassPermissions") {
      throw new SessionError(
        "Mode tanpa izin tidak boleh untuk tugas terjadwal.",
        "tidak-valid",
      );
    }
    if (input.confirmBypass !== undefined) {
      throw new SessionError(
        "Konfirmasi bypass tidak boleh untuk tugas terjadwal.",
        "tidak-valid",
      );
    }
    return { ...input };
  }

  /** Gabungkan input lama dan bagian yang dikirim klien. */
  private mergeInput(
    current: CreateSessionInput,
    patch: Partial<CreateSessionInput>,
  ): CreateSessionInput {
    const merged: CreateSessionInput = { ...current, ...patch };
    const selection = { ...(current.selection ?? {}), ...(patch.selection ?? {}) };
    if (Object.keys(selection).length > 0) merged.selection = selection;
    else delete merged.selection;
    return merged;
  }
}
