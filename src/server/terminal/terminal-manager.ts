import { statSync } from "node:fs";
import { isAbsolutePath, isWindows } from "../platform";

export type TerminalErrorCode = "tidak-valid" | "tidak-ditemukan" | "batas";

export class TerminalError extends Error {
  constructor(
    message: string,
    public readonly code: TerminalErrorCode,
  ) {
    super(message);
    this.name = "TerminalError";
  }
}

export interface TerminalInfo {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: string;
  exited: boolean;
  exitCode?: number | null;
}

export interface TerminalListener {
  onData(bytes: Uint8Array): void;
  onExit(exitCode: number | null): void;
}

export const MAX_TERMINALS = 4;
export const IDLE_MS = 30 * 60 * 1000;
export const BUFFER_BYTES = 256 * 1024;
export const MAX_INPUT_BYTES = 64 * 1024;
const EXITED_KEEP_MS = 5 * 60 * 1000;

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL)/i;
const INTERNAL_PREFIX = /^(ANTHROPIC_|JEJAK_|CLAUDE_CODE_)/;

/** Env untuk shell terminal: tanpa kunci/token yang dipakai server Jejak. */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (INTERNAL_PREFIX.test(name) || SECRET_NAME.test(name)) continue;
    result[name] = value;
  }
  result.TERM = "xterm-256color";
  return result;
}

function invalid(message: string): TerminalError {
  return new TerminalError(message, "tidak-valid");
}

/** Shell dan argumen yang dipakai untuk menjalankan terminal. */
export interface TerminalShell {
  shell: string;
  args: string[];
}

/**
 * Argumen shell (fungsi murni): POSIX memakai shell login (`-l`), Windows
 * memakai Command Prompt tanpa argumen apa pun.
 */
export function terminalShellArgs(platform: NodeJS.Platform = process.platform): string[] {
  return isWindows(platform) ? [] : ["-l"];
}

/**
 * Pilih shell terminal (fungsi murni, tanpa spawn).
 *
 * - pilihan eksplisit (`shell`) selalu menang;
 * - Windows: `COMSPEC` bila ada, selain itu `cmd.exe`;
 * - POSIX: `$SHELL` bila absolut, selain itu `/bin/sh`.
 */
export function resolveTerminalShell(input: {
  shell?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): TerminalShell {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  if (input.shell !== undefined) {
    return { shell: input.shell, args: terminalShellArgs(platform) };
  }
  if (isWindows(platform)) {
    const comspec = env.COMSPEC?.trim();
    return {
      shell: comspec !== undefined && comspec !== "" ? comspec : "cmd.exe",
      args: [],
    };
  }
  const envShell = env.SHELL;
  return {
    shell:
      envShell !== undefined && isAbsolutePath(envShell, platform) ? envShell : "/bin/sh",
    args: terminalShellArgs(platform),
  };
}

/** Rencana mematikan proses terminal sesuai platform (fungsi murni). */
export interface TerminalKillPlan {
  /** Sinyal untuk proses itu sendiri; di Windows tak ada (SIGTERM bawaan Bun). */
  signal?: "SIGHUP";
  /** Cara cadangan bila proses belum mati: bunuh proses atau pohon proses. */
  fallback: "SIGKILL" | "taskkill";
}

/**
 * Rencana kill: POSIX pakai SIGHUP lalu SIGKILL; Windows pakai `kill()`
 * tanpa nama sinyal lalu `taskkill /T /F` untuk pohon proses.
 */
export function terminalKillPlan(platform: NodeJS.Platform = process.platform): TerminalKillPlan {
  if (isWindows(platform)) return { fallback: "taskkill" };
  return { signal: "SIGHUP", fallback: "SIGKILL" };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(`Ukuran terminal harus bilangan bulat ${min}-${max}.`);
  }
  return value;
}

interface Entry {
  info: TerminalInfo;
  proc: ReturnType<typeof Bun.spawn>;
  chunks: Uint8Array[];
  bytes: number;
  listeners: Set<TerminalListener>;
  lastActivity: number;
  exitedAt?: number;
}

export interface TerminalManagerOptions {
  /**
   * Shell untuk terminal. Bawaan: POSIX memakai `$SHELL` bila absolut
   * (selain itu /bin/sh), Windows memakai `COMSPEC` (selain itu cmd.exe).
   */
  shell?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  maxTerminals?: number;
  idleMs?: number;
  /** Platform untuk perilaku lintas OS; default `process.platform`. */
  platform?: NodeJS.Platform;
}

export class TerminalManager {
  private readonly entries = new Map<string, Entry>();
  private readonly shell: string;
  private readonly shellArgs: string[];
  private readonly env: Record<string, string>;
  private readonly now: () => number;
  private readonly max: number;
  private readonly idleMs: number;
  private readonly platform: NodeJS.Platform;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: TerminalManagerOptions = {}) {
    const platform = options.platform ?? process.platform;
    const resolved = resolveTerminalShell({
      shell: options.shell,
      env: options.env ?? process.env,
      platform,
    });
    this.shell = resolved.shell;
    this.shellArgs = resolved.args;
    this.env = scrubEnv(options.env ?? process.env);
    this.now = options.now ?? (() => Date.now());
    this.max = options.maxTerminals ?? MAX_TERMINALS;
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.platform = platform;
  }

  /** Mulai penyapu berkala (tutup terminal menganggur dan bersihkan yang sudah keluar). */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.sweep(), 60_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  list(): TerminalInfo[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.info }));
  }

  create(input: { cwd: unknown; cols?: unknown; rows?: unknown }): TerminalInfo {
    const cwd = input.cwd;
    if (typeof cwd !== "string" || !isAbsolutePath(cwd, this.platform)) {
      throw invalid("cwd harus berupa path absolut.");
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(cwd).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) throw invalid("cwd tidak ditemukan atau bukan direktori.");
    const cols = clampInt(input.cols, 20, 300, 80);
    const rows = clampInt(input.rows, 5, 100, 24);
    const active = [...this.entries.values()].filter((entry) => !entry.info.exited).length;
    if (active >= this.max) {
      throw new TerminalError(`Batas ${this.max} terminal aktif tercapai.`, "batas");
    }

    const id = crypto.randomUUID();
    const entry: Entry = {
      info: { id, cwd, cols, rows, createdAt: new Date(this.now()).toISOString(), exited: false },
      proc: undefined as unknown as Entry["proc"],
      chunks: [],
      bytes: 0,
      listeners: new Set(),
      lastActivity: this.now(),
    };
    let proc: Entry["proc"];
    try {
      // `detached` sengaja tak dipakai: di Windows proses tak boleh lepas
      // dari konsol (cmd.exe butuh konsol), dan di POSIX perilaku lama
      // (tanpa detach) harus tetap sama.
      proc = Bun.spawn([this.shell, ...this.shellArgs], {
        cwd,
        env: this.env,
        terminal: {
          cols,
          rows,
          data: (_terminal, data) => {
            const copy = new Uint8Array(data);
            this.keep(entry, copy);
            for (const listener of entry.listeners) {
              try {
                listener.onData(copy);
              } catch {
                // Pendengar yang rusak tidak boleh menghentikan terminal.
              }
            }
          },
        },
      });
    } catch {
      throw new TerminalError(
        `Shell tidak dapat dijalankan: ${this.shell}.`,
        "tidak-valid",
      );
    }
    entry.proc = proc;
    this.entries.set(id, entry);
    void proc.exited.then((code) => {
      entry.info.exited = true;
      entry.info.exitCode = code;
      entry.exitedAt = this.now();
      for (const listener of entry.listeners) {
        try {
          listener.onExit(code);
        } catch {
          // Abaikan.
        }
      }
    });
    return { ...entry.info };
  }

  private keep(entry: Entry, chunk: Uint8Array): void {
    entry.chunks.push(chunk);
    entry.bytes += chunk.length;
    while (entry.bytes > BUFFER_BYTES && entry.chunks.length > 1) {
      entry.bytes -= entry.chunks.shift()!.length;
    }
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined) throw new TerminalError("Terminal tidak ditemukan.", "tidak-ditemukan");
    return entry;
  }

  write(id: string, data: unknown): void {
    const entry = this.entry(id);
    if (typeof data !== "string" || data === "") throw invalid("data harus berupa teks tidak kosong.");
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) throw invalid("data terlalu besar.");
    if (entry.info.exited) throw new TerminalError("Terminal sudah selesai.", "tidak-valid");
    entry.lastActivity = this.now();
    (entry.proc as unknown as { terminal: { write(data: string): number } }).terminal.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): TerminalInfo {
    const entry = this.entry(id);
    const c = clampInt(cols, 20, 300, entry.info.cols);
    const r = clampInt(rows, 5, 100, entry.info.rows);
    if (!entry.info.exited) {
      (entry.proc as unknown as { terminal: { resize(c: number, r: number): void } }).terminal.resize(c, r);
    }
    entry.info.cols = c;
    entry.info.rows = r;
    entry.lastActivity = this.now();
    return { ...entry.info };
  }

  /** Mengembalikan keluaran tertahan lalu mendengarkan keluaran berikutnya. */
  subscribe(id: string, listener: TerminalListener): { replay: Uint8Array; exited: boolean; unsubscribe: () => void } {
    const entry = this.entry(id);
    const replay = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const chunk of entry.chunks) {
      replay.set(chunk, offset);
      offset += chunk.length;
    }
    entry.listeners.add(listener);
    entry.lastActivity = this.now();
    return { replay, exited: entry.info.exited, unsubscribe: () => entry.listeners.delete(listener) };
  }

  close(id: string): void {
    const entry = this.entry(id);
    this.entries.delete(id);
    entry.listeners.clear();
    try {
      (entry.proc as unknown as { terminal?: { close(): void } }).terminal?.close();
    } catch {
      // Sudah tertutup.
    }
    if (!entry.info.exited) {
      const plan = terminalKillPlan(this.platform);
      try {
        if (plan.signal !== undefined) entry.proc.kill(plan.signal);
        else entry.proc.kill();
      } catch {
        // Proses sudah berhenti.
      }
      const proc = entry.proc;
      const killer = setTimeout(() => {
        if (plan.fallback === "taskkill") {
          // Windows tak punya sinyal grup; bunuh pohon proses sebagai cadangan.
          try {
            Bun.spawn(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            });
          } catch {
            // Proses sudah berhenti atau taskkill tak tersedia.
          }
          return;
        }
        try {
          proc.kill("SIGKILL");
        } catch {
          // Proses sudah berhenti.
        }
      }, 2000);
      (killer as { unref?: () => void }).unref?.();
    }
  }

  /** Tutup terminal menganggur dan buang yang sudah keluar lama. */
  sweep(): void {
    const now = this.now();
    for (const [id, entry] of [...this.entries]) {
      const idle = now - entry.lastActivity > this.idleMs && entry.listeners.size === 0;
      const expired = entry.exitedAt !== undefined && now - entry.exitedAt > EXITED_KEEP_MS;
      if (idle || expired) this.close(id);
    }
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
