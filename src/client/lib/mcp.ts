import type { McpServerItem, McpServerInput, McpServerUpdateInput, McpTestOutcome } from "./api";

/** Cermin pola server; server tetap sumber kebenaran. */
export const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MCP_SUMMARY_MAX = 60;

export type McpKeyValueKind = "env" | "header";

export interface McpFormValues {
  name: string;
  transport: "stdio" | "http";
  command: string;
  /** Satu argumen per baris. */
  args: string;
  /** `KUNCI=nilai` per baris; hanya untuk nilai baru atau pengganti. */
  env: string;
  url: string;
  /** `Nama: nilai` per baris; hanya untuk nilai baru atau pengganti. */
  headers: string;
  /** Kunci tersimpan yang diminta dihapus lewat tombol. */
  removedEnvKeys: string[];
  removedHeaderNames: string[];
}

export interface KeyValueParse {
  pairs: Record<string, string>;
  errors: string[];
}

/** Ringkasan satu baris untuk daftar: command + args (stdio) atau url (http). */
export function summarizeServer(item: McpServerItem): string {
  if (item.transport === "http") return item.url ?? "";
  const parts = [item.command ?? "", ...(item.args ?? [])].filter((part) => part !== "");
  const text = parts.join(" ");
  return text.length > MCP_SUMMARY_MAX ? `${text.slice(0, MCP_SUMMARY_MAX)}…` : text;
}

/** Teks multi-baris menjadi daftar; baris kosong dibuang dan tiap baris di-trim. */
export function parseLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (value !== "") lines.push(value);
  }
  return lines;
}

/**
 * Parse baris `KUNCI=nilai` (env) atau `Nama: nilai` (header). Pemisah yang
 * dipakai adalah yang pertama; nilai di-trim. Baris kosong dilewati.
 */
export function parseKeyValueLines(text: string, kind: McpKeyValueKind): KeyValueParse {
  const pairs: Record<string, string> = {};
  const errors: string[] = [];
  const separator = kind === "env" ? "=" : ":";
  const format = kind === "env" ? "KUNCI=nilai" : "Nama: nilai";
  const emptyLabel = kind === "env" ? "Kunci env" : "Nama header";

  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    const at = line.indexOf(separator);
    if (at === -1) {
      errors.push(`Baris ${index + 1} harus berformat ${format}.`);
      return;
    }
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === "") {
      errors.push(`${emptyLabel} pada baris ${index + 1} kosong.`);
      return;
    }
    pairs[key] = value;
  });

  return { pairs, errors };
}

/** Payload POST: hanya field milik transport terpilih, nilai kosong dilewati. */
export function buildCreateInput(form: McpFormValues): McpServerInput {
  const input: McpServerInput = { name: form.name.trim(), transport: form.transport };
  if (form.transport === "stdio") {
    input.command = form.command.trim();
    const args = parseLines(form.args);
    if (args.length > 0) input.args = args;
    const { pairs } = parseKeyValueLines(form.env, "env");
    if (Object.keys(pairs).length > 0) input.env = pairs;
  } else {
    input.url = form.url.trim();
    const { pairs } = parseKeyValueLines(form.headers, "header");
    if (Object.keys(pairs).length > 0) input.headers = pairs;
  }
  return input;
}

/**
 * Payload PATCH: hanya field yang berubah. Env/header yang dihapus dikirim
 * `null`; kunci yang tidak disebut dipertahankan; nilai tersimpan tidak pernah
 * dikirim ulang (textarea kosong atau nilai kosong diabaikan).
 */
export function buildUpdateInput(
  form: McpFormValues,
  original: McpServerItem,
): McpServerUpdateInput {
  const input: McpServerUpdateInput = {};
  const name = form.name.trim();
  if (name !== original.name) input.name = name;

  if (original.transport === "stdio") {
    const command = form.command.trim();
    if (command !== (original.command ?? "")) input.command = command;

    const args = parseLines(form.args);
    const originalArgs = original.args ?? [];
    if (args.join("\0") !== originalArgs.join("\0")) input.args = args;

    const env = partialRecord(
      parseKeyValueLines(form.env, "env").pairs,
      original.envKeys,
      form.removedEnvKeys,
    );
    if (Object.keys(env).length > 0) input.env = env;
  } else {
    const url = form.url.trim();
    if (url !== (original.url ?? "")) input.url = url;

    const headers = partialRecord(
      parseKeyValueLines(form.headers, "header").pairs,
      original.headerNames,
      form.removedHeaderNames,
    );
    if (Object.keys(headers).length > 0) input.headers = headers;
  }

  return input;
}

function partialRecord(
  pairs: Record<string, string>,
  existing: readonly string[],
  removed: readonly string[],
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const key of removed) {
    if (existing.includes(key)) result[key] = null;
  }
  for (const [key, value] of Object.entries(pairs)) {
    if (value === "") continue;
    result[key] = value;
  }
  return result;
}

export interface McpJsonEntry {
  name: string;
  input: McpServerInput;
  transport: "stdio" | "http";
  /** Nama kunci env/header saja; nilainya tidak pernah ikut. */
  secretKeys: string[];
  warnings: string[];
}

export interface McpJsonParse {
  entries: McpJsonEntry[];
  errors: string[];
}

const MCP_JSON_MAX_BYTES = 200 * 1024;
const MCP_JSON_MAX_SERVERS = 50;

const KNOWN_SERVER_KEYS = new Set([
  "command",
  "args",
  "env",
  "url",
  "headers",
  "type",
  "transport",
  "enabled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Buang komentar `//` dan `/* *\/` serta koma sisa sebelum `}`/`]` di luar
 * string. Tidak perlu sempurna, tetapi string sah (termasuk `https://`)
 * tidak boleh tersentuh.
 */
function stripJsonc(text: string): string {
  let out = "";
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;

    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    out += char;
    index += 1;
  }

  return stripTrailingCommas(out);
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;

    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }

    if (char === ",") {
      let look = index + 1;
      while (look < text.length && /\s/.test(text[look] ?? "")) look += 1;
      const next = text[look];
      if (next === "}" || next === "]") {
        index += 1;
        continue;
      }
    }

    out += char;
    index += 1;
  }

  return out;
}

function readStringMap(
  value: unknown,
  field: "env" | "headers",
  serverName: string,
  errors: string[],
): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push(`Server "${serverName}": ${field} harus berupa objek.`);
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      result[key] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      result[key] = String(raw);
    } else {
      errors.push(`Server "${serverName}": nilai ${field} ${key} harus teks.`);
      return undefined;
    }
  }
  return result;
}

function parseJsonEntry(
  rawName: string,
  raw: unknown,
  errors: string[],
): McpJsonEntry | undefined {
  const warnings: string[] = [];
  const name = rawName.trim();

  if (!isRecord(raw)) {
    errors.push(`Server "${name}": nilai harus objek.`);
    return undefined;
  }

  let finalName = name;
  if (!MCP_NAME_PATTERN.test(finalName)) {
    const normalized = name.toLowerCase().replace(/[ .]+/g, "-").slice(0, 32);
    if (!MCP_NAME_PATTERN.test(normalized)) {
      errors.push(
        `Nama "${name}" tidak valid; pakai huruf kecil, angka, strip, atau garis bawah (maks. 32).`,
      );
      return undefined;
    }
    warnings.push(`Nama diubah dari ${name} menjadi ${normalized}`);
    finalName = normalized;
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_SERVER_KEYS.has(key)) {
      warnings.push(`Kunci ${key} diabaikan`);
    }
  }

  const declared =
    typeof raw.type === "string"
      ? raw.type.toLowerCase()
      : typeof raw.transport === "string"
        ? raw.transport.toLowerCase()
        : undefined;
  const hasUrl = raw.url !== undefined;
  const transport: "stdio" | "http" =
    hasUrl || declared === "http" || declared === "streamable-http" || declared === "sse"
      ? "http"
      : "stdio";
  if (transport === "http" && declared === "sse") {
    warnings.push("SSE diperlakukan sebagai http");
  }

  if (transport === "http") {
    if (typeof raw.url !== "string" || raw.url.trim() === "") {
      errors.push(`Server "${finalName}": url wajib diisi untuk transport http.`);
      return undefined;
    }
    const headers = readStringMap(raw.headers, "headers", finalName, errors);
    if (headers === undefined) return undefined;
    const input: McpServerInput = {
      name: finalName,
      transport,
      url: raw.url.trim(),
      enabled: true,
    };
    if (Object.keys(headers).length > 0) input.headers = headers;
    return {
      name: finalName,
      input,
      transport,
      secretKeys: Object.keys(headers),
      warnings,
    };
  }

  if (typeof raw.command !== "string" || raw.command.trim() === "") {
    errors.push(`Server "${finalName}": command wajib diisi untuk transport stdio.`);
    return undefined;
  }

  let args: string[] = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || !raw.args.every((item) => typeof item === "string")) {
      errors.push(`Server "${finalName}": args harus berupa array string.`);
      return undefined;
    }
    args = raw.args as string[];
  }

  let command = raw.command.trim();
  if (/\s/.test(command)) {
    if (/["']/.test(command)) {
      errors.push(`Server "${finalName}": kutipan pada command tidak didukung.`);
      return undefined;
    }
    if (args.length > 0) {
      errors.push(`Server "${finalName}": command tidak boleh mengandung spasi.`);
      return undefined;
    }
    const parts = command.split(/\s+/);
    command = parts[0] ?? "";
    args = parts.slice(1);
    warnings.push("Command dipisah menjadi command dan args");
  }

  const env = readStringMap(raw.env, "env", finalName, errors);
  if (env === undefined) return undefined;

  const input: McpServerInput = {
    name: finalName,
    transport,
    command,
    enabled: true,
  };
  if (args.length > 0) input.args = args;
  if (Object.keys(env).length > 0) input.env = env;

  return {
    name: finalName,
    input,
    transport,
    secretKeys: Object.keys(env),
    warnings,
  };
}

/** Parse tempelan JSON konfigurasi MCP (format `mcpServers` dan variasi umum). */
export function parseMcpJson(text: string): McpJsonParse {
  const entries: McpJsonEntry[] = [];
  const errors: string[] = [];

  if (text.trim() === "") return { entries, errors };
  if (text.length > MCP_JSON_MAX_BYTES) {
    errors.push("JSON terlalu besar; batasnya 200 KB.");
    return { entries, errors };
  }

  let root: unknown;
  try {
    root = JSON.parse(stripJsonc(text));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "tidak dapat dibaca";
    errors.push(`JSON tidak valid: ${message}`);
    return { entries, errors };
  }

  if (!isRecord(root)) {
    errors.push("JSON tidak valid: akar harus objek.");
    return { entries, errors };
  }

  if (Object.keys(root).length === 0) return { entries, errors };

  let map: Record<string, unknown>;
  if (isRecord(root.mcpServers)) {
    map = root.mcpServers;
  } else if (isRecord(root.servers)) {
    map = root.servers;
  } else if (typeof root.command === "string" || typeof root.url === "string") {
    errors.push('Beri nama server: bungkus dengan { "nama": { ... } }');
    return { entries, errors };
  } else {
    const values = Object.values(root);
    const plainMap =
      values.length > 0 &&
      values.every(
        (value) =>
          isRecord(value) &&
          (typeof value.command === "string" || typeof value.url === "string"),
      );
    if (!plainMap) {
      errors.push('JSON tidak valid: tidak ditemukan daftar server (mcpServers).');
      return { entries, errors };
    }
    map = root;
  }

  const names = Object.keys(map);
  if (names.length === 0) return { entries, errors };
  if (names.length > MCP_JSON_MAX_SERVERS) {
    errors.push(`Maksimum ${MCP_JSON_MAX_SERVERS} server per tempel.`);
    return { entries, errors };
  }

  for (const name of names) {
    const entry = parseJsonEntry(name, map[name], errors);
    if (entry !== undefined) entries.push(entry);
  }

  return { entries, errors };
}

/** Ringkasan satu baris hasil tes untuk tampilan inline. */
export function describeTest(result: McpTestOutcome): string {
  if (!result.ok) {
    const error = result.error === undefined || result.error.trim() === "" ? "" : result.error;
    return error === "" ? `Gagal · ${result.ms} ms` : `Gagal · ${error}`;
  }
  const count = result.tools?.length ?? 0;
  return `Tersambung · ${count} tool · ${result.ms} ms`;
}
