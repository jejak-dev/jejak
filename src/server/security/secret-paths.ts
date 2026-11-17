import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isWindows, pathApi, toSlash } from "../platform";

export interface SecretAccessCheck {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  home?: string;
}

/** Env perintah yang aktif untuk sesi; hanya nama kunci yang dipakai penjaga. */
export interface CommandEnvGuard {
  keys: readonly string[];
  /** Jalur berkas env perintah; berkas itu sendiri tak boleh dibaca agent walau namanya bebas. */
  file?: string;
}

export const COMMAND_ENV_REASON =
  "Perintah ini akan menampilkan variabel lingkungan rahasia.";

export interface SecretAccessVerdict {
  blocked: boolean;
  rule?: string;
  reason?: string;
}

export const SECRET_BLOCK_REASON =
  "Berkas ini diblokir kebijakan rahasia; minta pengguna menempelkan nilai yang perlu.";

/** Akhiran `.env.*` yang dianggap contoh/templat, bukan rahasia. */
const ENV_PUBLIC_SUFFIXES = [".example", ".sample", ".template", ".dist"];

/** Nama berkas yang selalu rahasia (cocok persis pada basename). */
const PLAIN_NAMES: ReadonlyArray<{ name: string; rule: string }> = [
  { name: ".npmrc", rule: ".npmrc" },
  { name: ".netrc", rule: ".netrc" },
  { name: ".pgpass", rule: ".pgpass" },
  { name: ".git-credentials", rule: ".git-credentials" },
  { name: "secret-allow.json", rule: "secret-allow.json" },
  // Penyimpanan sandi Jejak (hash scrypt); tak boleh dibaca agen.
  { name: "auth.json", rule: "auth.json" },
];

/** Ekstensi berkas yang selalu rahasia. */
const SECRET_EXTENSIONS: ReadonlyArray<{ suffix: string; rule: string }> = [
  { suffix: ".pem", rule: "*.pem" },
  { suffix: ".key", rule: "*.key" },
  { suffix: ".p12", rule: "*.p12" },
  { suffix: ".pfx", rule: "*.pfx" },
];

const ID_KEY_PREFIXES: ReadonlyArray<{ prefix: string; rule: string }> = [
  { prefix: "id_rsa", rule: "id_rsa*" },
  { prefix: "id_ed25519", rule: "id_ed25519*" },
  { prefix: "id_ecdsa", rule: "id_ecdsa*" },
  { prefix: "id_dsa", rule: "id_dsa*" },
];

const SSH_EXEMPT = new Set(["known_hosts", "config"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(input: unknown, field: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

function expandHome(raw: string, home: string, platform: NodeJS.Platform): string {
  const p = pathApi(platform);
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return p.resolve(home, raw.slice(2));
  // Di Windows "~\\AppData\\..." juga berarti folder home.
  if (isWindows(platform) && raw.startsWith("~\\")) return p.resolve(home, raw.slice(2));
  return raw;
}

/** Jalur absolut ternormalisasi; realpath bila ada agar symlink ikut tertangkap. */
function logicalPath(
  raw: string,
  cwd: string,
  home: string,
  platform: NodeJS.Platform,
): string {
  const p = pathApi(platform);
  const expanded = expandHome(raw, home, platform);
  return p.isAbsolute(expanded) ? p.resolve(expanded) : p.resolve(cwd, expanded);
}

function normalizePath(
  raw: string,
  cwd: string,
  home: string,
  platform: NodeJS.Platform,
): string {
  const absolute = logicalPath(raw, cwd, home, platform);
  try {
    if (existsSync(absolute)) return realpathSync(absolute);
  } catch {
    // realpath bisa gagal (izin, balapan hapus); pakai jalur logis.
  }
  return absolute;
}

/** Apakah entri (berkas, direktori, atau symlink) sudah ada tanpa mengikuti symlink. */
function pathEntryExists(absPath: string): boolean {
  try {
    lstatSync(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Basename berkas `.env.*` yang dianggap contoh/templat publik. */
function isPublicEnvName(name: string, platform: NodeJS.Platform): boolean {
  if (!startsWithName(name, ".env.", platform)) return false;
  const suffix = name.slice(".env".length);
  return ENV_PUBLIC_SUFFIXES.some((entry) => sameName(suffix, entry, platform));
}

/** Opsi `cp` yang menyalin direktori (rekursif); segmen seperti ini tak dibebaskan. */
function isRecursiveCpOption(option: string): boolean {
  if (option.startsWith("--")) return option === "--recursive" || option === "--archive";
  return /[rRa]/.test(option.slice(1));
}

/**
 * Indeks token TUJUAN pada segmen `cp <publik> <.env baru>` yang boleh
 * dibebaskan dari penjaga rahasia. Segmen lain mengembalikan himpunan kosong.
 */
function cpAllowedDestinationIndices(
  tokens: readonly string[],
  cwd: string,
  home: string,
  platform: NodeJS.Platform,
  commandEnvFile: string | undefined,
): Set<number> {
  const none = new Set<number>();
  if (tokens.length === 0) return none;
  if (basenameOf(tokens[0] ?? "") !== "cp") return none;

  const operands: Array<{ token: string; index: number }> = [];
  let optionsDone = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!optionsDone && token === "--") {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && token.startsWith("-") && token !== "-") {
      if (isRecursiveCpOption(token)) return none;
      continue;
    }
    operands.push({ token, index });
  }
  if (operands.length !== 2) return none;

  const source = operands[0]!;
  const dest = operands[1]!;

  // Sumber harus berkas contoh publik, juga setelah symlink diselesaikan.
  const sourceAbs = normalizePath(source.token, cwd, home, platform);
  if (!isPublicEnvName(pathApi(platform).basename(sourceAbs), platform)) return none;
  if (commandEnvFile !== undefined && sameName(sourceAbs, commandEnvFile, platform)) return none;

  // Tujuan harus `.env`/`.env.*` yang belum ada.
  const destAbs = logicalPath(dest.token, cwd, home, platform);
  const destRule = ruleForPath(destAbs, platform);
  if (destRule !== ".env" && destRule !== ".env.*") return none;
  if (commandEnvFile !== undefined && sameName(destAbs, commandEnvFile, platform)) return none;
  if (pathEntryExists(destAbs)) return none;

  return new Set([dest.index]);
}

/** Perbandingan nama berkas; Windows tak membedakan huruf besar-kecil. */
function sameName(a: string, b: string, platform: NodeJS.Platform): boolean {
  return isWindows(platform) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function startsWithName(a: string, b: string, platform: NodeJS.Platform): boolean {
  return isWindows(platform) ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b);
}

function endsWithName(a: string, b: string, platform: NodeJS.Platform): boolean {
  return isWindows(platform) ? a.toLowerCase().endsWith(b.toLowerCase()) : a.endsWith(b);
}

/** Apakah jalur (relatif atau absolut) tampak berkas rahasia; dipakai indexer untuk menyaring. */
export function isSecretFilePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return ruleForPath(path, platform) !== undefined;
}

/** Nama aturan yang cocok untuk jalur absolut, atau undefined. */
function ruleForPath(absPath: string, platform: NodeJS.Platform): string | undefined {
  const p = pathApi(platform);
  const name = p.basename(absPath);

  if (sameName(name, ".env", platform)) return ".env";
  if (startsWithName(name, ".env.", platform)) {
    const suffix = name.slice(".env".length);
    if (!ENV_PUBLIC_SUFFIXES.includes(suffix)) return ".env.*";
  }

  for (const entry of SECRET_EXTENSIONS) {
    if (endsWithName(name, entry.suffix, platform)) return entry.rule;
  }

  for (const entry of PLAIN_NAMES) {
    if (sameName(name, entry.name, platform)) return entry.rule;
  }

  for (const entry of ID_KEY_PREFIXES) {
    if (startsWithName(name, entry.prefix, platform) && !endsWithName(name, ".pub", platform)) {
      return entry.rule;
    }
  }

  const parent = p.basename(p.dirname(absPath));
  if (sameName(name, "credentials", platform) && sameName(parent, ".aws", platform)) {
    return ".aws/credentials";
  }

  const segments = absPath.split(/[\\/]+/);
  if (segments.some((segment) => sameName(segment, ".ssh", platform))) {
    if (endsWithName(name, ".pub", platform) || SSH_EXEMPT.has(name)) return undefined;
    return ".ssh/**";
  }

  return undefined;
}

/**
 * Jalur absolut ternormalisasi bila panggilan `Read` menyasar berkas `.env`
 * atau `.env.*`; selain itu `undefined`. Dipakai untuk menampilkan isi `.env`
 * yang disamarkan sebagai alasan penolakan.
 */
export function resolveSecretReadPath(
  check: SecretAccessCheck,
  options: { platform?: NodeJS.Platform } = {},
): string | undefined {
  try {
    if (!isRecord(check)) return undefined;
    if (check.toolName !== "Read") return undefined;
    const raw = stringField(check.toolInput, "file_path");
    if (raw === undefined || raw === "") return undefined;
    const cwd =
      typeof check.cwd === "string" && check.cwd !== "" ? check.cwd : process.cwd();
    const home =
      typeof check.home === "string" && check.home !== "" ? check.home : homedir();
    const platform = options.platform ?? process.platform;
    const absPath = normalizePath(raw, cwd, home, platform);
    const rule = ruleForPath(absPath, platform);
    return rule === ".env" || rule === ".env.*" ? absPath : undefined;
  } catch {
    return undefined;
  }
}

/** Heuristik pola glob yang menyebut nama rahasia. */
function ruleForPattern(pattern: string, platform: NodeJS.Platform): string | undefined {
  const p = pathApi(platform);
  // Di Windows pola glob bisa memakai pemisah "\".
  const text = isWindows(platform) ? toSlash(pattern) : pattern;
  const name = p.basename(text);
  if (startsWithName(name, ".env", platform)) return ".env";
  for (const entry of SECRET_EXTENSIONS) {
    if (endsWithName(name, entry.suffix, platform)) return entry.rule;
  }
  const lower = name.toLowerCase();
  if (lower.includes("id_rsa")) return "id_rsa*";
  if (lower.includes("id_ed25519")) return "id_ed25519*";
  if (lower.includes(".npmrc")) return ".npmrc";
  if (lower.includes(".netrc")) return ".netrc";
  if (text.toLowerCase().includes(".aws/credentials")) return ".aws/credentials";
  if (text.toLowerCase().includes(".ssh/")) return ".ssh/**";
  return undefined;
}

/** Cepat melewati token yang tidak mungkin menyebut berkas rahasia. */
function tokenMayBeSecret(token: string, platform: NodeJS.Platform): boolean {
  const text = isWindows(platform) ? token.toLowerCase() : token;
  return (
    text.includes(".env") ||
    text.includes(".pem") ||
    text.includes(".key") ||
    text.includes(".p12") ||
    text.includes(".pfx") ||
    text.includes("id_rsa") ||
    text.includes("id_ed25519") ||
    text.includes("id_ecdsa") ||
    text.includes("id_dsa") ||
    text.includes(".npmrc") ||
    text.includes(".netrc") ||
    text.includes(".pgpass") ||
    text.includes(".aws") ||
    text.includes(".ssh") ||
    text.includes(".git-credentials") ||
    text.includes("credentials")
  );
}

const BASH_SEPARATORS = new Set([" ", "\t", "\n", ";", "&", "|", "<", ">", "(", ")", "=", "`"]);

/** Pecah perintah Bash sederhana; tanda petik tunggal/ganda dihormati. */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  const flush = (): void => {
    if (current !== "") {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        index += 1;
        current += command[index] ?? "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 1;
      current += command[index] ?? "";
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      flush();
      index += 1;
      continue;
    }
    if (BASH_SEPARATORS.has(char)) {
      flush();
      continue;
    }
    current += char;
  }

  flush();
  return tokens;
}

/** Pecah perintah menjadi segmen perintah sederhana (dipisah `;`, `&&`, `|`, baris baru). */
function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

function basenameOf(token: string): string {
  const parts = token.split(/[\\/]+/);
  return parts[parts.length - 1] ?? token;
}

/**
 * Penjaga upaya-terbaik untuk env perintah: menolak perintah yang menampilkan
 * variabel lingkungan. Ini bukan jaminan — shell bisa menyamarkan nilai lewat
 * cara tak terduga (mis. `cat` berkas turunan, `awk`), jadi penyamaran output
 * tetap lapis utama.
 */
function commandEnvVerdict(command: string, keys: readonly string[]): SecretAccessVerdict {
  const lower = command.toLowerCase();
  if (lower.includes("/proc/") && lower.includes("environ")) {
    return { blocked: true, rule: "env-perintah", reason: COMMAND_ENV_REASON };
  }

  const keySet = new Set(keys);
  for (const segment of commandSegments(command)) {
    const tokens = tokenizeCommand(segment);
    if (tokens.length === 0) continue;
    const first = basenameOf(tokens[0] ?? "");

    if (first === "env" || first === "printenv") {
      return { blocked: true, rule: "env-perintah", reason: COMMAND_ENV_REASON };
    }
    if (first === "set" && tokens.length === 1) {
      return { blocked: true, rule: "env-perintah", reason: COMMAND_ENV_REASON };
    }
    if (
      (first === "export" || first === "declare" || first === "typeset") &&
      tokens[1] === "-p"
    ) {
      return { blocked: true, rule: "env-perintah", reason: COMMAND_ENV_REASON };
    }
    if (first === "compgen" && tokens[1] === "-v") {
      return { blocked: true, rule: "env-perintah", reason: COMMAND_ENV_REASON };
    }
    if (first === "echo" || first === "printf") {
      for (const token of tokens.slice(1)) {
        for (const key of keySet) {
          if (token.includes(`$${key}`) || token.includes(`\${${key}}`)) {
            return { blocked: true, rule: "env-perintah", reason: COMMAND_ENV_REASON };
          }
        }
      }
    }
  }
  return { blocked: false };
}

export function checkSecretAccess(
  check: SecretAccessCheck,
  options: {
    isAllowed?: (absPath: string) => boolean;
    platform?: NodeJS.Platform;
    /** Env perintah aktif; menolak perintah yang menampilkan variabelnya. */
    commandEnv?: CommandEnvGuard;
  } = {},
): SecretAccessVerdict {
  try {
    if (!isRecord(check)) return { blocked: false };
    const toolName = typeof check.toolName === "string" ? check.toolName : "";
    const toolInput = check.toolInput;
    const cwd =
      typeof check.cwd === "string" && check.cwd !== "" ? check.cwd : process.cwd();
    const home =
      typeof check.home === "string" && check.home !== "" ? check.home : homedir();
    const isAllowed = options.isAllowed;
    const platform = options.platform ?? process.platform;

    const commandEnvFile =
      options.commandEnv?.file === undefined || options.commandEnv.file === ""
        ? undefined
        : normalizePath(options.commandEnv.file, cwd, home, platform);

    const blockedByPath = (raw: string | undefined): SecretAccessVerdict => {
      if (raw === undefined || raw === "") return { blocked: false };
      const absPath = normalizePath(raw, cwd, home, platform);
      // Berkas env perintah selalu tertutup, apa pun namanya; allow-list tak melonggarkannya.
      if (commandEnvFile !== undefined && sameName(absPath, commandEnvFile, platform)) {
        return { blocked: true, rule: "env-perintah-berkas", reason: SECRET_BLOCK_REASON };
      }
      const rule = ruleForPath(absPath, platform);
      if (rule === undefined) return { blocked: false };
      if (isAllowed !== undefined) {
        try {
          if (isAllowed(absPath) === true) return { blocked: false };
        } catch {
          // Daftar izin rusak tidak boleh melonggarkan kebijakan.
        }
      }
      return { blocked: true, rule, reason: SECRET_BLOCK_REASON };
    };

    const blockedByPattern = (pattern: string | undefined): SecretAccessVerdict => {
      if (pattern === undefined || pattern === "") return { blocked: false };
      const rule = ruleForPattern(pattern, platform);
      return rule === undefined
        ? { blocked: false }
        : { blocked: true, rule, reason: SECRET_BLOCK_REASON };
    };

    switch (toolName) {
      case "Read":
      case "Edit":
      case "MultiEdit":
        return blockedByPath(stringField(toolInput, "file_path"));
      case "Write": {
        const raw = stringField(toolInput, "file_path");
        // Membuat `.env`/`.env.*` BARU boleh; menimpa yang sudah ada tetap diblokir.
        if (raw !== undefined && raw !== "") {
          const absPath = logicalPath(raw, cwd, home, platform);
          const rule = ruleForPath(absPath, platform);
          if (
            (rule === ".env" || rule === ".env.*") &&
            !pathEntryExists(absPath) &&
            !(commandEnvFile !== undefined && sameName(absPath, commandEnvFile, platform))
          ) {
            return { blocked: false };
          }
        }
        return blockedByPath(raw);
      }
      case "NotebookEdit":
        return blockedByPath(stringField(toolInput, "notebook_path"));
      case "Grep": {
        const byPath = blockedByPath(stringField(toolInput, "path"));
        if (byPath.blocked) return byPath;
        return blockedByPattern(stringField(toolInput, "glob"));
      }
      case "Glob":
        return blockedByPattern(stringField(toolInput, "pattern"));
      case "Bash": {
        const command = stringField(toolInput, "command");
        if (command === undefined) return { blocked: false };
        const commandEnv = options.commandEnv;
        if (commandEnv !== undefined) {
          const envVerdict = commandEnvVerdict(command, commandEnv.keys);
          if (envVerdict.blocked) return envVerdict;
        }
        const tokensWithIndex: Array<{ token: string; exempt: boolean }> = [];
        for (const segment of commandSegments(command)) {
          const segmentTokens = tokenizeCommand(segment);
          const exemptIndices = cpAllowedDestinationIndices(
            segmentTokens,
            cwd,
            home,
            platform,
            commandEnvFile,
          );
          segmentTokens.forEach((token, index) => {
            tokensWithIndex.push({ token, exempt: exemptIndices.has(index) });
          });
        }
        for (const { token, exempt } of tokensWithIndex) {
          // Agent tidak boleh mengubah daftar izinnya sendiri lewat API.
          // `/secret-allow` mencakup rute nyata `/api/sessions/:id/secret-allow`.
          if (token.includes("/api/secret-allow") || token.includes("/secret-allow")) {
            return { blocked: true, rule: "secret-allow-api", reason: SECRET_BLOCK_REASON };
          }
          // Agent tidak boleh mengubah env perintahnya sendiri lewat API.
          if (token.includes("/command-env")) {
            return { blocked: true, rule: "command-env-api", reason: SECRET_BLOCK_REASON };
          }
          // Agent tidak boleh menyalakan sumber pengguna / mengubah skills lewat API.
          if (token.includes("/api/claude")) {
            return { blocked: true, rule: "claude-config-api", reason: SECRET_BLOCK_REASON };
          }
          // Agent tidak boleh mematikan sandbox-nya sendiri lewat API.
          // Agent tidak boleh menjawab pertanyaannya sendiri (menjadi memory "dikonfirmasi").
          // Terminal PTY memberi shell tanpa sandbox: agent tidak boleh membukanya lewat API.
          if (token.includes("/api/terminal")) {
            return { blocked: true, rule: "terminal-api", reason: SECRET_BLOCK_REASON };
          }
          if (token.includes("/api/git-providers")) {
            return { blocked: true, rule: "git-providers-api", reason: SECRET_BLOCK_REASON };
          }
          if (token.includes("/api/questions")) {
            return { blocked: true, rule: "questions-api", reason: SECRET_BLOCK_REASON };
          }
          if (token.includes("/api/sandbox")) {
            return { blocked: true, rule: "sandbox-api", reason: SECRET_BLOCK_REASON };
          }
          if (
            !tokenMayBeSecret(token, platform) &&
            !(commandEnvFile !== undefined && token.includes(pathApi(platform).basename(commandEnvFile)))
          ) {
            continue;
          }
          if (exempt) continue;
          const verdict = blockedByPath(token);
          if (verdict.blocked) return verdict;
        }
        return { blocked: false };
      }
      default:
        return { blocked: false };
    }
  } catch {
    return { blocked: false };
  }
}
