/**
 * Penyamar isi berkas `.env` untuk ditampilkan ke agen.
 *
 * Fungsi murni: tanpa I/O. Nilai yang aman (host, port, nama database, dsb.)
 * ditampilkan apa adanya; nilai lain diganti placeholder. Hasil akhir tetap
 * dilewatkan `redactSecrets` sebagai jaring pengaman.
 */

import { redactSecrets } from "./redact";

const VALUE_PLACEHOLDER = "[disembunyikan:nilai]";
const CREDENTIAL_PLACEHOLDER = "[disembunyikan:kredensial]";

/** Akhiran nama kunci yang nilainya aman ditampilkan. */
const SAFE_SUFFIXES: readonly string[] = [
  "HOST",
  "HOSTNAME",
  "PORT",
  "DATABASE",
  "DB_NAME",
  "DB_DATABASE",
  "NAME",
  "SCHEMA",
  "DRIVER",
  "CONNECTION",
  "ENV",
  "ENVIRONMENT",
  "REGION",
  "DEBUG",
  "LOG_LEVEL",
  "TIMEZONE",
  "TZ",
  "LOCALE",
  "APP_NAME",
  "APP_ENV",
  "NODE_ENV",
  "SSL",
  "TLS",
  "MODE",
];

/** Potongan nama kunci yang menandakan nilai rahasia. */
const SECRET_MARKERS: readonly string[] = [
  "pass",
  "pwd",
  "secret",
  "token",
  "key",
  "credential",
  "auth",
  "private",
  "signature",
  "salt",
  "dsn",
  "cert",
  "user",
  "username",
  "login",
  "account",
  "bearer",
];

/** Akhiran nama kunci yang nilainya berupa URL. */
const URL_SUFFIXES: readonly string[] = ["_URL", "_URI", "_ENDPOINT", "_DSN"];

function isSafeKey(upperKey: string): boolean {
  return SAFE_SUFFIXES.some((suffix) => upperKey === suffix || upperKey.endsWith(suffix));
}

function isSecretKey(lowerKey: string): boolean {
  return SECRET_MARKERS.some((marker) => lowerKey.includes(marker));
}

function isUrlKey(upperKey: string): boolean {
  return URL_SUFFIXES.some((suffix) => upperKey.endsWith(suffix));
}

/** Tampilkan URL tanpa kredensial; nilai query diganti placeholder. */
function displayUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  let out = `${url.protocol}//`;
  if (url.username !== "" || url.password !== "") {
    out += `${CREDENTIAL_PLACEHOLDER}@`;
  }
  out += url.hostname;
  if (url.port !== "") out += `:${url.port}`;
  out += url.pathname;
  const params = [...url.searchParams.keys()];
  if (params.length > 0) {
    out += `?${params.map((name) => `${name}=[disembunyikan]`).join("&")}`;
  }
  return out;
}

/** Ambil nilai mentah dari sisi kanan `=`; tanda petik dan komentar dihormati. */
function parseValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value.charAt(0);
    const close = value.indexOf(quote, 1);
    return close > 0 ? value.slice(1, close) : value.slice(1);
  }
  const comment = value.indexOf(" #");
  return comment >= 0 ? value.slice(0, comment).trim() : value;
}

function redactLine(line: string): string {
  let trimmed = line.trim();
  if (trimmed === "") return line;
  if (trimmed.startsWith("#")) {
    // Kredensial lama sering tertinggal sebagai komentar (`# DB_PASSWORD=...`).
    const isi = trimmed.replace(/^#+\s*/, "");
    if (!isi.includes("=")) return line;
    return `# ${redactLine(isi)}`;
  }
  trimmed = trimmed.replace(/^export\s+/, "");
  const withoutExport = trimmed;
  const equals = withoutExport.indexOf("=");
  if (equals <= 0) return line;

  const key = withoutExport.slice(0, equals).trim();
  if (key === "") return line;

  const upperKey = key.toUpperCase();
  const lowerKey = key.toLowerCase();
  const value = parseValue(withoutExport.slice(equals + 1));

  if (value === "") return `${key}=`;
  if (isSecretKey(lowerKey)) return `${key}=${VALUE_PLACEHOLDER}`;
  if (isSafeKey(upperKey)) return `${key}=${value}`;
  if (isUrlKey(upperKey)) {
    const shown = displayUrl(value);
    if (shown !== undefined) return `${key}=${shown}`;
  }
  return `${key}=${VALUE_PLACEHOLDER}`;
}

/** Apakah nilai bertanda petik dibuka tetapi belum ditutup pada baris ini. */
function opensMultiline(line: string): boolean {
  const eq = line.indexOf("=");
  if (eq < 0 || line.trim().startsWith("#")) return false;
  const value = line.slice(eq + 1).trim();
  const quote = value.charAt(0);
  if (quote !== '"' && quote !== "'") return false;
  return value.indexOf(quote, 1) < 0;
}

/**
 * Nilai multi-baris (mis. kunci PEM dalam tanda petik) diringkas menjadi satu
 * placeholder; baris lanjutan tak pernah ditampilkan.
 */
function redactLines(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!opensMultiline(line)) {
      out.push(redactLine(line));
      continue;
    }
    const quote = line.slice(line.indexOf("=") + 1).trim().charAt(0);
    const key = line.slice(0, line.indexOf("=")).trim().replace(/^export\s+/, "");
    out.push(`${key}=${VALUE_PLACEHOLDER}`);
    // Lewati baris lanjutan sampai tanda petik penutup (atau akhir berkas).
    while (i + 1 < lines.length) {
      i += 1;
      if ((lines[i] ?? "").includes(quote)) break;
    }
  }
  return out;
}

// Placeholder kita sendiri dilindungi sentinel pendek (< 8 karakter, agar
// `redactCredentialAssignments` melewatinya) saat lewat `redactSecrets`.
const SENTINEL_CREDENTIAL = "\u0000c\u0000";
const SENTINEL_HIDDEN = "\u0000h\u0000";

export function redactEnvFileText(text: string): string {
  if (typeof text !== "string") return "";
  const lines = redactLines(text.split(/\r?\n/));
  const guarded = lines
    .join("\n")
    .replaceAll(CREDENTIAL_PLACEHOLDER, SENTINEL_CREDENTIAL)
    .replaceAll("[disembunyikan]", SENTINEL_HIDDEN);
  return redactSecrets(guarded)
    .text.replaceAll(SENTINEL_CREDENTIAL, CREDENTIAL_PLACEHOLDER)
    .replaceAll(SENTINEL_HIDDEN, "[disembunyikan]");
}
