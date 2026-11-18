import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { jejakHome } from "../provider-store";
import { resolveManagedCli } from "./cli-store";
import { sdkRoot } from "./sdk-store";

/**
 * Pencari CLI `claude` milik pengguna.
 *
 * Di binary terkompilasi SDK Agent tidak bisa menemukan CLI `claude` sendiri,
 * jadi Jejak mencarinya lalu meneruskannya lewat opsi SDK
 * `pathToClaudeCodeExecutable`.
 *
 * Urutan sumber: variabel env, berkas pengaturan Jejak, CLI bawaan SDK
 * yang terkelola, `PATH` sistem, lalu lokasi umum. Tidak ada shell yang
 * dijalankan: hanya `claude --version` dengan argumen array.
 */

/** Variabel env untuk menunjuk CLI `claude` milik pengguna. */
export const CLAUDE_PATH_ENV = "JEJAK_CLAUDE_PATH";

/** Nama berkas pengaturan di dalam JEJAK_HOME. */
export const CLAUDE_SETTING_FILE = "claude-path.json";

/** Umur cache hasil pencarian; 30 detik. */
export const CLAUDE_CACHE_TTL_MS = 30_000;

/** Batas panjang jalur yang diterima; mencegah jalur raksasa. */
const MAX_PATH_LENGTH = 1024;

/** Sumber penemuan CLI; menentukan apakah jalur diteruskan ke SDK. */
export type ClaudeSource = "env" | "setting" | "managed" | "path" | "common";

/** Hasil pencarian CLI `claude`. */
export interface ClaudeLocation {
  path: string;
  version: string;
  source: ClaudeSource;
}

/** Opsi pencarian; semua dapat diinjeksi untuk pengujian. */
export interface LocateOptions {
  /** Env untuk mencari variabel dan JEJAK_HOME; bawaan `process.env`. */
  env?: Record<string, string | undefined>;
  /** Pencari di PATH; bawaan `Bun.which`. */
  which?: (name: string) => string | null;
  /** Pemeriksa keberadaan berkas; bawaan `stat`. */
  exists?: (path: string) => Promise<boolean>;
  /** Pembaca versi; bawaan `defaultRunVersion`. */
  runVersion?: (path: string, timeoutMs: number) => Promise<string | null>;
  /**
   * Pencari CLI bawaan SDK yang terkelola.
   *
   * Bawaan membaca `<JEJAK_HOME>/sdk/<versi>/cli/`; binary di dalamnya
   * lalu diperiksa `--version` seperti kandidat lain.
   */
  managed?: () => Promise<{ path: string; version: string } | null>;
  /** Home pengguna; bawaan `os.homedir()`. */
  home?: string;
  /** Platform; bawaan `process.platform`. */
  platform?: NodeJS.Platform;
  /** Batas waktu `--version` dalam milidetik; bawaan 5000. */
  timeoutMs?: number;
}

/** Hasil pemeriksaan jalur. */
export type ClaudePathCheck = { ok: true } | { ok: false; reason: string };

/** Lokasi berkas pengaturan jalur CLI. */
export function claudeSettingPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jejakHome(env), CLAUDE_SETTING_FILE);
}

/**
 * Baca jalur dari berkas pengaturan.
 *
 * Berkas tak ada, rusak, atau isinya bukan string -> `null`, bukan melempar.
 */
export async function readClaudeSetting(
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(claudeSettingPath(env), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const value = (parsed as { path?: unknown }).path;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed;
}

/**
 * Tulis jalur ke berkas pengaturan; `null` menghapus berkas.
 *
 * Tulis atomik (berkas sementara lalu rename), mode berkas 0600 dan mode
 * direktori 0700 supaya jalur CLI tidak bocor ke pengguna lain.
 */
export async function writeClaudeSetting(
  path: string | null,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const target = claudeSettingPath(env);
  if (path === null) {
    await rm(target, { force: true });
    return;
  }
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const temp = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`;
  const body = `${JSON.stringify({ path }, null, 2)}\n`;
  try {
    await writeFile(temp, body, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, target);
  } catch (error) {
    try {
      await rm(temp, { force: true });
    } catch {
      // Berkas sementara mungkin sudah tidak ada; galat asli yang dilempar.
    }
    throw error;
  }
  await chmod(target, 0o600);
}

/**
 * Periksa apakah jalur aman dipakai.
 *
 * Jalur relatif ditolak; karakter kontrol/NUL dan jalur kepanjangan juga
 * ditolak supaya tidak bisa menyelinap ke argumen proses.
 */
export function validateClaudePath(path: unknown): ClaudePathCheck {
  if (typeof path !== "string") return { ok: false, reason: "bukan-teks" };
  if (path.length > MAX_PATH_LENGTH) return { ok: false, reason: "terlalu-panjang" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return { ok: false, reason: "karakter-kontrol" };
  }
  if (!isAbsolute(path)) return { ok: false, reason: "bukan-absolut" };
  return { ok: true };
}

/**
 * Ganti shim npm Windows (`claude.cmd`/`.bat`) dengan target aslinya.
 *
 * SDK menjalankan `pathToClaudeCodeExecutable` tanpa shell, dan Windows
 * menolak men-spawn `.cmd` secara langsung (`spawn ... EINVAL`). Shim npm
 * berdampingan dengan `node_modules\@anthropic-ai\claude-code`; pakai
 * `bin\claude.exe` bila ada, lalu `cli.js`. Tanpa target yang ditemukan,
 * jalur asli dikembalikan.
 */
export async function resolveWindowsShim(
  path: string,
  exists: (path: string) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(path)) return path;
  const base = win32.join(win32.dirname(path), "node_modules", "@anthropic-ai", "claude-code");
  for (const target of [win32.join(base, "bin", "claude.exe"), win32.join(base, "cli.js")]) {
    try {
      if (await exists(target)) return target;
    } catch {
      // Lanjut ke kandidat berikutnya.
    }
  }
  return path;
}

/** Lokasi umum CLI `claude` milik pengguna. */
export function commonClaudePaths(
  home: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") {
    return [
      join(home, ".local", "bin", "claude.exe"),
      join(home, "AppData", "Roaming", "npm", "claude.cmd"),
      join(home, ".claude", "local", "claude.exe"),
    ];
  }
  return [
    join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".claude", "local", "claude"),
  ];
}

/** Presence check bawaan: berkas benar-benar ada. */
export async function defaultExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Pencari PATH bawaan. */
function defaultWhich(name: string): string | null {
  try {
    return Bun.which(name);
  } catch {
    return null;
  }
}

/**
 * Baca versi CLI lewat `claude --version`.
 *
 * Tidak pernah melempar. Timeout -> proses dibunuh dan hasilnya `null`;
 * kode keluar bukan 0 -> `null`; keluaran tanpa pola versi -> `null`.
 */
export async function defaultRunVersion(
  path: string,
  timeoutMs: number,
): Promise<string | null> {
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([path, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Proses mungkin sudah selesai; hasil tetap `null`.
    }
  }, timeoutMs);
  try {
    const code = await proc.exited;
    if (timedOut) return null;
    if (code !== 0) return null;
    let out = "";
    try {
      out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    } catch {
      return null;
    }
    const trimmed = out.trim();
    if (trimmed.length > 200) return trimmed.slice(0, 200);
    if (!/\d+\.\d+\.\d+/.test(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pencari CLI bawaan SDK yang terkelola.
 *
 * Sumber tunggalnya adalah `<JEJAK_HOME>/sdk/<versi>/cli/`. Binary di
 * dalamnya tetap diperiksa `--version` oleh loop kandidat.
 */
async function defaultManagedLookup(
  env: Record<string, string | undefined>,
): Promise<{ path: string; version: string } | null> {
  try {
    const found = await resolveManagedCli(sdkRoot(env));
    if (found === null) return null;
    return { path: found.path, version: found.version };
  } catch {
    return null;
  }
}

/**
 * Cari CLI `claude` milik pengguna.
 *
 * Setiap kandidat harus lolos pemeriksaan jalur, benar-benar ada, dan
 * menjawab `--version`. Kandidat eksplisit (env/pengaturan) yang gagal
 * tidak menggagalkan pencarian: pencarian lanjut, dan hasil akhirnya tetap
 * membawa sumber yang benar. Tidak pernah melempar.
 */
export async function locateClaude(
  options: LocateOptions = {},
): Promise<ClaudeLocation | null> {
  const env = options.env ?? process.env;
  const which = options.which ?? defaultWhich;
  const exists = options.exists ?? defaultExists;
  const runVersion = options.runVersion ?? defaultRunVersion;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 5000;

  const candidates: { path: string; source: ClaudeSource }[] = [];

  const envValue = env[CLAUDE_PATH_ENV]?.trim() ?? "";
  if (envValue !== "") candidates.push({ path: envValue, source: "env" });

  const setting = await readClaudeSetting(env);
  if (setting !== null) candidates.push({ path: setting, source: "setting" });

  // CLI bawaan SDK terkelola: hanya dibaca dari penyimpanan SDK.
  const managedLookup = options.managed ?? ((): Promise<{ path: string; version: string } | null> =>
    defaultManagedLookup(env));
  let managed: { path: string; version: string } | null = null;
  try {
    managed = await managedLookup();
  } catch {
    managed = null;
  }
  if (managed !== null && managed.path.trim() !== "") {
    candidates.push({ path: managed.path, source: "managed" });
  }

  const fromPath = which("claude");
  if (fromPath !== null && fromPath !== "") {
    candidates.push({ path: fromPath, source: "path" });
  }

  for (const common of commonClaudePaths(home, platform)) {
    candidates.push({ path: common, source: "common" });
  }

  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (tried.has(candidate.path)) continue;
    tried.add(candidate.path);
    const check = validateClaudePath(candidate.path);
    if (!check.ok) continue;
    let present: boolean;
    try {
      present = await exists(candidate.path);
    } catch {
      continue;
    }
    if (!present) continue;
    let version: string | null;
    try {
      version = await runVersion(candidate.path, timeoutMs);
    } catch {
      continue;
    }
    if (version === null) continue;
    const resolved = await resolveWindowsShim(candidate.path, exists, platform);
    return { path: resolved, version, source: candidate.source };
  }
  return null;
}

interface CacheSlot {
  at: number;
  location: ClaudeLocation;
}

const cache = new Map<string, CacheSlot>();

let cacheCounter = 0;

/** Kunci cache unik untuk satu pemanggil (rute atau runner). */
export function nextClaudeCacheKey(prefix: string): string {
  cacheCounter += 1;
  return `${prefix}-${cacheCounter}`;
}

/**
 * Cache hasil pencarian selama 30 detik.
 *
 * Hanya hasil non-null yang disimpan; `null` tidak di-cache supaya
 * pemeriksaan berikutnya tetap bisa menemukan CLI yang baru dipasang.
 */
export async function cachedClaude(
  key: string,
  lookup: () => Promise<ClaudeLocation | null>,
  now: () => number = Date.now,
): Promise<ClaudeLocation | null> {
  const hit = cache.get(key);
  if (hit !== undefined && now() - hit.at < CLAUDE_CACHE_TTL_MS) return hit.location;
  const location = await lookup();
  if (location === null) {
    cache.delete(key);
    return null;
  }
  cache.set(key, { at: now(), location });
  return location;
}

/** Buang cache pencarian; dipanggil saat pengaturan jalur berubah. */
export function invalidateClaudeCache(): void {
  cache.clear();
}
