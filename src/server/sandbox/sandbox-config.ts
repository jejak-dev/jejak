import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { jejakHome } from "../provider-store";

export type SandboxMode = "standar" | "mati";

/** Pengaturan sandbox Bash per instalasi Jejak. */
export interface SandboxConfig {
  mode: SandboxMode;
  /** Domain tambahan dari pengguna; domain bawaan ada di kode. */
  allowedDomains: string[];
  extraDenyRead: string[];
  extraDenyWrite: string[];
  /** Jalur tulis tambahan di luar folder kerja. */
  extraAllowWrite: string[];
  /** Jalur socket Unix yang boleh dipakai Bash. */
  extraAllowUnixSockets: string[];
  /** Izinkan bind port localhost (macOS). */
  allowLocalBinding: boolean;
}

export interface SandboxStore {
  get(): SandboxConfig;
  /** Patch atomik: seluruh nilai divalidasi sebelum disimpan. */
  set(patch: Partial<SandboxConfig>): SandboxConfig;
}

export class SandboxConfigError extends Error {
  readonly code = "tidak-valid" as const;

  constructor(message: string) {
    super(message);
    this.name = "SandboxConfigError";
  }
}

export const SANDBOX_CONFIG_VERSION = 1;
export const MAX_LIST_ENTRIES = 100;
export const MAX_PATH_LENGTH = 500;
export const SANDBOX_MODES: readonly SandboxMode[] = ["standar", "mati"];
export const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultConfig(): SandboxConfig {
  return {
    mode: "standar",
    allowedDomains: [],
    extraDenyRead: [],
    extraDenyWrite: [],
    extraAllowWrite: [],
    extraAllowUnixSockets: [],
    allowLocalBinding: false,
  };
}

export function copySandboxConfig(config: SandboxConfig): SandboxConfig {
  return {
    mode: config.mode,
    allowedDomains: [...config.allowedDomains],
    extraDenyRead: [...config.extraDenyRead],
    extraDenyWrite: [...config.extraDenyWrite],
    extraAllowWrite: [...config.extraAllowWrite],
    extraAllowUnixSockets: [...config.extraAllowUnixSockets],
    allowLocalBinding: config.allowLocalBinding,
  };
}

function validateMode(value: unknown): SandboxMode {
  if (value !== "standar" && value !== "mati") {
    throw new SandboxConfigError('Mode sandbox hanya "standar" atau "mati".');
  }
  return value;
}

function validateDomain(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SandboxConfigError("Domain harus berupa teks.");
  }
  const value = raw.trim();
  if (value === "") {
    throw new SandboxConfigError("Domain tidak boleh kosong.");
  }
  const body = value.startsWith("*.") ? value.slice(2) : value;
  if (!DOMAIN_PATTERN.test(body)) {
    throw new SandboxConfigError(
      "Domain tidak valid; pakai huruf kecil tanpa skema, jalur, atau port.",
    );
  }
  return value;
}

function validatePath(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new SandboxConfigError("Jalur harus berupa teks.");
  }
  const value = raw.trim();
  if (value === "") {
    throw new SandboxConfigError("Jalur tidak boleh kosong.");
  }
  if (value.length > MAX_PATH_LENGTH) {
    throw new SandboxConfigError(`Jalur maksimal ${MAX_PATH_LENGTH} karakter.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new SandboxConfigError("Jalur tidak boleh memuat karakter kontrol.");
  }
  if (!value.startsWith("/") && !value.startsWith("~/")) {
    throw new SandboxConfigError("Jalur harus absolut atau diawali ~/.");
  }
  if (value.split("/").includes("..")) {
    throw new SandboxConfigError("Jalur tidak boleh memuat segmen ..");
  }
  return value;
}

/** Jalur tulis tambahan tidak boleh berupa akar atau home utuh. */
function validateAllowWritePath(raw: unknown): string {
  const value = validatePath(raw);
  if (value === "/" || value === "~" || value === "~/") {
    throw new SandboxConfigError("Jalur tulis tidak boleh akar atau home utuh.");
  }
  return value;
}

/** Socket Unix tidak boleh berupa akar/home utuh maupun memuat wildcard. */
function validateUnixSocketPath(raw: unknown): string {
  const value = validateAllowWritePath(raw);
  if (value.includes("*") || value.includes("?")) {
    throw new SandboxConfigError("Jalur socket tidak boleh memuat wildcard.");
  }
  return value;
}

function validateList(
  raw: unknown,
  label: string,
  validate: (value: unknown) => string,
): string[] {
  if (!Array.isArray(raw)) {
    throw new SandboxConfigError(`${label} harus berupa daftar.`);
  }
  if (raw.length > MAX_LIST_ENTRIES) {
    throw new SandboxConfigError(`Batas ${MAX_LIST_ENTRIES} entri ${label} terlampaui.`);
  }
  const result: string[] = [];
  for (const item of raw) {
    const value = validate(item);
    if (!result.includes(value)) result.push(value);
  }
  return result.sort();
}

/** Nilai berkas yang tak valid disaring tanpa menggagalkan pembacaan. */
function sanitizeList(
  raw: unknown,
  validate: (value: unknown) => string,
): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw) {
    try {
      const value = validate(item);
      if (!result.includes(value)) result.push(value);
    } catch {
      // Entri rusak dilewati.
    }
    if (result.length >= MAX_LIST_ENTRIES) break;
  }
  return result.sort();
}

export function sandboxConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), "sandbox.json");
}

export function defaultSandboxStore(
  env: Record<string, string | undefined> = process.env,
): SandboxStore | undefined {
  if (env.JEJAK_SANDBOX?.trim() === "0") return undefined;
  if (env.JEJAK_PERSIST?.trim() === "0") {
    return new FileSandboxStore(":memory:");
  }
  return new FileSandboxStore(sandboxConfigPath(env));
}

/** Penyimpanan berkas JSON atomik; `:memory:` untuk tes tanpa berkas. */
export class FileSandboxStore implements SandboxStore {
  private readonly path: string;
  private readonly inMemory: boolean;
  private config: SandboxConfig | undefined;
  private loaded = false;

  constructor(path: string) {
    this.path = path;
    this.inMemory = path === ":memory:" || path === "";
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.config = defaultConfig();
    if (this.inMemory) return;

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      // Berkas tak ada: default; berkas tak terbaca juga default dan tidak
      // ditimpa sampai ada `set` pertama.
      return;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      // Berkas rusak atau versi asing diperlakukan default.
      if (!isRecord(parsed) || parsed.version !== SANDBOX_CONFIG_VERSION) return;
      const mode =
        parsed.mode === "standar" || parsed.mode === "mati" ? parsed.mode : "standar";
      this.config = {
        mode,
        allowedDomains: sanitizeList(parsed.allowedDomains, validateDomain),
        extraDenyRead: sanitizeList(parsed.extraDenyRead, validatePath),
        extraDenyWrite: sanitizeList(parsed.extraDenyWrite, validatePath),
        extraAllowWrite: sanitizeList(parsed.extraAllowWrite, validateAllowWritePath),
        extraAllowUnixSockets: sanitizeList(
          parsed.extraAllowUnixSockets,
          validateUnixSocketPath,
        ),
        allowLocalBinding: parsed.allowLocalBinding === true,
      };
    } catch {
      // JSON rusak: pakai default.
    }
  }

  private persist(config: SandboxConfig): void {
    if (this.inMemory) return;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Direktori induk bisa milik sistem; berkas tetap 0600 di bawah.
    }

    const body = `${JSON.stringify(
      {
        version: SANDBOX_CONFIG_VERSION,
        mode: config.mode,
        allowedDomains: [...config.allowedDomains].sort(),
        extraDenyRead: [...config.extraDenyRead].sort(),
        extraDenyWrite: [...config.extraDenyWrite].sort(),
        extraAllowWrite: [...config.extraAllowWrite].sort(),
        extraAllowUnixSockets: [...config.extraAllowUnixSockets].sort(),
        allowLocalBinding: config.allowLocalBinding,
      },
      null,
      2,
    )}\n`;
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

  get(): SandboxConfig {
    this.load();
    return copySandboxConfig(this.config ?? defaultConfig());
  }

  set(patch: Partial<SandboxConfig>): SandboxConfig {
    if (!isRecord(patch)) {
      throw new SandboxConfigError("Pengaturan sandbox tidak valid.");
    }
    this.load();
    const next = copySandboxConfig(this.config ?? defaultConfig());

    // Validasi seluruh patch dulu; baru terapkan agar atomik.
    let mode: SandboxMode | undefined;
    let allowedDomains: string[] | undefined;
    let extraDenyRead: string[] | undefined;
    let extraDenyWrite: string[] | undefined;
    let extraAllowWrite: string[] | undefined;
    let extraAllowUnixSockets: string[] | undefined;
    let allowLocalBinding: boolean | undefined;
    if (patch.mode !== undefined) {
      mode = validateMode(patch.mode);
    }
    if (patch.allowedDomains !== undefined) {
      allowedDomains = validateList(patch.allowedDomains, "domain", validateDomain);
    }
    if (patch.extraDenyRead !== undefined) {
      extraDenyRead = validateList(patch.extraDenyRead, "jalur baca", validatePath);
    }
    if (patch.extraDenyWrite !== undefined) {
      extraDenyWrite = validateList(patch.extraDenyWrite, "jalur tulis", validatePath);
    }
    if (patch.extraAllowWrite !== undefined) {
      extraAllowWrite = validateList(
        patch.extraAllowWrite,
        "jalur tulis tambahan",
        validateAllowWritePath,
      );
    }
    if (patch.extraAllowUnixSockets !== undefined) {
      extraAllowUnixSockets = validateList(
        patch.extraAllowUnixSockets,
        "socket Unix",
        validateUnixSocketPath,
      );
    }
    if (patch.allowLocalBinding !== undefined) {
      if (typeof patch.allowLocalBinding !== "boolean") {
        throw new SandboxConfigError("allowLocalBinding harus berupa boolean.");
      }
      allowLocalBinding = patch.allowLocalBinding;
    }

    if (mode !== undefined) next.mode = mode;
    if (allowedDomains !== undefined) next.allowedDomains = allowedDomains;
    if (extraDenyRead !== undefined) next.extraDenyRead = extraDenyRead;
    if (extraDenyWrite !== undefined) next.extraDenyWrite = extraDenyWrite;
    if (extraAllowWrite !== undefined) next.extraAllowWrite = extraAllowWrite;
    if (extraAllowUnixSockets !== undefined) {
      next.extraAllowUnixSockets = extraAllowUnixSockets;
    }
    if (allowLocalBinding !== undefined) next.allowLocalBinding = allowLocalBinding;

    this.config = next;
    this.persist(next);
    return copySandboxConfig(next);
  }
}

/** Dipakai tes/diagnostik: apakah berkas konfigurasi ada. */
export function sandboxConfigFileExists(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return existsSync(sandboxConfigPath(env));
}
