import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { redactResolved, resolveProvider, type ProviderRegistry } from "../server/provider";
import { loadRegistry, providersPath } from "../server/provider-store";
import { VERSION } from "../shared/version";

export type CheckStatus = "ok" | "peringatan" | "gagal";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorContext {
  env?: Record<string, string | undefined>;
  providersPath?: string;
  resolveSdk?: () => string | null;
  log?: (line: string) => void;
}

function parseMajorMinor(v: string): [number, number] {
  const [major = "0", minor = "0"] = v.split(".");
  return [Number(major), Number(minor)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultResolveSdk(): string | null {
  try {
    return import.meta.resolve("@anthropic-ai/claude-agent-sdk");
  } catch {
    return null;
  }
}

export function formatCheck(check: Check): string {
  const label =
    check.status === "ok" ? "OK" : check.status === "peringatan" ? "PERINGATAN" : "GAGAL";
  return `${label.padEnd(3)}  ${check.name}  (${check.detail})`;
}

export async function collectChecks(ctx: DoctorContext = {}): Promise<Check[]> {
  const env = ctx.env ?? process.env;
  const path = ctx.providersPath ?? providersPath(env);
  const resolveSdk = ctx.resolveSdk ?? defaultResolveSdk;
  const checks: Check[] = [];

  const [major, minor] = parseMajorMinor(Bun.version);
  checks.push({
    name: "Bun >= 1.4",
    status: major > 1 || (major === 1 && minor >= 4) ? "ok" : "gagal",
    detail: `terdeteksi ${Bun.version}`,
  });

  const git = Bun.which("git");
  checks.push({
    name: "Git tersedia",
    status: git === null ? "gagal" : "ok",
    detail: git ?? "tidak ditemukan di PATH",
  });

  checks.push({
    name: "Binding server",
    status: "ok",
    detail: `${env.HOST ?? "127.0.0.1"}:${env.PORT ?? 3000}`,
  });

  let fileMode: number | null = null;
  try {
    const info = await stat(path);
    if (info.isFile()) {
      fileMode = info.mode;
    }
  } catch {
    fileMode = null;
  }
  const fileExists = fileMode !== null;

  let registry: ProviderRegistry | null = null;
  try {
    registry = await loadRegistry(path, env);
    if (fileExists) {
      checks.push({
        name: "Registry provider",
        status: "ok",
        detail: `${registry.profiles.length} profil, aktif: ${registry.activeProfileId ?? "-"}`,
      });
    } else {
      checks.push({
        name: "Registry provider",
        status: "ok",
        detail: "belum ada providers.json; memakai konfigurasi dari env",
      });
    }
  } catch (error) {
    checks.push({
      name: "Registry provider",
      status: "gagal",
      detail: errorMessage(error),
    });
  }

  if (registry !== null) {
    try {
      const resolved = resolveProvider(registry);
      const redacted = redactResolved(resolved);
      const hasKey = resolved.apiKey !== undefined;
      const hasModel = resolved.model !== undefined;
      const baseUrl = redacted.baseUrl ?? "belum diatur";
      const model = hasModel ? `model ${resolved.model ?? ""}` : "model belum diatur";
      const keyStatus = hasKey ? "key terisi" : "key belum diset";
      checks.push({
        name: "Profil aktif",
        status: hasKey && hasModel ? "ok" : "peringatan",
        detail: `base URL ${baseUrl}; ${model}; ${keyStatus}`,
      });
    } catch (error) {
      checks.push({
        name: "Profil aktif",
        status: "gagal",
        detail: errorMessage(error),
      });
    }
  }

  if (fileMode !== null) {
    const issues: string[] = [];
    if ((fileMode & 0o077) !== 0) {
      issues.push(`berkas dapat diakses grup/lainnya; sarankan chmod 600 ${path}`);
    }
    const directory = dirname(path);
    try {
      const dirInfo = await stat(directory);
      if ((dirInfo.mode & 0o077) !== 0) {
        issues.push(`direktori induk dapat diakses grup/lainnya; sarankan chmod 700 ${directory}`);
      }
    } catch {
      // Direktori induk tidak terbaca; tidak ada saran tambahan.
    }
    checks.push({
      name: "Izin providers.json",
      status: issues.length === 0 ? "ok" : "peringatan",
      detail: issues.length === 0 ? "izin 600/700" : issues.join("; "),
    });
  }

  let sdkLocation: string | null;
  try {
    sdkLocation = resolveSdk();
  } catch {
    sdkLocation = null;
  }
  checks.push(
    sdkLocation === null
      ? {
          name: "Claude Agent SDK",
          status: "peringatan",
          detail:
            "belum terpasang (opsional; dibutuhkan agent runner, pasang sendiri sesuai ketentuan Anthropic)",
        }
      : { name: "Claude Agent SDK", status: "ok", detail: sdkLocation },
  );

  return checks;
}

export async function runDoctor(ctx: DoctorContext = {}): Promise<number> {
  const log = ctx.log ?? console.log;
  log(`Jejak ${VERSION}\n`);
  const checks = await collectChecks(ctx);
  for (const check of checks) {
    log(formatCheck(check));
  }
  return checks.some((check) => check.status === "gagal") ? 1 : 0;
}
