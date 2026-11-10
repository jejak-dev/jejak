export type CliCommand = "serve" | "doctor" | "version" | "help" | "unknown";

export interface ParsedArgs {
  command: CliCommand;
  host?: string;
  port?: number;
  mock?: boolean;
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

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "--mock") {
      mock = true;
      continue;
    }
    if (token === "--host" || token.startsWith("--host=")) {
      const read = readFlagValue(rest, index, "--host");
      if (read.error !== undefined) {
        return { command: "serve", mock, error: read.error };
      }
      host = read.value;
      index = read.next;
      continue;
    }
    if (token === "--port" || token.startsWith("--port=")) {
      const read = readFlagValue(rest, index, "--port");
      if (read.error !== undefined) {
        return { command: "serve", mock, error: read.error };
      }
      const parsed = parsePort(read.value ?? "");
      if (parsed === null) {
        return {
          command: "serve",
          mock,
          error: `${PORT_ERROR} Diterima: ${read.value ?? ""}.`,
        };
      }
      port = parsed;
      index = read.next;
      continue;
    }
    return {
      command: "serve",
      mock,
      unknown: token,
      error: `Flag tidak dikenal: ${token}`,
    };
  }

  return {
    command: "serve",
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(mock ? { mock } : {}),
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
