import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { listSessionDirs } from "../server/checkpoints/checkpoint-service";
import { readMcpConfig, mcpServersPath } from "../server/mcp/mcp-config";
import { readMemoryFile, scanMemoryFiles } from "../server/memory/memory-files";
import { memoryDir } from "../server/memory/memory-store";
import { redactResolved, resolveProvider, type ProviderRegistry } from "../server/provider";
import { jejakHome, loadRegistry, providersPath } from "../server/provider-store";
import { readSchemaVersion, sessionsPath } from "../server/sessions/session-store";
import { sandboxAvailable } from "../server/sandbox/build-options";
import { scanWorkspaceFiles, workspacesDir } from "../server/workspaces/workspace-files";
import { locateClaude, type LocateOptions } from "../server/sdk/claude-locator";
import { detectCompiled } from "../server/sdk/sdk-loader";
import {
  getStatus,
  readActive,
  resolveActiveSdkEntry,
  sdkRoot as defaultSdkRoot,
} from "../server/sdk/sdk-store";
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
  /** Direktori root paket; default dua tingkat di atas `src/cli`. */
  packageRoot?: string;
  /** Cek ketersediaan sandbox; default memakai platform dan PATH nyata. */
  sandbox?: () => { ok: boolean; detail: string };
  /** Deteksi mode binary terkompilasi; default `detectCompiled`. */
  isCompiled?: () => boolean;
  /** Akar penyimpanan SDK terkelola; default `sdkRoot(env)`. */
  sdkRoot?: string;
  /** Opsi pencarian CLI `claude`; default bawaan `locateClaude`. */
  locate?: LocateOptions;
  /** Path binary yang berjalan; default `process.execPath`. */
  execPath?: string;
}

function parseMajorMinor(v: string): [number, number] {
  const [major = "0", minor = "0"] = v.split(".");
  return [Number(major), Number(minor)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      total += info.isDirectory() ? await directoryBytes(path) : info.size;
    } catch {
      // Berkas menghilang; lewati.
    }
  }
  return total;
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

  let compiled = false;
  try {
    compiled = (ctx.isCompiled ?? detectCompiled)();
  } catch {
    compiled = false;
  }
  const execPath = ctx.execPath ?? process.execPath;
  const sdkDir = ctx.sdkRoot ?? defaultSdkRoot(env);

  const [major, minor] = parseMajorMinor(Bun.version);
  if (compiled) {
    checks.push({
      name: "Runtime Bun",
      status: "ok",
      detail: `tertanam ${Bun.version}`,
    });
  } else {
    checks.push({
      name: "Bun >= 1.4",
      status: major > 1 || (major === 1 && minor >= 4) ? "ok" : "gagal",
      detail: `terdeteksi ${Bun.version}`,
    });
  }

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

  let sdkLocation: string | null;
  try {
    sdkLocation = resolveSdk();
  } catch {
    sdkLocation = null;
  }

  const packageRoot = ctx.packageRoot ?? join(import.meta.dir, "..", "..");
  if (compiled) {
    // Di binary terkompilasi `import.meta.dir` menunjuk ke `/$bunfs/...`,
    // jadi package.json tidak ada di sana. Cek isi paket dilewati.
    checks.push({
      name: "Pemasangan",
      status: "ok",
      detail: `binary ${execPath}; Jejak ${VERSION}; runtime Bun tertanam ${Bun.version}; data ${jejakHome(env)}`,
    });
  } else {
    try {
      const raw = await readFile(join(packageRoot, "package.json"), "utf8");
      const manifest = JSON.parse(raw) as {
        bin?: Record<string, unknown>;
        engines?: { bun?: unknown };
      };
      const binPath = typeof manifest.bin?.jejak === "string" ? manifest.bin.jejak : null;
      let binExists = false;
      if (binPath !== null) {
        try {
          binExists = (await stat(resolve(packageRoot, binPath))).isFile();
        } catch {
          binExists = false;
        }
      }
      const bunRange =
        typeof manifest.engines?.bun === "string" ? manifest.engines.bun : "tidak dicantumkan";
      checks.push({
        name: "Pemasangan",
        status: binExists ? "ok" : "peringatan",
        detail: `${packageRoot}; bin jejak ${binExists ? binPath : "tidak ditemukan"}; Bun ${Bun.version} (butuh ${bunRange}); SDK ${sdkLocation === null ? "belum terpasang" : "terpasang"}`,
      });
    } catch (error) {
      checks.push({
        name: "Pemasangan",
        status: "peringatan",
        detail: `${packageRoot}; package.json tidak terbaca (${errorMessage(error)})`,
      });
    }
  }

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

  const storagePath = sessionsPath(env);
  if (env.JEJAK_PERSIST?.trim() === "0") {
    checks.push({ name: "Penyimpanan sesi", status: "peringatan", detail: "dimatikan (JEJAK_PERSIST=0)" });
  } else {
    let storageInfo: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      storageInfo = await stat(storagePath);
      if (!storageInfo.isFile()) storageInfo = null;
    } catch {
      storageInfo = null;
    }

    if (storageInfo === null) {
      checks.push({
        name: "Penyimpanan sesi",
        status: "ok",
        detail: `${storagePath} belum ada; dibuat saat server pertama berjalan`,
      });
    } else {
      const sizeKb = Math.max(0, Math.round(storageInfo.size / 1024));
      const loose = (storageInfo.mode & 0o077) !== 0;
      const version = readSchemaVersion(storagePath);
      const versionText = version === null ? "versi skema tidak terbaca" : `skema v${version}`;
      const issues = [`${storagePath}; ${sizeKb} KB; ${versionText}`];
      if (loose) issues.push("izin lebih longgar dari 600; sarankan chmod 600");
      checks.push({
        name: "Penyimpanan sesi",
        status: loose ? "peringatan" : "ok",
        detail: issues.join("; "),
      });
    }
  }

  if (env.JEJAK_MEMORY?.trim() === "0") {
    checks.push({
      name: "Memory",
      status: "peringatan",
      detail: "dimatikan (JEJAK_MEMORY=0)",
    });
  } else {
    const dir = memoryDir(env);
    let dirInfo: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      dirInfo = await stat(dir);
      if (!dirInfo.isDirectory()) dirInfo = null;
    } catch {
      dirInfo = null;
    }

    if (dirInfo === null) {
      checks.push({
        name: "Memory",
        status: "ok",
        detail: `${dir} belum ada; dibuat saat server pertama berjalan`,
      });
    } else {
      const files = await scanMemoryFiles(dir);
      let active = 0;
      let proposed = 0;
      let problems = 0;
      for (const file of files) {
        const read = await readMemoryFile(dir, file.relPath, file.layer, file.projectKey);
        if (!read.ok) {
          problems += 1;
          continue;
        }
        if (read.memory.status === "active") active += 1;
        if (read.memory.status === "proposed") proposed += 1;
      }

      let hasIndex = false;
      try {
        const indexInfo = await stat(join(dir, "index.db"));
        hasIndex = indexInfo.isFile();
      } catch {
        hasIndex = false;
      }

      const loose = (dirInfo.mode & 0o077) !== 0;
      const issues = [
        `${dir}; ${files.length} berkas; ${active} aktif/${proposed} usulan; ${problems} problems; ${hasIndex ? "indeks ada" : "indeks belum ada"}`,
      ];
      if (loose) issues.push("izin lebih longgar dari 700; sarankan chmod 700");
      checks.push({
        name: "Memory",
        status: loose ? "peringatan" : "ok",
        detail: issues.join("; "),
      });
    }
  }

  if (env.JEJAK_WORKSPACES?.trim() === "0") {
    checks.push({
      name: "Workspace",
      status: "peringatan",
      detail: "dimatikan (JEJAK_WORKSPACES=0)",
    });
  } else {
    const dir = workspacesDir(env);
    let dirInfo: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      dirInfo = await stat(dir);
      if (!dirInfo.isDirectory()) dirInfo = null;
    } catch {
      dirInfo = null;
    }

    if (dirInfo === null) {
      checks.push({
        name: "Workspace",
        status: "ok",
        detail: `${dir} belum ada; dibuat saat workspace pertama disimpan`,
      });
    } else {
      const scanned = await scanWorkspaceFiles(dir);
      const loose = (dirInfo.mode & 0o077) !== 0;
      const issues = [
        `${dir}; ${scanned.items.length} workspace; ${scanned.problems.length} problems; ${loose ? "izin lebih longgar dari 700; sarankan chmod 700" : "izin 700"}`,
      ];
      checks.push({
        name: "Workspace",
        status: loose ? "peringatan" : "ok",
        detail: issues.join("; "),
      });
    }
  }

  if (env.JEJAK_CHECKPOINTS?.trim() === "0") {
    checks.push({
      name: "Checkpoint",
      status: "peringatan",
      detail: "dimatikan (JEJAK_CHECKPOINTS=0)",
    });
  } else {
    const dir = join(jejakHome(env), "checkpoints");
    const sessions = await listSessionDirs(dir);
    const bytes = await directoryBytes(dir);
    const git = Bun.which("git");
    const sizeText =
      bytes < 1024 * 1024
        ? `${Math.ceil(bytes / 1024)} KB`
        : `${Math.ceil(bytes / (1024 * 1024))} MB`;
    const gitText =
      git === null ? "git tidak tersedia; checkpoint tidak akan dibuat" : "git tersedia";
    checks.push({
      name: "Checkpoint",
      status: git === null ? "peringatan" : "ok",
      detail: `${dir}; ${sessions.length} sesi; ${sizeText}; ${gitText}`,
    });
  }

  if (env.JEJAK_MCP_SERVERS?.trim() === "0") {
    checks.push({
      name: "Server MCP",
      status: "peringatan",
      detail: "dimatikan (JEJAK_MCP_SERVERS=0)",
    });
  } else {
    const path = mcpServersPath(env);
    const read = await readMcpConfig(path);
    const issues = [
      `${path}; ${read.config.servers.length} server; ${read.config.servers.filter((server) => server.enabled).length} aktif; ${read.problems.length} problems`,
    ];
    let loose = false;
    if (read.missing) {
      issues[0] = `${path} belum ada; dibuat saat server MCP pertama disimpan`;
    } else {
      try {
        const info = await stat(path);
        loose = info.isFile() && (info.mode & 0o077) !== 0;
      } catch {
        loose = false;
      }
      if (read.problems.some((problem) => problem.reason === "JSON tidak valid")) {
        issues.push("berkas rusak; perbaiki atau hapus");
      }
      issues.push(loose ? "izin lebih longgar dari 600; sarankan chmod 600" : "izin 600");
    }
    checks.push({
      name: "Server MCP",
      status: loose || read.problems.length > 0 ? "peringatan" : "ok",
      detail: issues.join("; "),
    });
  }

  if (env.JEJAK_SANDBOX?.trim() === "0") {
    checks.push({
      name: "Sandbox",
      status: "ok",
      detail: "dimatikan (JEJAK_SANDBOX=0)",
    });
  } else {
    const check = ctx.sandbox ?? (() => sandboxAvailable());
    let availability: { ok: boolean; detail: string };
    try {
      availability = check();
    } catch (error) {
      availability = { ok: false, detail: errorMessage(error) };
    }
    checks.push({
      name: "Sandbox",
      status: availability.ok ? "ok" : "peringatan",
      detail: availability.detail,
    });
  }

  checks.push(await collectSdkCheck({ compiled, sdkDir, sdkLocation }));

  checks.push(await collectClaudeCliCheck(ctx, env));

  return checks;
}

/** Label sumber penemuan CLI `claude` untuk ditampilkan ke pengguna. */
export function claudeSourceLabel(source: string): string {
  switch (source) {
    case "env":
      return "JEJAK_CLAUDE_PATH";
    case "setting":
      return "pengaturan Jejak";
    case "managed":
      return "CLI bawaan SDK (terkelola)";
    case "path":
      return "PATH";
    default:
      return "lokasi umum";
  }
}

/**
 * Cek SDK Agent: SDK terkelola (kalau ada), lalu paket biasa di mode dev.
 *
 * Semua galat pembacaan berubah jadi peringatan, tidak pernah melempar.
 */
async function collectSdkCheck(info: {
  compiled: boolean;
  sdkDir: string;
  sdkLocation: string | null;
}): Promise<Check> {
  const { compiled, sdkDir, sdkLocation } = info;
  let active: Awaited<ReturnType<typeof readActive>> = null;
  try {
    active = await readActive(sdkDir);
  } catch (error) {
    return {
      name: "Claude Agent SDK",
      status: "peringatan",
      detail: `gagal membaca SDK terkelola di ${sdkDir} (${errorMessage(error)})`,
    };
  }

  if (active !== null) {
    let entry: string | null = null;
    try {
      entry = await resolveActiveSdkEntry(sdkDir);
    } catch (error) {
      return {
        name: "Claude Agent SDK",
        status: "peringatan",
        detail: `gagal memeriksa SDK terkelola di ${sdkDir} (${errorMessage(error)})`,
      };
    }
    if (entry === null) {
      return {
        name: "Claude Agent SDK",
        status: "peringatan",
        detail: `terpasang tetapi rusak; pasang ulang lewat Pengaturan (${sdkDir})`,
      };
    }
    let version = active.version;
    let previous = active.previous ?? null;
    try {
      const status = await getStatus(sdkDir);
      version = status.installed?.version ?? version;
      previous = status.previous ?? previous;
    } catch {
      // Metadata tidak terbaca; versi dari active.json sudah cukup.
    }
    const suffix = previous === null ? "" : ` (sebelumnya ${previous})`;
    return {
      name: "Claude Agent SDK",
      status: "ok",
      detail: `terkelola versi ${version} di ${sdkDir}${suffix}`,
    };
  }

  if (compiled) {
    return {
      name: "Claude Agent SDK",
      status: "peringatan",
      detail: "belum terpasang; buka Pengaturan > Claude Agent SDK lalu tekan Pasang",
    };
  }

  const location = sdkLocation;
  return location === null
    ? {
        name: "Claude Agent SDK",
        status: "peringatan",
        detail:
          "belum terpasang (opsional; dibutuhkan agent runner, pasang sendiri sesuai ketentuan Anthropic)",
      }
    : { name: "Claude Agent SDK", status: "ok", detail: location };
}

/**
 * Cek CLI `claude` milik pengguna.
 *
 * Tidak ditemukan hanya jadi peringatan; exit code doctor tidak berubah.
 */
async function collectClaudeCliCheck(
  ctx: DoctorContext,
  env: Record<string, string | undefined>,
): Promise<Check> {
  const locate = ctx.locate ?? {};
  try {
    const found = await locateClaude({ ...locate, env: locate.env ?? env });
    if (found === null) {
      return {
        name: "Claude CLI",
        status: "peringatan",
        detail:
          "tidak ditemukan; pasang Claude Code atau isi jalur di Pengaturan atau set JEJAK_CLAUDE_PATH, atau pasang CLI bawaan SDK di Pengaturan",
      };
    }
    return {
      name: "Claude CLI",
      status: "ok",
      detail: `${found.path}; ${found.version}; sumber ${claudeSourceLabel(found.source)}`,
    };
  } catch (error) {
    return {
      name: "Claude CLI",
      status: "peringatan",
      detail: `gagal mencari CLI claude (${errorMessage(error)})`,
    };
  }
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
