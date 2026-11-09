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

/** Ringkasan satu baris hasil tes untuk tampilan inline. */
export function describeTest(result: McpTestOutcome): string {
  if (!result.ok) {
    const error = result.error === undefined || result.error.trim() === "" ? "" : result.error;
    return error === "" ? `Gagal · ${result.ms} ms` : `Gagal · ${error}`;
  }
  const count = result.tools?.length ?? 0;
  return `Tersambung · ${count} tool · ${result.ms} ms`;
}
