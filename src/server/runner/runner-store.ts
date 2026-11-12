import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { jejakHome } from "../provider-store";

/** Batas jumlah perintah kustom per folder. */
export const RUNNER_CUSTOM_MAX = 40;
/** Panjang maksimum label perintah. */
export const RUNNER_LABEL_MAX = 60;
/** Panjang maksimum teks perintah (satu baris). */
export const RUNNER_COMMAND_MAX = 500;
/** Panjang maksimum grup perintah. */
export const RUNNER_GROUP_MAX = 40;

export interface RunnerCustomCommand {
  id: string;
  label: string;
  command: string;
  group?: string;
}

/** Isi satu folder: perintah kustom dan hash konfirmasi per id. */
export interface RunnerFolder {
  custom: RunnerCustomCommand[];
  confirmed: Record<string, string>;
}

export interface RunnerState {
  folders: Record<string, RunnerFolder>;
}

export interface RunnerStore {
  /** Isi folder; folder tak dikenal berarti kosong. */
  read(cwd: string): RunnerFolder;
  /** Simpan isi folder (atomik). */
  write(cwd: string, folder: RunnerFolder): void;
}

export function runnerPath(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "runner.json");
}

export function defaultRunnerStore(
  env: Record<string, string | undefined> = process.env,
): RunnerStore {
  return new FileRunnerStore(runnerPath(env));
}

/** Hash SHA-256 hex dari teks perintah (dasar konfirmasi). */
export function hashCommand(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

/** `true` bila teks memuat karakter kontrol (newline, carriage return, tab). */
export function hasControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Id acak untuk perintah kustom: `c_` + 8 hex. */
export function newCustomId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `c_${hex}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCustom(raw: unknown): RunnerCustomCommand | null {
  if (!isRecord(raw)) return null;
  const { id, label, command, group } = raw;
  if (typeof id !== "string" || id === "") return null;
  if (typeof label !== "string" || label === "") return null;
  if (typeof command !== "string" || command === "") return null;
  const item: RunnerCustomCommand = { id, label, command };
  if (typeof group === "string" && group !== "") item.group = group;
  return item;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function parseFolder(raw: unknown): RunnerFolder {
  const folder: RunnerFolder = { custom: [], confirmed: {} };
  if (!isRecord(raw)) return folder;
  if (Array.isArray(raw.custom)) {
    folder.custom = raw.custom
      .map(parseCustom)
      .filter((item): item is RunnerCustomCommand => item !== null)
      .slice(0, RUNNER_CUSTOM_MAX);
  }
  if (isRecord(raw.confirmed)) {
    for (const [id, hash] of Object.entries(raw.confirmed)) {
      if (typeof hash === "string" && HASH_PATTERN.test(hash)) folder.confirmed[id] = hash;
    }
  }
  return folder;
}

/** Penyimpanan berkas JSON atomik (0600); `:memory:` untuk tes. */
export class FileRunnerStore implements RunnerStore {
  private readonly path: string;
  private readonly inMemory: boolean;
  private state: RunnerState | undefined;

  constructor(path: string) {
    this.path = path;
    this.inMemory = path === ":memory:" || path === "";
  }

  private load(): RunnerState {
    if (this.state !== undefined) return this.state;
    this.state = { folders: {} };
    if (this.inMemory) return this.state;

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      // Berkas belum ada: mulai kosong.
      return this.state;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return this.state;
      const folders = isRecord(parsed.folders) ? parsed.folders : {};
      for (const [cwd, folder] of Object.entries(folders)) {
        this.state.folders[cwd] = parseFolder(folder);
      }
    } catch {
      // Berkas rusak: dipulihkan kosong, tidak melempar.
      this.state = { folders: {} };
    }
    return this.state;
  }

  read(cwd: string): RunnerFolder {
    const state = this.load();
    const folder = state.folders[cwd];
    if (folder === undefined) return { custom: [], confirmed: {} };
    return {
      custom: folder.custom.map((item) => ({ ...item })),
      confirmed: { ...folder.confirmed },
    };
  }

  write(cwd: string, folder: RunnerFolder): void {
    const state = this.load();
    state.folders[cwd] = {
      custom: folder.custom.map((item) => ({ ...item })),
      confirmed: { ...folder.confirmed },
    };
    if (this.inMemory) return;

    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ folders: state.folders }, null, 2)}\n`;
    const tempPath = `${this.path}.${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, body, { mode: 0o600 });
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
