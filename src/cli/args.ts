export type CliCommand = "serve" | "doctor" | "version" | "help" | "unknown";

export interface ParsedArgs {
  command: CliCommand;
  host?: string;
  port?: number;
  mock?: boolean;
  /** `--password auto`: kata sandi acak dibuat saat start. */
  password?: "auto";
  /** `--password-file <path>`: berkas berisi kata sandi. */
  passwordFile?: string;
  /** `--allow-host <host>`: host tambahan yang diizinkan; boleh diulang. */
  allowHosts?: string[];
  /** `--insecure-no-auth`: izinkan bind non-loopback tanpa kata sandi. */
  insecureNoAuth?: boolean;
  /** `--tls-cert <path>`: sertifikat TLS (harus berpasangan dengan kunci). */
  tlsCert?: string;
  /** `--tls-key <path>`: kunci TLS (harus berpasangan dengan sertifikat). */
  tlsKey?: string;
  unknown?: string;
  error?: string;
}

const PORT_ERROR = "Port harus bilangan bulat 1-65535.";

function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return null;
  }
  return value;
}

interface FlagValue {
  value?: string;
  next: number;
  error?: string;
}

function readFlagValue(rest: string[], index: number, flag: string): FlagValue {
  const token = rest[index] ?? "";
  const equals = token.indexOf("=");
  if (equals !== -1) {
    const value = token.slice(equals + 1);
    return value === ""
      ? { next: index, error: `${flag} tidak boleh kosong.` }
      : { value, next: index };
  }
  const candidate = rest[index + 1];
  if (candidate === undefined || candidate === "" || candidate.startsWith("--")) {
    return { next: index, error: `${flag} butuh nilai.` };
  }
  return { value: candidate, next: index + 1 };
}

function parseServe(rest: string[]): ParsedArgs {
  let host: string | undefined;
  let port: number | undefined;
  let mock = false;
  let password: "auto" | undefined;
  let passwordFile: string | undefined;
  let allowHosts: string[] = [];
  let insecureNoAuth = false;
  let tlsCert: string | undefined;
  let tlsKey: string | undefined;

  const fail = (error: string, unknown?: string): ParsedArgs => ({
    command: "serve",
    mock,
    ...(unknown === undefined ? {} : { unknown }),
    error,
  });

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "--mock") {
      mock = true;
      continue;
    }
    if (token === "--host" || token.startsWith("--host=")) {
      const read = readFlagValue(rest, index, "--host");
      if (read.error !== undefined) {
        return fail(read.error);
      }
      host = read.value;
      index = read.next;
      continue;
    }
    if (token === "--port" || token.startsWith("--port=")) {
      const read = readFlagValue(rest, index, "--port");
      if (read.error !== undefined) {
        return fail(read.error);
      }
      const parsed = parsePort(read.value ?? "");
      if (parsed === null) {
        return fail(`${PORT_ERROR} Diterima: ${read.value ?? ""}.`);
      }
      port = parsed;
      index = read.next;
      continue;
    }
    if (token === "--password" || token.startsWith("--password=")) {
      const inline = token.includes("=") ? token.slice(token.indexOf("=") + 1) : undefined;
      const candidate = inline ?? rest[index + 1] ?? "";
      if (candidate !== "auto") {
        return fail(
          "--password hanya menerima nilai 'auto'. " +
            "Gunakan variabel JEJAK_PASSWORD atau --password-file <path> agar sandi tidak terlihat di daftar proses.",
        );
      }
      password = "auto";
      index = inline === undefined ? index + 1 : index;
      continue;
    }
    if (token === "--password-file" || token.startsWith("--password-file=")) {
      const read = readFlagValue(rest, index, "--password-file");
      if (read.error !== undefined) {
        return fail(read.error);
      }
      passwordFile = read.value;
      index = read.next;
      continue;
    }
    if (token === "--allow-host" || token.startsWith("--allow-host=")) {
      const read = readFlagValue(rest, index, "--allow-host");
      if (read.error !== undefined) {
        return fail(read.error);
      }
      allowHosts = [...allowHosts, read.value ?? ""];
      index = read.next;
      continue;
    }
    if (token === "--insecure-no-auth") {
      insecureNoAuth = true;
      continue;
    }
    if (token === "--tls-cert" || token.startsWith("--tls-cert=")) {
      const read = readFlagValue(rest, index, "--tls-cert");
      if (read.error !== undefined) {
        return fail(read.error);
      }
      tlsCert = read.value;
      index = read.next;
      continue;
    }
    if (token === "--tls-key" || token.startsWith("--tls-key=")) {
      const read = readFlagValue(rest, index, "--tls-key");
      if (read.error !== undefined) {
        return fail(read.error);
      }
      tlsKey = read.value;
      index = read.next;
      continue;
    }
    return fail(`Flag tidak dikenal: ${token}`, token);
  }

  if ((tlsCert === undefined) !== (tlsKey === undefined)) {
    return fail("--tls-cert dan --tls-key harus dipakai berpasangan.");
  }

  return {
    command: "serve",
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(mock ? { mock } : {}),
    ...(password === undefined ? {} : { password }),
    ...(passwordFile === undefined ? {} : { passwordFile }),
    ...(allowHosts.length === 0 ? {} : { allowHosts }),
    ...(insecureNoAuth ? { insecureNoAuth } : {}),
    ...(tlsCert === undefined ? {} : { tlsCert }),
    ...(tlsKey === undefined ? {} : { tlsKey }),
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  if (first === undefined) {
    return { command: "help" };
  }
  if (first === "--help" || first === "-h") {
    return { command: "help" };
  }
  if (first === "--version" || first === "-v") {
    return { command: "version" };
  }
  if (first === "serve") {
    return parseServe(rest);
  }
  if (first === "doctor") {
    if (rest.length === 0) {
      return { command: "doctor" };
    }
    return {
      command: "doctor",
      unknown: rest[0],
      error: "doctor tidak menerima argumen tambahan.",
    };
  }
  return { command: "unknown", unknown: first };
}

export function isLoopbackHost(host: string): boolean {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const valid = parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  return valid && parts[0] === "127";
}

/**
 * True bila host adalah alamat IP literal yang bisa di-bind langsung
 * (bukan nama host dan bukan wildcard `0.0.0.0`/`::`).
 */
export function isLiteralIpHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === "") return false;
  if (value === "0.0.0.0" || value === "::" || value === "[::]") return false;
  if (value.startsWith("[")) return value.includes(":");
  if (value.includes(":")) return true;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
