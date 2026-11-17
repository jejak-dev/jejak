import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isWindows, pathApi, type PathApi } from "../platform";
import { jejakHome } from "../provider-store";

/**
 * Berkas `.env` per akar proyek yang isinya dipakai sebagai variabel
 * lingkungan perintah Bash agent (nilainya tak pernah dilihat agent).
 */
export interface CommandEnvStore {
  /** Jalur absolut berkas env untuk satu akar proyek, atau undefined. */
  get(projectRoot: string): string | undefined;
  /** Melempar `CommandEnvError` bila jalur tidak valid. Mengembalikan jalur tersimpan. */
  set(projectRoot: string, absPath: string): string;
  /** `true` bila ada entri yang dihapus. */
  clear(projectRoot: string): boolean;
}

export class CommandEnvError extends Error {
  readonly code = "tidak-valid" as const;

  constructor(message: string) {
    super(message);
    this.name = "CommandEnvError";
  }
}

export const COMMAND_ENV_VERSION = 1;
export const MAX_PROJECTS = 200;
export const MAX_ENV_BYTES = 256 * 1024;

export function commandEnvPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "command-env.json");
}

export function defaultCommandEnvStore(
  env: Record<string, string | undefined> = process.env,
): CommandEnvStore | undefined {
  if (
    env.JEJAK_SECRET_BLOCK?.trim() === "0" ||
    env.JEJAK_PERSIST?.trim() === "0"
  ) {
    return undefined;
  }
  return new FileCommandEnvStore(commandEnvPath(env));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRoot(root: string, p: PathApi): string {
  const resolved = p.resolve(root);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function expandHome(raw: string, p: PathApi, platform: NodeJS.Platform): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return p.resolve(homedir(), raw.slice(2));
  // Di Windows "~\\AppData\\..." juga berarti folder home.
  if (isWindows(platform) && raw.startsWith("~\\")) return p.resolve(homedir(), raw.slice(2));
  return raw;
}

/** Penyimpanan berkas JSON atomik; `:memory:` untuk tes tanpa berkas. */
export class FileCommandEnvStore implements CommandEnvStore {
  private readonly path: string;
  private readonly inMemory: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly p: PathApi;
  private readonly projects = new Map<string, string>();
  private loaded = false;

  constructor(path: string, options: { platform?: NodeJS.Platform } = {}) {
    this.path = path;
    this.inMemory = path === ":memory:" || path === "";
    this.platform = options.platform ?? process.platform;
    this.p = pathApi(this.platform);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (this.inMemory) return;

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      // Berkas rusak atau versi tak dikenal diperlakukan kosong; tidak ditimpa
      // sampai ada `set` pertama.
      if (!isRecord(parsed) || parsed.version !== COMMAND_ENV_VERSION) return;
      if (!isRecord(parsed.projects)) return;
      for (const [root, value] of Object.entries(parsed.projects)) {
        if (typeof value !== "string" || value === "") continue;
        if (!this.p.isAbsolute(value)) continue;
        this.projects.set(root, value);
      }
    } catch {
      // JSON rusak: kosong.
    }
  }

  private persist(): void {
    if (this.inMemory) return;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Direktori induk bisa milik sistem; berkas tetap 0600 di bawah.
    }

    const projects: Record<string, string> = {};
    for (const root of Array.from(this.projects.keys()).sort()) {
      const file = this.projects.get(root);
      if (file !== undefined) projects[root] = file;
    }
    const body = `${JSON.stringify({ version: COMMAND_ENV_VERSION, projects }, null, 2)}\n`;
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

  get(projectRoot: string): string | undefined {
    this.load();
    return this.projects.get(normalizeRoot(projectRoot, this.p));
  }

  set(projectRoot: string, absPath: string): string {
    this.load();
    if (typeof absPath !== "string" || absPath.trim() === "") {
      throw new CommandEnvError("Jalur harus berupa teks yang tidak kosong.");
    }
    const raw = expandHome(absPath.trim(), this.p, this.platform);
    if (!this.p.isAbsolute(raw)) {
      throw new CommandEnvError("Jalur berkas env harus absolut.");
    }
    const logical = this.p.resolve(raw);
    let real: string;
    try {
      real = realpathSync(logical);
    } catch {
      throw new CommandEnvError("Berkas env tidak ditemukan.");
    }
    let info;
    try {
      info = statSync(real);
    } catch {
      throw new CommandEnvError("Berkas env tidak bisa dibaca.");
    }
    if (!info.isFile()) {
      throw new CommandEnvError("Jalur env harus berupa berkas biasa.");
    }
    if (info.size > MAX_ENV_BYTES) {
      throw new CommandEnvError("Berkas env terlalu besar (maks 256 KB).");
    }
    try {
      readFileSync(real);
    } catch {
      throw new CommandEnvError("Berkas env tidak bisa dibaca.");
    }

    const rootNorm = normalizeRoot(projectRoot, this.p);
    if (!this.projects.has(rootNorm) && this.projects.size >= MAX_PROJECTS) {
      throw new CommandEnvError(`Batas ${MAX_PROJECTS} proyek env perintah terlampaui.`);
    }
    this.projects.set(rootNorm, real);
    this.persist();
    return real;
  }

  clear(projectRoot: string): boolean {
    this.load();
    const rootNorm = normalizeRoot(projectRoot, this.p);
    if (!this.projects.delete(rootNorm)) return false;
    this.persist();
    return true;
  }
}

/** Nilai yang jelas bukan rahasia (sama seperti `collectEnvValues`). */
function isPlaceholderValue(value: string): boolean {
  if (value.startsWith("[disembunyikan:")) return true;
  const lower = value.toLowerCase();
  if (lower === "changeme") return true;
  if (lower.startsWith("your-")) return true;
  if (value.startsWith("<") && value.endsWith(">")) return true;
  if (value.startsWith("${")) return true;
  if (/^x{8,}$/i.test(value)) return true;
  if (/^\*{8,}$/.test(value)) return true;
  if (/(?:example|dummy|placeholder)/i.test(value)) return true;
  return false;
}

/**
 * Baca berkas `.env` sederhana: baris `KEY=VALUE` / `export KEY=VALUE`,
 * komentar dilewati, tanda petik dihormati.
 *
 * `values` hanya nilai yang layak disamarkan (≥4 karakter, bukan angka murni
 * atau placeholder). `env` memuat semua pasangan kunci-nilai yang valid (nilai
 * kosong dilewati). Galat baca dilempar ke pemanggil.
 */
export function readCommandEnv(path: string): {
  keys: string[];
  values: string[];
  env: Record<string, string>;
} {
  const text = readFileSync(path, "utf8");
  const keys: string[] = [];
  const values: string[] = [];
  const env: Record<string, string> = {};
  const seenKeys = new Set<string>();
  const seenValues = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    line = line.replace(/^export\s+/, "").trim();
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(equals + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value.charAt(0);
      const close = value.indexOf(quote, 1);
      value = close > 0 ? value.slice(1, close) : value.slice(1);
    } else {
      const comment = value.indexOf(" #");
      if (comment >= 0) value = value.slice(0, comment).trim();
    }

    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      keys.push(key);
      if (value !== "") env[key] = value;
    }
    if (value.length < 4) continue;
    if (/^\d+$/.test(value)) continue;
    if (/^(?:true|false|null|undefined)$/i.test(value)) continue;
    if (isPlaceholderValue(value)) continue;
    if (seenValues.has(value)) continue;
    seenValues.add(value);
    values.push(value);
  }

  return { keys, values, env };
}
