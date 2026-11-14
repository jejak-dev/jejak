import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isWindows, pathApi, type PathApi } from "../platform";
import { jejakHome } from "../provider-store";
import { checkSecretAccess } from "./secret-paths";

/** Daftar izin berkas rahasia per akar proyek (disimpan di luar proyek). */
export interface SecretAllowStore {
  /** Jalur relatif POSIX terurut untuk satu akar proyek. */
  list(projectRoot: string): string[];
  isAllowed(projectRoot: string, absPath: string): boolean;
  /** Melempar `SecretAllowError` bila jalur tidak valid / tidak dibatasi. */
  add(projectRoot: string, path: string): { path: string; rule: string };
  /** `true` bila ada entri yang dihapus. */
  remove(projectRoot: string, path: string): boolean;
}

export class SecretAllowError extends Error {
  readonly code = "tidak-valid" as const;

  constructor(message: string) {
    super(message);
    this.name = "SecretAllowError";
  }
}

export const SECRET_ALLOW_VERSION = 1;
export const MAX_PATHS_PER_PROJECT = 100;
export const MAX_PROJECTS = 200;

const OUTSIDE_MESSAGE = "Jalur harus berada di dalam proyek.";
const NOT_SECRET_MESSAGE = "Jalur ini tidak dibatasi kebijakan rahasia.";
const TOO_MANY_PATHS = `Batas ${MAX_PATHS_PER_PROJECT} jalur izin per proyek terlampaui.`;
const TOO_MANY_PROJECTS = `Batas ${MAX_PROJECTS} proyek izin rahasia terlampaui.`;

export function secretAllowPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "secret-allow.json");
}

export function defaultSecretAllowStore(
  env: Record<string, string | undefined> = process.env,
): SecretAllowStore | undefined {
  if (
    env.JEJAK_SECRET_BLOCK?.trim() === "0" ||
    env.JEJAK_PERSIST?.trim() === "0"
  ) {
    return undefined;
  }
  return new FileSecretAllowStore(secretAllowPath(env));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(value: string, p: PathApi): string {
  return value.split(p.sep).join("/");
}

function normalizeRoot(root: string, p: PathApi): string {
  const resolved = p.resolve(root);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function normalizePath(path: string, p: PathApi): string {
  const resolved = p.resolve(path);
  try {
    if (existsSync(resolved)) return realpathSync(resolved);
  } catch {
    // Argumen bisa menghilang di tengah jalan; pakai jalur logis.
  }
  return resolved;
}

function expandHome(raw: string, p: PathApi, platform: NodeJS.Platform): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return p.resolve(homedir(), raw.slice(2));
  // Di Windows "~\\AppData\\..." juga berarti folder home.
  if (isWindows(platform) && raw.startsWith("~\\")) return p.resolve(homedir(), raw.slice(2));
  return raw;
}

/** Jalur relatif POSIX bila berada di dalam `rootNorm`, selain itu undefined. */
function relativeInside(rootNorm: string, absPath: string, p: PathApi): string | undefined {
  const rel = p.relative(rootNorm, absPath);
  if (rel === "" || rel.startsWith("..") || p.isAbsolute(rel)) return undefined;
  return toPosix(rel, p);
}

function sanitizeLoaded(value: unknown, p: PathApi): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "") continue;
    if (p.isAbsolute(item) || item === ".." || item.startsWith("../")) continue;
    if (!paths.includes(item)) paths.push(item);
  }
  return paths.length === 0 ? undefined : paths.sort();
}

/** Opsi penyimpanan izin rahasia. */
export interface SecretAllowStoreOptions {
  /** Platform untuk resolusi path; default `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Penyimpanan berkas JSON atomik; `:memory:` untuk tes tanpa berkas. */
export class FileSecretAllowStore implements SecretAllowStore {
  private readonly path: string;
  private readonly inMemory: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly p: PathApi;
  private readonly projects = new Map<string, string[]>();
  private loaded = false;

  constructor(path: string, options: SecretAllowStoreOptions = {}) {
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
      // sampai ada `add` pertama.
      if (!isRecord(parsed) || parsed.version !== SECRET_ALLOW_VERSION) return;
      if (!isRecord(parsed.projects)) return;
      for (const [root, value] of Object.entries(parsed.projects)) {
        const paths = sanitizeLoaded(value, this.p);
        if (paths !== undefined) this.projects.set(root, paths);
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

    const projects: Record<string, string[]> = {};
    for (const root of Array.from(this.projects.keys()).sort()) {
      const paths = this.projects.get(root);
      if (paths !== undefined && paths.length > 0) {
        projects[root] = [...paths].sort();
      }
    }
    const body = `${JSON.stringify({ version: SECRET_ALLOW_VERSION, projects }, null, 2)}\n`;
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

  list(projectRoot: string): string[] {
    this.load();
    const paths = this.projects.get(normalizeRoot(projectRoot, this.p));
    return paths === undefined ? [] : [...paths];
  }

  isAllowed(projectRoot: string, absPath: string): boolean {
    try {
      this.load();
      const rootNorm = normalizeRoot(projectRoot, this.p);
      const paths = this.projects.get(rootNorm);
      if (paths === undefined || paths.length === 0) return false;
      if (typeof absPath !== "string" || absPath === "") return false;
      const abs = normalizePath(
        this.p.isAbsolute(absPath) ? absPath : this.p.join(rootNorm, absPath),
        this.p,
      );
      const rel = relativeInside(rootNorm, abs, this.p);
      return rel !== undefined && paths.includes(rel);
    } catch {
      return false;
    }
  }

  add(projectRoot: string, path: string): { path: string; rule: string } {
    this.load();
    if (typeof path !== "string" || path.trim() === "") {
      throw new SecretAllowError("Jalur harus berupa teks yang tidak kosong.");
    }
    const rootNorm = normalizeRoot(projectRoot, this.p);
    const raw = expandHome(path.trim(), this.p, this.platform);
    const logical = this.p.isAbsolute(raw)
      ? this.p.resolve(raw)
      : this.p.resolve(rootNorm, raw);
    const abs = normalizePath(logical, this.p);
    const rel = relativeInside(rootNorm, abs, this.p);
    if (rel === undefined) {
      throw new SecretAllowError(OUTSIDE_MESSAGE);
    }

    const verdict = checkSecretAccess(
      {
        toolName: "Read",
        toolInput: { file_path: abs },
        cwd: rootNorm,
      },
      { platform: this.platform },
    );
    if (!verdict.blocked || verdict.rule === undefined) {
      throw new SecretAllowError(NOT_SECRET_MESSAGE);
    }
    const rule = verdict.rule;

    const existing = this.projects.get(rootNorm);
    if (existing === undefined) {
      if (this.projects.size >= MAX_PROJECTS) {
        throw new SecretAllowError(TOO_MANY_PROJECTS);
      }
      this.projects.set(rootNorm, [rel]);
      this.persist();
      return { path: rel, rule };
    }
    if (existing.includes(rel)) {
      return { path: rel, rule };
    }
    if (existing.length >= MAX_PATHS_PER_PROJECT) {
      throw new SecretAllowError(TOO_MANY_PATHS);
    }
    existing.push(rel);
    existing.sort();
    this.persist();
    return { path: rel, rule };
  }

  remove(projectRoot: string, path: string): boolean {
    this.load();
    if (typeof path !== "string" || path.trim() === "") return false;
    const rootNorm = normalizeRoot(projectRoot, this.p);
    const existing = this.projects.get(rootNorm);
    if (existing === undefined) return false;

    const raw = expandHome(path.trim(), this.p, this.platform);
    const logical = this.p.isAbsolute(raw)
      ? this.p.resolve(raw)
      : this.p.resolve(rootNorm, raw);
    const rel = relativeInside(rootNorm, normalizePath(logical, this.p), this.p);
    if (rel === undefined) return false;

    const index = existing.indexOf(rel);
    if (index === -1) return false;
    existing.splice(index, 1);
    if (existing.length === 0) {
      this.projects.delete(rootNorm);
    }
    this.persist();
    return true;
  }
}
