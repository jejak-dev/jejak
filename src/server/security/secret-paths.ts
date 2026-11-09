import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

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

function expandHome(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  return raw;
}

/** Jalur absolut ternormalisasi; realpath bila ada agar symlink ikut tertangkap. */
function normalizePath(raw: string, cwd: string, home: string): string {
  const expanded = expandHome(raw, home);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  try {
    if (existsSync(absolute)) return realpathSync(absolute);
  } catch {
    // realpath bisa gagal (izin, balapan hapus); pakai jalur logis.
  }
  return absolute;
}

/** Nama aturan yang cocok untuk jalur absolut, atau undefined. */
function ruleForPath(absPath: string): string | undefined {
  const name = basename(absPath);

  if (name === ".env") return ".env";
  if (name.startsWith(".env.")) {
    const suffix = name.slice(".env".length);
    if (!ENV_PUBLIC_SUFFIXES.includes(suffix)) return ".env.*";
  }

  for (const entry of SECRET_EXTENSIONS) {
    if (name.endsWith(entry.suffix)) return entry.rule;
  }

  for (const entry of PLAIN_NAMES) {
    if (name === entry.name) return entry.rule;
  }

  for (const entry of ID_KEY_PREFIXES) {
    if (name.startsWith(entry.prefix) && !name.endsWith(".pub")) return entry.rule;
  }

  const parent = basename(dirname(absPath));
  if (name === "credentials" && parent === ".aws") return ".aws/credentials";

  const segments = absPath.split(/[\\/]+/);
  if (segments.includes(".ssh")) {
    if (name.endsWith(".pub") || SSH_EXEMPT.has(name)) return undefined;
    return ".ssh/**";
  }

  return undefined;
}

/** Heuristik pola glob yang menyebut nama rahasia. */
function ruleForPattern(pattern: string): string | undefined {
  const name = basename(pattern);
  if (name.startsWith(".env")) return ".env";
  for (const entry of SECRET_EXTENSIONS) {
    if (name.endsWith(entry.suffix)) return entry.rule;
  }
  if (name.includes("id_rsa")) return "id_rsa*";
  if (name.includes("id_ed25519")) return "id_ed25519*";
  if (name.includes(".npmrc")) return ".npmrc";
  if (name.includes(".netrc")) return ".netrc";
  if (pattern.includes(".aws/credentials")) return ".aws/credentials";
  if (pattern.includes(".ssh/")) return ".ssh/**";
  return undefined;
}

/** Cepat melewati token yang tidak mungkin menyebut berkas rahasia. */
function tokenMayBeSecret(token: string): boolean {
  return (
    token.includes(".env") ||
    token.includes(".pem") ||
    token.includes(".key") ||
    token.includes(".p12") ||
    token.includes(".pfx") ||
    token.includes("id_rsa") ||
    token.includes("id_ed25519") ||
    token.includes("id_ecdsa") ||
    token.includes("id_dsa") ||
    token.includes(".npmrc") ||
    token.includes(".netrc") ||
    token.includes(".pgpass") ||
    token.includes(".aws") ||
    token.includes(".ssh") ||
    token.includes(".git-credentials") ||
    token.includes("credentials")
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
  options: { isAllowed?: (absPath: string) => boolean } = {},
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

    const blockedByPath = (raw: string | undefined): SecretAccessVerdict => {
      if (raw === undefined || raw === "") return { blocked: false };
      const absPath = normalizePath(raw, cwd, home);
      const rule = ruleForPath(absPath);
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
      const rule = ruleForPattern(pattern);
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
          if (!tokenMayBeSecret(token)) continue;
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
