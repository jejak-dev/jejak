/**
 * Probe agent ACP: "terpasang? sudah login? siap dipakai?" tanpa mengirim
 * prompt. Jejak tidak menyimpan kredensial; probe hanya membaca status dari
 * agent, lalu menutup prosesnya lewat `client.close()`.
 */
import { AcpClient, AcpError, spawnTransport, type AcpTransport } from "./acp-client";
import { getAcpAgent, type AcpAgentDef } from "./agent-defs";

export type AcpAgentState = "tidak-terpasang" | "belum-login" | "siap" | "galat";

export interface AcpAgentStatus {
  id: string;
  label: string;
  state: AcpAgentState;
  hint?: string;
  authMethods?: { id: string; name: string }[];
  models?: number;
  detail?: string;
}

export interface ProbeDeps {
  which?: (cmd: string) => string | null;
  spawnTransport?: typeof spawnTransport;
  timeoutMs?: number;
  env?: Record<string, string>;
}

const TIMEOUT_BAWAAN_MS = 10_000;
const BATAS_DETAIL = 300;
const POLA_RAHASIA = /(key|token|secret|password)\s*[=:]\s*\S+/gi;

/** Buang string mirip rahasia lalu potong panjangnya. */
function samarkan(teks: string): string {
  return teks.replace(POLA_RAHASIA, "$1=[disamarkan]").slice(0, BATAS_DETAIL);
}

function pesanGalat(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Jumlah opsi pada config option ber-kategori model; undefined bila tak ada. */
function hitungModel(configOptions: unknown[]): number | undefined {
  for (const item of configOptions) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.category !== "model") continue;
    return Array.isArray(record.options) ? record.options.length : undefined;
  }
  return undefined;
}

export async function probeAgent(
  def: AcpAgentDef,
  cwd: string,
  deps?: ProbeDeps,
): Promise<AcpAgentStatus> {
  const which = deps?.which ?? ((cmd: string) => Bun.which(cmd));
  const spawn = deps?.spawnTransport ?? spawnTransport;
  const timeoutMs = deps?.timeoutMs ?? TIMEOUT_BAWAAN_MS;
  const dasar = { id: def.id, label: def.label };

  const perintah = def.command[0];
  if (perintah === undefined || which(perintah) === null) {
    return { ...dasar, state: "tidak-terpasang", hint: def.installHint };
  }

  let transport: AcpTransport;
  try {
    transport = spawn(def.command, cwd, deps?.env);
  } catch {
    // Perintah tak bisa dijalankan sama sekali.
    return { ...dasar, state: "tidak-terpasang", hint: def.installHint };
  }

  let exitCode: number | null | undefined;
  const client = new AcpClient(transport, {
    requestTimeoutMs: timeoutMs,
    onExit: (code) => {
      exitCode = code;
    },
  });

  let authMethods: { id: string; name: string }[] | undefined;
  try {
    const init = await client.initialize();
    authMethods = init.authMethods;
    const sesi = await client.newSession(cwd);
    const models = hitungModel(sesi.configOptions);
    return models === undefined
      ? { ...dasar, state: "siap" }
      : { ...dasar, state: "siap", models };
  } catch (error) {
    if (error instanceof AcpError && error.needsAuth) {
      return authMethods === undefined
        ? { ...dasar, state: "belum-login", hint: def.loginHint }
        : { ...dasar, state: "belum-login", hint: def.loginHint, authMethods };
    }
    if (exitCode === 127) {
      // Executable tak bisa dijalankan (keluar ala shell) sebelum membalas.
      return { ...dasar, state: "tidak-terpasang", hint: def.installHint };
    }
    return { ...dasar, state: "galat", detail: samarkan(pesanGalat(error)) };
  } finally {
    client.close();
  }
}

export async function probeAgentById(
  id: string,
  cwd: string,
  deps?: ProbeDeps,
): Promise<AcpAgentStatus | undefined> {
  const def = getAcpAgent(id);
  if (!def) return undefined;
  return probeAgent(def, cwd, deps);
}
