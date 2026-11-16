import type {
  AgentRunner,
  CommandInfo,
  ListCommandsInput,
} from "../agent/events";

/** Sumber daftar perintah: dari SDK atau daftar bawaan Jejak. */
export type CommandSource = "sdk" | "bawaan";

export interface CommandCatalogResult {
  commands: CommandInfo[];
  source: CommandSource;
}

export interface CommandCatalogOptions {
  runner: AgentRunner;
  /** Jam untuk cache dan TTL; bawaan `Date.now`. */
  now?: () => number;
  /** Masa berlaku entri cache; bawaan 5 menit. */
  ttlMs?: number;
  /** Jumlah entri cache maksimum; bawaan 20. */
  maxEntries?: number;
}

/**
 * Perintah yang tak bermakna di UI web Jejak.
 *
 * Jejak menjalankan tiap giliran sebagai query terpisah dan punya
 * kontrolnya sendiri (izin, mode, sandbox), jadi perintah kendali CLI
 * tak punya tempat dipakai di sini.
 */
const DENYLIST = new Set([
  "clear",
  "rename",
  "model",
  "effort",
  "fast",
  "config",
  "color",
  "focus",
  "output-style",
  "mcp",
  "autocompact",
  "goal",
  "loop",
  "import",
  "agents",
  "list-agents",
  "design-consent",
  "design-revoke",
  "auto-mode-setup",
  "reload-plugins",
  "reload-skills",
  "run-skill-generator",
  "workflow-launch-exec",
]);

/** Daftar bawaan saat SDK tak bisa memberi daftar (gagal atau timeout). */
const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "compact", description: "Padatkan percakapan jadi ringkas.", argumentHint: "" },
  { name: "context", description: "Tampilkan penggunaan konteks sesi.", argumentHint: "" },
  { name: "usage", description: "Tampilkan penggunaan token sesi.", argumentHint: "" },
  { name: "init", description: "Buat berkas CLAUDE.md untuk proyek.", argumentHint: "" },
];

/** Galat tak boleh lebih lama dari ini tersimpan di cache. */
const ERROR_TTL_MS = 30_000;

/** Nama perintah diawali huruf (mis. `compact`), bukan `:` atau angka. */
function startsWithLetter(name: string): boolean {
  const first = name.charAt(0);
  return first !== "" && /[A-Za-z]/.test(first);
}

/**
 * Buang perintah yang tak berguna di UI, lalu urutkan dan unikkan.
 *
 * Nama diawali huruf didahulukan; sisanya menyusul. Perbandingan memakai
 * urutan teks biasa supaya hasilnya sama di semua mesin.
 */
export function filterCommands(list: readonly CommandInfo[]): CommandInfo[] {
  const seen = new Set<string>();
  const result: CommandInfo[] = [];
  for (const command of list) {
    const name = command.name.trim();
    if (name === "") continue;
    if (name.startsWith("_")) continue;
    if (DENYLIST.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({ ...command, name });
  }
  result.sort((kiri, kanan) => {
    const kiriHuruf = startsWithLetter(kiri.name);
    const kananHuruf = startsWithLetter(kanan.name);
    if (kiriHuruf !== kananHuruf) return kiriHuruf ? -1 : 1;
    if (kiri.name < kanan.name) return -1;
    if (kiri.name > kanan.name) return 1;
    return 0;
  });
  return result;
}

/** Kunci cache: folder kerja + sumber pengguna + skill aktif + plugin (terurut). */
function cacheKeyOf(input: ListCommandsInput): string {
  const skills = [...(input.claude?.skills ?? [])].sort();
  const plugins = [...(input.claude?.plugins ?? [])].sort();
  const userSettings = input.claude?.userSettings === true ? "1" : "0";
  return JSON.stringify([input.cwd, userSettings, skills, plugins]);
}

interface CacheEntry {
  at: number;
  ttlMs: number;
  result: CommandCatalogResult;
}

/**
 * Katalog perintah slash.
 *
 * Daftar dibaca dari SDK runner lalu disaring. Hasil disimpan sebentar
 * per folder kerja supaya tak ada proses `claude` yang menyala tiap kali
 * palet perintah dibuka. Bila runner tak bisa memberi daftar, daftar
 * bawaan Jejak dipakai dan galat tak disimpan lebih dari 30 detik.
 */
export class CommandCatalog {
  private readonly runner: AgentRunner;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<CommandCatalogResult>>();

  constructor(options: CommandCatalogOptions) {
    this.runner = options.runner;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 300_000;
    this.maxEntries = options.maxEntries ?? 20;
  }

  async get(input: ListCommandsInput): Promise<CommandCatalogResult> {
    const key = cacheKeyOf(input);
    const cached = this.entries.get(key);
    if (cached !== undefined && this.now() - cached.at < cached.ttlMs) {
      return cached.result;
    }
    // Permintaan serentak untuk kunci yang sama berbagi satu pekerjaan.
    const berjalan = this.pending.get(key);
    if (berjalan !== undefined) return berjalan;
    const kerja = this.load(input, key).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, kerja);
    return kerja;
  }

  /** Baca daftar dari runner; kegagalan apa pun jadi daftar bawaan. */
  private async load(
    input: ListCommandsInput,
    key: string,
  ): Promise<CommandCatalogResult> {
    try {
      const list = await this.runner.listCommands?.(input);
      if (list === undefined) {
        throw new Error("runner tak mendukung daftar perintah");
      }
      const result: CommandCatalogResult = {
        commands: filterCommands(list),
        source: "sdk",
      };
      this.store(key, result, this.ttlMs);
      return result;
    } catch {
      const result: CommandCatalogResult = {
        commands: BUILTIN_COMMANDS.map((command) => ({ ...command })),
        source: "bawaan",
      };
      this.store(key, result, Math.min(this.ttlMs, ERROR_TTL_MS));
      return result;
    }
  }

  /** Simpan hasil dan pangkas entri tertua bila lewat batas. */
  private store(
    key: string,
    result: CommandCatalogResult,
    ttlMs: number,
  ): void {
    // Sisipkan ulang supaya urutan map mencerminkan yang terbaru.
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), ttlMs, result });
    while (this.entries.size > this.maxEntries) {
      const tertua = this.entries.keys().next();
      if (tertua.done === true) break;
      this.entries.delete(tertua.value);
    }
  }
}
