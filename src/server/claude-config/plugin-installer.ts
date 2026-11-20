import { PLUGIN_ID_PATTERN } from "./plugins";
import { scrubEnv } from "../terminal/terminal-manager";

/** Hasil satu perintah pemasangan atau pencabutan plugin. */
export interface PluginCommandResult {
  ok: boolean;
  message: string;
}

/** Pemasang plugin; memakai CLI `claude` milik pengguna. */
export interface PluginInstaller {
  install(id: string): Promise<PluginCommandResult>;
  uninstall(id: string): Promise<PluginCommandResult>;
  /** Daftarkan marketplace dari URL GitHub atau bentuk `owner/repo`. */
  addMarketplace(source: string): Promise<PluginCommandResult>;
}

/** Hasil menjalankan satu proses. */
export interface PluginSpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Opsi menjalankan proses; tanpa shell, argumen sebagai array. */
export interface PluginSpawnOptions {
  env: Record<string, string>;
  timeoutMs: number;
}

/** Penjalan proses; dapat diinjeksi untuk pengujian. */
export type PluginSpawn = (
  cmd: string[],
  opts: PluginSpawnOptions,
) => Promise<PluginSpawnResult>;

/** Opsi pemasangan plugin. */
export interface PluginInstallerOptions {
  /** Pencari CLI `claude`; `null` bila CLI tak ada. */
  locate: () => Promise<{ path: string } | null>;
  /** Penjalan proses; bawaan memakai `Bun.spawn`. */
  spawn?: PluginSpawn;
  /** Home pengguna; dipakai sebagai `HOME` proses CLI. */
  home?: string;
  /** Env proses yang jadi dasar env anak; bawaan `process.env`. */
  env?: Record<string, string | undefined>;
  /** Batas waktu satu perintah; bawaan 120 detik. */
  timeoutMs?: number;
}

export const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

/** Tambahan waktu sebelum installer menyerah menunggu proses. */
const TIMEOUT_GRACE_MS = 500;

/** Batas panjang keluaran yang diteruskan ke pengguna. */
const MAX_OUTPUT_LENGTH = 2000;

/** Awalan env yang dipakai Jejak atau penyedia model; tak diteruskan. */
const PROVIDER_PREFIX = /^(JEJAK_|ANTHROPIC_|OPENAI_|DEEPSEEK_)/;

const BUSY_MESSAGE = "Masih ada pemasangan lain berjalan.";
const NOT_FOUND_MESSAGE =
  "CLI claude tidak ditemukan. Pasang Claude Code dulu atau atur jalurnya di Pengaturan.";

/** Hasil pembacaan sumber marketplace. */
export type MarketplaceSourceResult =
  | { ok: true; /** Sumber ternormalisasi, mis. `https://github.com/o/r`. */ source: string }
  | { ok: false; error: string };

/** Awalan URL GitHub yang diterima; hanya https. */
const GITHUB_PREFIX = "https://github.com/";
/** Satu ruas owner atau repo. */
const OWNER_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
/** Spasi atau karakter kontrol; tak diterima di sumber mana pun. */
const BAD_CHARS_PATTERN = /[\s\u0000-\u001f\u007f]/;

/**
 * Normalkan sumber marketplace menjadi URL GitHub `https://github.com/o/r`.
 *
 * Menerima hanya `https://github.com/<owner>/<repo>` (akhiran `.git` atau `/`
 * opsional) dan bentuk pendek `<owner>/<repo>`. Skema lain, path lokal,
 * awalan `-`, spasi, dan karakter kontrol ditolak sebelum CLI dijalankan.
 */
export function parseMarketplaceSource(text: string): MarketplaceSourceResult {
  if (typeof text !== "string") {
    return { ok: false, error: "Sumber marketplace tidak valid." };
  }
  if (text === "") {
    return { ok: false, error: "Sumber marketplace kosong." };
  }
  if (BAD_CHARS_PATTERN.test(text)) {
    return { ok: false, error: "Sumber marketplace tak boleh memuat spasi atau karakter kontrol." };
  }
  if (text.startsWith("-")) {
    return { ok: false, error: "Sumber marketplace tak boleh diawali tanda minus." };
  }

  let bagian = text;
  if (text.startsWith(GITHUB_PREFIX)) {
    bagian = text.slice(GITHUB_PREFIX.length);
  } else if (text.includes("://") || text.includes(":")) {
    return { ok: false, error: "Hanya URL GitHub https://github.com/<owner>/<repo> yang diterima." };
  }
  if (bagian.endsWith("/")) bagian = bagian.slice(0, -1);
  if (bagian.toLowerCase().endsWith(".git")) bagian = bagian.slice(0, -4);

  const pisah = bagian.indexOf("/");
  if (pisah <= 0) {
    return { ok: false, error: "Sumber marketplace harus berbentuk owner/repo." };
  }
  const owner = bagian.slice(0, pisah);
  const repo = bagian.slice(pisah + 1);
  if (!OWNER_REPO_PATTERN.test(owner) || !OWNER_REPO_PATTERN.test(repo)) {
    return { ok: false, error: "Sumber marketplace harus berbentuk owner/repo." };
  }
  return { ok: true, source: `${GITHUB_PREFIX}${owner}/${repo}` };
}

/**
 * Env untuk proses CLI: tanpa kunci Jejak dan penyedia model.
 *
 * Env proses disalin apa adanya, lalu semua variabel berawalan
 * `JEJAK_`, `ANTHROPIC_`, `OPENAI_`, atau `DEEPSEEK_` dibuang. Ini mencegah
 * kunci API milik Jejak bocor ke proses pihak ketiga.
 */
export function pluginEnv(
  env: Record<string, string | undefined>,
  home?: string,
): Record<string, string> {
  const scrubbed = scrubEnv(env);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(scrubbed)) {
    if (PROVIDER_PREFIX.test(name)) continue;
    result[name] = value;
  }
  if (home !== undefined && home !== "") {
    result.HOME = home;
    result.USERPROFILE = home;
  }
  return result;
}

/** Buang karakter kontrol dari keluaran proses; potong panjangnya. */
export function sanitizeOutput(text: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  const trimmed = cleaned.trim();
  return trimmed.length > MAX_OUTPUT_LENGTH ? trimmed.slice(0, MAX_OUTPUT_LENGTH) : trimmed;
}

/** Penjalan bawaan: `Bun.spawn` tanpa shell, stdin ditutup. */
async function defaultSpawn(
  cmd: string[],
  opts: PluginSpawnOptions,
): Promise<PluginSpawnResult> {
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(cmd, {
      env: opts.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "galat tak diketahui";
    return { code: 127, stdout: "", stderr: message };
  }
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // Proses mungkin sudah selesai; galat asli yang dilaporkan.
    }
  }, opts.timeoutMs);
  try {
    const code = await proc.exited;
    const stdout = await readStream(proc.stdout);
    const stderr = await readStream(proc.stderr);
    return { code, stdout, stderr };
  } catch {
    return { code: 1, stdout: "", stderr: "Gagal menjalankan CLI claude." };
  } finally {
    clearTimeout(timer);
  }
}

async function readStream(stream: unknown): Promise<string> {
  try {
    return await new Response(stream as ReadableStream<Uint8Array>).text();
  } catch {
    return "";
  }
}

/** Menunggu hasil proses dengan batas waktu. */
async function withTimeout<T>(
  kerja: Promise<T>,
  timeoutMs: number,
): Promise<{ selesai: true; nilai: T } | { selesai: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const batas = new Promise<{ selesai: false }>((resolve) => {
    timer = setTimeout(() => resolve({ selesai: false }), timeoutMs);
  });
  try {
    return await Promise.race([kerja.then((nilai) => ({ selesai: true as const, nilai })), batas]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Pemasang plugin yang memakai CLI `claude` milik pengguna.
 *
 * Pemasangan berarti mengunduh kode pihak ketiga, jadi selalu dijalankan
 * atas permintaan eksplisit dan satu per satu: permintaan kedua saat satu
 * pemasangan berjalan ditolak.
 */
export function createPluginInstaller(options: PluginInstallerOptions): PluginInstaller {
  const spawn = options.spawn ?? defaultSpawn;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  let sibuk = false;

  async function jalankan(
    args: string[],
    sukses: string,
  ): Promise<PluginCommandResult> {
    if (sibuk) return { ok: false, message: BUSY_MESSAGE };
    sibuk = true;
    try {
      let ditemukan: { path: string } | null = null;
      try {
        ditemukan = await options.locate();
      } catch {
        ditemukan = null;
      }
      if (ditemukan === null || ditemukan.path.trim() === "") {
        return { ok: false, message: NOT_FOUND_MESSAGE };
      }
      const cmd = [ditemukan.path, ...args];
      const hasil = await withTimeout(
        spawn(cmd, { env: pluginEnv(env, options.home), timeoutMs }),
        timeoutMs + TIMEOUT_GRACE_MS,
      );
      if (!hasil.selesai) {
        return {
          ok: false,
          message: `CLI claude melewati batas waktu ${Math.round(timeoutMs / 1000)} detik.`,
        };
      }
      const { code, stdout, stderr } = hasil.nilai;
      const keluaran = sanitizeOutput(stdout);
      const galat = sanitizeOutput(stderr);
      if (code !== 0) {
        return {
          ok: false,
          message:
            galat !== ""
              ? `CLI claude gagal: ${galat}`
              : keluaran !== ""
                ? `CLI claude gagal: ${keluaran}`
                : `CLI claude berhenti dengan kode ${code}.`,
        };
      }
      return { ok: true, message: keluaran !== "" ? keluaran : sukses };
    } finally {
      sibuk = false;
    }
  }

  return {
    install: async (id) => {
      if (!PLUGIN_ID_PATTERN.test(id)) {
        return { ok: false, message: "Id plugin tidak valid." };
      }
      return jalankan(["plugin", "install", id, "--scope", "user"], `Plugin ${id} berhasil dipasang.`);
    },
    uninstall: async (id) => {
      if (!PLUGIN_ID_PATTERN.test(id)) {
        return { ok: false, message: "Id plugin tidak valid." };
      }
      return jalankan(["plugin", "uninstall", id, "--scope", "user"], `Plugin ${id} berhasil dicopot.`);
    },
    addMarketplace: async (source) => {
      const parsed = parseMarketplaceSource(source);
      if (!parsed.ok) return { ok: false, message: parsed.error };
      return jalankan(
        ["plugin", "marketplace", "add", parsed.source, "--scope", "user"],
        `Marketplace ${parsed.source} berhasil ditambahkan.`,
      );
    },
  };
}
