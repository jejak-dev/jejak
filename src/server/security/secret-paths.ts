import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isWindows, pathApi, toSlash } from "../platform";

export interface SecretAccessCheck {
  toolName: string;
  toolInput: unknown;
  cwd: string;
  home?: string;
}

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
function normalizePath(
  raw: string,
  cwd: string,
  home: string,
  platform: NodeJS.Platform,
): string {
  const p = pathApi(platform);
  const expanded = expandHome(raw, home, platform);
  const absolute = p.isAbsolute(expanded) ? p.resolve(expanded) : p.resolve(cwd, expanded);
  try {
    if (existsSync(absolute)) return realpathSync(absolute);
  } catch {
    // realpath bisa gagal (izin, balapan hapus); pakai jalur logis.
  }
  return absolute;
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

export function checkSecretAccess(
  check: SecretAccessCheck,
  options: { isAllowed?: (absPath: string) => boolean; platform?: NodeJS.Platform } = {},
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

    const blockedByPath = (raw: string | undefined): SecretAccessVerdict => {
      if (raw === undefined || raw === "") return { blocked: false };
      const absPath = normalizePath(raw, cwd, home, platform);
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
      case "Write":
        return blockedByPath(stringField(toolInput, "file_path"));
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
        for (const token of tokenizeCommand(command)) {
          // Agent tidak boleh mengubah daftar izinnya sendiri lewat API.
          // `/secret-allow` mencakup rute nyata `/api/sessions/:id/secret-allow`.
          if (token.includes("/api/secret-allow") || token.includes("/secret-allow")) {
            return { blocked: true, rule: "secret-allow-api", reason: SECRET_BLOCK_REASON };
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
          if (!tokenMayBeSecret(token, platform)) continue;
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
