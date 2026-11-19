import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDesignDir } from "./manifest";

/** Satu token desain: nama variabel CSS dan nilainya. */
export interface DesignToken {
  name: string;
  value: string;
}

/** Galat token desain dengan status HTTP yang sesuai. */
export class DesignTokenError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 413,
  ) {
    super(message);
    this.name = "DesignTokenError";
  }
}

const MAX_TOKENS = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_VALUE_LENGTH = 200;
const NAME_RE = /^--[A-Za-z0-9_-]{1,64}$/;

const NOT_CREATED = "Desain belum dibuat.";
const INVALID_FILE = "Berkas token tidak valid.";
const TOO_LARGE = "Berkas token melebihi 256 KB.";
const INVALID_NAME = "Nama token tidak valid.";
const INVALID_VALUE = "Nilai token tidak valid.";
const DUPLICATE_NAME = "Nama token ganda.";
const LIMIT_REACHED = "Batas 200 token tercapai.";
const INVALID_BASE_MTIME = "baseMtime harus berupa bilangan.";
const CONFLICT = "Token berubah sejak dibaca; muat ulang.";
const SAVE_FAILED = "Token tidak dapat disimpan.";

interface RootSpan {
  /** Indeks awal selector `:root`. */
  start: number;
  /** Indeks tepat setelah `}` penutup. */
  end: number;
  /** Indeks awal isi blok. */
  bodyStart: number;
  /** Indeks `}` penutup. */
  bodyEnd: number;
}

/**
 * Menandai karakter di dalam komentar dengan spasi. Indeks karakter tidak
 * berubah, sehingga span yang ketemu pada teks tersamar tetap berlaku pada
 * teks asli.
 */
function maskComments(css: string): string {
  const chars = css.split("");
  let index = 0;
  while (index < css.length) {
    if (css[index] === "/" && css[index + 1] === "*") {
      const close = css.indexOf("*/", index + 2);
      const end = close === -1 ? css.length : close + 2;
      for (let k = index; k < end; k += 1) chars[k] = " ";
      index = end;
      continue;
    }
    index += 1;
  }
  return chars.join("");
}

/** Menemukan semua blok `:root { ... }` beserta posisi karakternya. */
function findRootSpans(masked: string): RootSpan[] {
  const spans: RootSpan[] = [];
  const pattern = /:root\b/g;
  let match = pattern.exec(masked);
  while (match !== null) {
    const start = match.index;
    let index = start + match[0].length;
    while (index < masked.length && /\s/.test(masked[index]!)) index += 1;
    if (masked[index] !== "{") {
      // Bukan blok (mis. `:root:hover` atau `:root, .lain`); lewati.
      pattern.lastIndex = start + match[0].length;
      match = pattern.exec(masked);
      continue;
    }
    const bodyStart = index + 1;
    let depth = 0;
    let bodyEnd = -1;
    let end = -1;
    for (let k = index; k < masked.length; k += 1) {
      const char = masked[k];
      if (char === "{") {
        depth += 1;
        continue;
      }
      if (char !== "}") continue;
      depth -= 1;
      if (depth === 0) {
        bodyEnd = k;
        end = k + 1;
        break;
      }
    }
    if (end === -1) break;
    spans.push({ start, end, bodyStart, bodyEnd });
    pattern.lastIndex = end;
    match = pattern.exec(masked);
  }
  return spans;
}

/** Nilai token sah: bukan kosong, tanpa tanda struktural CSS, maksimal 200 karakter. */
function isValidValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) return false;
  if (value.includes(";") || value.includes("{") || value.includes("}")) return false;
  if (value.includes("</")) return false;
  // Baris baru akan merusak format satu token per baris.
  if (/[\r\n]/.test(value)) return false;
  return true;
}

/** Satu token dari nama dan nilai mentah; `undefined` bila tidak sah. */
function makeToken(name: string, value: string): DesignToken | undefined {
  if (!NAME_RE.test(name)) return undefined;
  if (!isValidValue(value)) return undefined;
  return { name, value };
}

/** Membaca deklarasi di dalam satu blok `:root`; yang tak sah dilewati. */
function parseDeclarations(body: string): DesignToken[] {
  const tokens: DesignToken[] = [];
  for (const chunk of body.split(";")) {
    const declaration = chunk.trim();
    if (declaration === "") continue;
    const separator = declaration.indexOf(":");
    if (separator === -1) continue;
    const name = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    const token = makeToken(name, value);
    if (token !== undefined) tokens.push(token);
  }
  return tokens;
}

/** Menghapus seluruh span blok `:root` dari teks asli. */
function removeSpans(text: string, spans: RootSpan[]): string {
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += text.slice(cursor, span.start);
    cursor = span.end;
  }
  result += text.slice(cursor);
  return result;
}

/**
 * Membaca `design/tokens.css` dan mengembalikan daftar tokennya. Folder
 * desain atau berkasnya belum ada -> daftar kosong. Berkas yang bukan
 * berkas biasa (symlink), terlalu besar, atau tidak terbaca -> galat.
 */
export async function readTokens(
  root: string,
): Promise<{ tokens: DesignToken[]; mtime: number | null }> {
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) return { tokens: [], mtime: null };
  const path = join(designDir, "tokens.css");
  let info;
  try {
    info = await lstat(path);
  } catch {
    return { tokens: [], mtime: null };
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new DesignTokenError(INVALID_FILE, 400);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new DesignTokenError(TOO_LARGE, 413);
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new DesignTokenError(INVALID_FILE, 400);
  }

  const masked = maskComments(text);
  const tokens: DesignToken[] = [];
  for (const span of findRootSpans(masked)) {
    for (const token of parseDeclarations(masked.slice(span.bodyStart, span.bodyEnd))) {
      if (tokens.length >= MAX_TOKENS) {
        return { tokens, mtime: Math.round(info.mtimeMs) };
      }
      tokens.push(token);
    }
  }
  return { tokens, mtime: Math.round(info.mtimeMs) };
}

/** Validasi daftar token dari body permintaan; nilai dinormalkan (trim). */
function validateTokens(input: unknown): DesignToken[] {
  if (!Array.isArray(input)) {
    throw new DesignTokenError("Field tokens harus berupa daftar.", 400);
  }
  if (input.length > MAX_TOKENS) {
    throw new DesignTokenError(LIMIT_REACHED, 400);
  }
  const seen = new Set<string>();
  const tokens: DesignToken[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new DesignTokenError("Entri token harus berupa objek.", 400);
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== "string") throw new DesignTokenError(INVALID_NAME, 400);
    const name = item.name.trim();
    if (!NAME_RE.test(name)) throw new DesignTokenError(INVALID_NAME, 400);
    if (typeof item.value !== "string") throw new DesignTokenError(INVALID_VALUE, 400);
    const value = item.value.trim();
    if (!isValidValue(value)) throw new DesignTokenError(INVALID_VALUE, 400);
    if (seen.has(name)) throw new DesignTokenError(DUPLICATE_NAME, 400);
    seen.add(name);
    tokens.push({ name, value });
  }
  return tokens;
}

function validateBaseMtime(input: unknown): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new DesignTokenError(INVALID_BASE_MTIME, 400);
  }
  return input;
}

// Antrean promise per path: tulis yang bersamaan tidak saling menimpa.
const locks = new Map<string, Promise<void>>();

function withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(path, settled);
  void settled.then(() => {
    if (locks.get(path) === settled) locks.delete(path);
  });
  return run;
}

/**
 * Menulis ulang `design/tokens.css`: blok `:root` baru berisi daftar token,
 * sementara isi lain berkas (aturan CSS di luar `:root`) dipertahankan.
 * Penulisan atomik lewat berkas sementara di folder yang sama, mode berkas
 * lama dipertahankan. Bila `baseMtime` diberikan dan berbeda dari mtime
 * berkas sekarang, galat 409.
 */
export async function writeTokens(
  root: string,
  input: { tokens: DesignToken[]; baseMtime?: number },
): Promise<{ mtime: number }> {
  const tokens = validateTokens(input.tokens);
  const baseMtime = validateBaseMtime(input.baseMtime);
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) throw new DesignTokenError(NOT_CREATED, 404);
  const path = join(designDir, "tokens.css");

  return withLock(path, async () => {
    let info;
    try {
      info = await lstat(path);
    } catch {
      info = undefined;
    }
    let mode = 0o644;
    let current: number | null = null;
    let original = "";
    if (info !== undefined) {
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new DesignTokenError(INVALID_FILE, 400);
      }
      if (info.size > MAX_FILE_BYTES) throw new DesignTokenError(TOO_LARGE, 413);
      mode = info.mode & 0o777;
      current = Math.round(info.mtimeMs);
      try {
        original = await readFile(path, "utf8");
      } catch {
        throw new DesignTokenError(INVALID_FILE, 400);
      }
    }
    if (baseMtime !== undefined && baseMtime !== current) {
      throw new DesignTokenError(CONFLICT, 409);
    }

    const spans = findRootSpans(maskComments(original));
    const tail = removeSpans(original, spans).trim();
    const body = tokens.map((token) => `  ${token.name}: ${token.value};\n`).join("");
    const text = tail === "" ? `:root {\n${body}}\n` : `:root {\n${body}}\n${tail}\n`;

    const tempPath = join(designDir, `.jejak-tokens-${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, text, { mode });
      // mode pada writeFile tunduk pada umask; chmod memastikan mode lama utuh.
      await chmod(tempPath, mode);
      await rename(tempPath, path);
    } catch {
      await rm(tempPath, { force: true });
      throw new DesignTokenError(SAVE_FAILED, 400);
    }
    const after = await lstat(path);
    return { mtime: Math.round(after.mtimeMs) };
  });
}
