import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findSecret } from "../memory/secret-guard";
import { jejakHome } from "../provider-store";

export const MCP_CONFIG_VERSION = 1;
export const MCP_SERVERS_MAX = 30;
export const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MCP_NAME_MAX = 32;
export const MCP_COMMAND_MAX = 256;
export const MCP_ARGS_MAX = 32;
export const MCP_ARG_MAX = 512;
export const MCP_ENV_MAX = 32;
export const MCP_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
export const MCP_ENV_VALUE_MAX = 2048;
export const MCP_URL_MAX = 1024;
export const MCP_HEADERS_MAX = 16;
export const MCP_HEADERS_VALUE_MAX = 2048;
export const MCP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const MCP_RESERVED_PREFIX = "jejak";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Bentuk aman untuk API/UI: nilai env/header diganti daftar nama kunci. */
export interface McpServerView extends Omit<McpServerConfig, "env" | "headers"> {
  envKeys: string[];
  headerNames: string[];
}

export interface McpConfigFile {
  version: number;
  servers: McpServerConfig[];
}

export interface McpProblem {
  file: string;
  reason: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

function good<T>(value: T): Checked<T> {
  return { ok: true, value };
}

function bad<T>(reason: string): Checked<T> {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDateText(value: string): boolean {
  return value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

function secretReason(text: string): string | null {
  const secret = findSecret(text);
  return secret === null ? null : `memuat rahasia (${secret})`;
}

export function isMcpServerId(value: string): boolean {
  return UUID_V4.test(value);
}

/** `<JEJAK_HOME>/mcp-servers.json`. */
export function mcpServersPath(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "mcp-servers.json");
}

export function checkName(value: unknown): Checked<string> {
  if (typeof value !== "string") {
    return bad("Field name harus berupa teks.");
  }
  if (!MCP_NAME_PATTERN.test(value)) {
    return bad(
      "Nama server harus [a-z0-9][a-z0-9_-]{0,31} (huruf kecil, angka, garis bawah, strip).",
    );
  }
  if (value.startsWith(MCP_RESERVED_PREFIX)) {
    return bad(`Nama yang diawali "${MCP_RESERVED_PREFIX}" dicadangkan untuk Jejak.`);
  }
  const secret = secretReason(value);
  if (secret !== null) {
    return bad(`Nama server ${secret}.`);
  }
  return good(value);
}

export function checkTransport(value: unknown): Checked<McpTransport> {
  if (value !== "stdio" && value !== "http") {
    return bad('Field transport harus "stdio" atau "http".');
  }
  return good(value);
}

export function checkCommand(value: unknown): Checked<string> {
  if (typeof value !== "string") {
    return bad("Field command harus berupa teks.");
  }
  if (value.length === 0 || value.length > MCP_COMMAND_MAX) {
    return bad(`Field command harus 1-${MCP_COMMAND_MAX} karakter.`);
  }
  if (/\s/.test(value)) {
    return bad("Field command tidak boleh memuat spasi; perintah dijalankan tanpa shell.");
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return bad("Field command memuat karakter kontrol yang tidak diizinkan.");
  }
  const secret = secretReason(value);
  if (secret !== null) {
    return bad(`Field command ${secret}. Rahasia harus lewat env atau header.`);
  }
  return good(value);
}

export function checkArgs(value: unknown): Checked<string[]> {
  if (!Array.isArray(value)) {
    return bad("Field args harus berupa daftar teks.");
  }
  if (value.length > MCP_ARGS_MAX) {
    return bad(`Field args maks ${MCP_ARGS_MAX} entri.`);
  }
  const args: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return bad("Field args harus berupa daftar teks.");
    }
    if (entry.length > MCP_ARG_MAX) {
      return bad(`Setiap argumen maks ${MCP_ARG_MAX} karakter.`);
    }
    const secret = secretReason(entry);
    if (secret !== null) {
      return bad(`Argumen ${secret}. Rahasia harus lewat env atau header.`);
    }
    args.push(entry);
  }
  return good(args);
}

export function checkEnv(value: unknown): Checked<Record<string, string>> {
  if (!isRecord(value)) {
    return bad("Field env harus berupa objek.");
  }
  const entries = Object.entries(value);
  if (entries.length > MCP_ENV_MAX) {
    return bad(`Field env maks ${MCP_ENV_MAX} pasang.`);
  }
  const env: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!MCP_ENV_KEY_PATTERN.test(key)) {
      return bad(`Nama variabel env "${key}" tidak valid; pakai huruf besar, angka, garis bawah.`);
    }
    if (typeof raw !== "string") {
      return bad(`Nilai env "${key}" harus berupa teks.`);
    }
    if (raw.length > MCP_ENV_VALUE_MAX) {
      return bad(`Nilai env "${key}" maks ${MCP_ENV_VALUE_MAX} karakter.`);
    }
    if (raw.includes("\0")) {
      return bad(`Nilai env "${key}" memuat NUL.`);
    }
    env[key] = raw;
  }
  return good(env);
}

export function checkHeaders(value: unknown): Checked<Record<string, string>> {
  if (!isRecord(value)) {
    return bad("Field headers harus berupa objek.");
  }
  const entries = Object.entries(value);
  if (entries.length > MCP_HEADERS_MAX) {
    return bad(`Field headers maks ${MCP_HEADERS_MAX} pasang.`);
  }
  const headers: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!MCP_HEADER_NAME_PATTERN.test(key)) {
      return bad(`Nama header "${key}" tidak valid.`);
    }
    if (typeof raw !== "string") {
      return bad(`Nilai header "${key}" harus berupa teks.`);
    }
    if (raw.length > MCP_HEADERS_VALUE_MAX) {
      return bad(`Nilai header "${key}" maks ${MCP_HEADERS_VALUE_MAX} karakter.`);
    }
    if (CONTROL_CHARACTERS.test(raw)) {
      return bad(`Nilai header "${key}" memuat karakter kontrol yang tidak diizinkan.`);
    }
    headers[key] = raw;
  }
  return good(headers);
}

export function checkUrl(value: unknown): Checked<string> {
  if (typeof value !== "string") {
    return bad("Field url harus berupa teks.");
  }
  if (value.length === 0 || value.length > MCP_URL_MAX) {
    return bad(`Field url harus 1-${MCP_URL_MAX} karakter.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return bad("Field url harus berupa URL yang valid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return bad("Field url harus memakai http atau https.");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return bad("Field url tidak boleh memuat kredensial; pakai header.");
  }
  return good(value);
}

export function checkEnabled(value: unknown): Checked<boolean> {
  if (typeof value !== "boolean") {
    return bad("Field enabled harus berupa boolean.");
  }
  return good(value);
}

/**
 * Memeriksa aturan lintas field: field transport lain harus tidak ada dan
 * field wajib transport terpilih harus terisi.
 */
export function checkTransportFields(server: {
  transport: McpTransport;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
}): string | null {
  if (server.transport === "stdio") {
    if (server.url !== undefined || server.headers !== undefined) {
      return "Server stdio tidak boleh memuat url atau headers.";
    }
    if (server.command === undefined) {
      return "Server stdio wajib memuat command.";
    }
    return null;
  }
  if (server.command !== undefined || server.args !== undefined || server.env !== undefined) {
    return "Server http tidak boleh memuat command, args, atau env.";
  }
  if (server.url === undefined) {
    return "Server http wajib memuat url.";
  }
  return null;
}

/** Validasi satu record lengkap (dipakai saat menulis dan membaca berkas). */
export function validateServer(server: McpServerConfig): string | null {
  if (!isMcpServerId(server.id)) return "id bukan UUID v4";

  const name = checkName(server.name);
  if (!name.ok) return name.reason;

  const transport = checkTransport(server.transport);
  if (!transport.ok) return transport.reason;

  const cross = checkTransportFields(server);
  if (cross !== null) return cross;

  if (server.transport === "stdio") {
    const command = checkCommand(server.command);
    if (!command.ok) return command.reason;
    if (server.args !== undefined) {
      const args = checkArgs(server.args);
      if (!args.ok) return args.reason;
    }
    if (server.env !== undefined) {
      const env = checkEnv(server.env);
      if (!env.ok) return env.reason;
    }
  } else {
    const url = checkUrl(server.url);
    if (!url.ok) return url.reason;
    if (server.headers !== undefined) {
      const headers = checkHeaders(server.headers);
      if (!headers.ok) return headers.reason;
    }
  }

  if (typeof server.enabled !== "boolean") return "enabled harus berupa boolean";
  if (!isDateText(server.createdAt)) return "createdAt tidak valid";
  if (!isDateText(server.updatedAt)) return "updatedAt tidak valid";
  return null;
}

export function toView(server: McpServerConfig): McpServerView {
  const { env, headers, ...rest } = server;
  return {
    ...rest,
    envKeys: Object.keys(env ?? {}).sort(),
    headerNames: Object.keys(headers ?? {}).sort(),
  };
}

function parseServerRecord(
  value: unknown,
  index: number,
): { ok: true; server: McpServerConfig } | { ok: false; reason: string } {
  const prefix = `server #${index + 1}`;
  if (!isRecord(value)) {
    return { ok: false, reason: `${prefix} bukan objek` };
  }
  const allowed = new Set([
    "id",
    "name",
    "transport",
    "command",
    "args",
    "env",
    "url",
    "headers",
    "enabled",
    "createdAt",
    "updatedAt",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: `${prefix} memuat field tak dikenal "${key}"` };
    }
  }

  const id = value.id;
  if (typeof id !== "string" || !isMcpServerId(id)) {
    return { ok: false, reason: `${prefix} id bukan UUID v4` };
  }
  const server: McpServerConfig = {
    id,
    name: value.name as string,
    transport: value.transport as McpTransport,
    enabled: value.enabled as boolean,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
  };
  if (value.command !== undefined) server.command = value.command as string;
  if (value.args !== undefined) server.args = value.args as string[];
  if (value.env !== undefined) server.env = value.env as Record<string, string>;
  if (value.url !== undefined) server.url = value.url as string;
  if (value.headers !== undefined) server.headers = value.headers as Record<string, string>;

  const reason = validateServer(server);
  if (reason !== null) {
    return { ok: false, reason: `${prefix} ${reason}` };
  }
  return { ok: true, server };
}

/**
 * Parse ketat isi berkas. Berkas/entri rusak menjadi `problems`; daftar
 * server yang valid tetap dikembalikan agar pemasangan sesi tidak gagal.
 */
export function parseMcpConfig(
  json: unknown,
  file = "mcp-servers.json",
): { config: McpConfigFile; problems: McpProblem[] } {
  const empty: McpConfigFile = { version: MCP_CONFIG_VERSION, servers: [] };
  if (!isRecord(json)) {
    return { config: empty, problems: [{ file, reason: "isi berkas harus berupa objek" }] };
  }
  if (json.version !== MCP_CONFIG_VERSION) {
    return {
      config: empty,
      problems: [{ file, reason: `versi berkas tidak dikenal (harus ${MCP_CONFIG_VERSION})` }],
    };
  }
  if (!Array.isArray(json.servers)) {
    return { config: empty, problems: [{ file, reason: "servers harus berupa daftar" }] };
  }

  const problems: McpProblem[] = [];
  const servers: McpServerConfig[] = [];
  const names = new Set<string>();
  for (let index = 0; index < json.servers.length; index += 1) {
    const parsed = parseServerRecord(json.servers[index], index);
    if (!parsed.ok) {
      problems.push({ file, reason: parsed.reason });
      continue;
    }
    if (names.has(parsed.server.name)) {
      problems.push({ file, reason: `server #${index + 1} nama duplikat "${parsed.server.name}"` });
      continue;
    }
    names.add(parsed.server.name);
    if (servers.length >= MCP_SERVERS_MAX) {
      problems.push({
        file,
        reason: `server #${index + 1} melewati batas ${MCP_SERVERS_MAX} server; diabaikan`,
      });
      continue;
    }
    servers.push(parsed.server);
  }

  return { config: { version: MCP_CONFIG_VERSION, servers }, problems };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function readMcpConfig(
  path: string,
): Promise<{ config: McpConfigFile; problems: McpProblem[]; missing: boolean }> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return { config: { version: MCP_CONFIG_VERSION, servers: [] }, problems: [], missing: true };
    }
    return {
      config: { version: MCP_CONFIG_VERSION, servers: [] },
      problems: [{ file: path, reason: "berkas tidak dapat dibaca" }],
      missing: false,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch {
    return {
      config: { version: MCP_CONFIG_VERSION, servers: [] },
      problems: [{ file: path, reason: "JSON tidak valid" }],
      missing: false,
    };
  }

  const parsed = parseMcpConfig(json, path);
  return { ...parsed, missing: false };
}

function serializeServer(server: McpServerConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: server.id,
    name: server.name,
    transport: server.transport,
  };
  if (server.transport === "stdio") {
    payload.command = server.command;
    payload.args = server.args ?? [];
    payload.env = sortRecord(server.env ?? {});
  } else {
    payload.url = server.url;
    payload.headers = sortRecord(server.headers ?? {});
  }
  payload.enabled = server.enabled;
  payload.createdAt = server.createdAt;
  payload.updatedAt = server.updatedAt;
  return payload;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key]!;
  }
  return sorted;
}

export function serializeMcpConfig(config: McpConfigFile): string {
  const payload = {
    version: MCP_CONFIG_VERSION,
    servers: config.servers.map(serializeServer),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await chmod(path, 0o700);
  } catch {
    // Direktori induk mungkin milik sistem; berkas tetap dibatasi di bawah.
  }
}

export async function writeMcpConfig(path: string, config: McpConfigFile): Promise<void> {
  const seen = new Set<string>();
  for (const server of config.servers) {
    const reason = validateServer(server);
    if (reason !== null) {
      throw new Error(`Server MCP "${server.name}" tidak valid: ${reason}.`);
    }
    if (seen.has(server.name)) {
      throw new Error(`Nama server MCP "${server.name}" duplikat.`);
    }
    seen.add(server.name);
  }
  if (config.servers.length > MCP_SERVERS_MAX) {
    throw new Error(`Batas ${MCP_SERVERS_MAX} server MCP terlampaui.`);
  }

  const directory = dirname(path);
  await ensureDirectory(directory);

  const tempPath = `${path}.${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, serializeMcpConfig(config), { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Berkas sementara mungkin sudah tidak ada; error asli yang dilempar.
    }
    throw error;
  }
}