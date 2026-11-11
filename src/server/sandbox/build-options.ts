import { join } from "node:path";
import type { SandboxConfig, SandboxMode } from "./sandbox-config";

/** Domain bawaan yang boleh diakses Bash di dalam sandbox. */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
];

/** Jalur relatif proyek yang tidak boleh ditulis agent (hook/skill/config dirinya). */
export const DEFAULT_DENY_WRITE_REL: readonly string[] = [
  ".git/hooks",
  ".git/config",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/skills",
];

/** Jalur relatif terhadap home yang tidak boleh dibaca agent. */
export const DEFAULT_DENY_READ_REL: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gcloud",
  ".kube",
  ".docker/config.json",
  ".npmrc",
  ".netrc",
  ".git-credentials",
];

export interface SandboxOptionsInput {
  mode: SandboxMode;
  config: SandboxConfig;
  home: string;
  jejakHome: string;
  /** Folder kerja sesi; untuk worktree: worktree DAN repo asli. */
  projectRoots: string[];
  /** Folder yang boleh ditulis selain folder kerja (workspace, repoRoot worktree). */
  extraWriteDirs: string[];
  /** Host penyedia model profil aktif. */
  providerHosts: string[];
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function uniqueOrdered(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Apakah `entry` sama dengan `target` atau merupakan leluhurnya. */
function isSameOrParent(entry: string, target: string): boolean {
  if (entry === target) return true;
  if (entry === "/") return true;
  return target.startsWith(`${entry}/`);
}

export interface SafeWriteGuard {
  home: string;
  jejakHome: string;
  denyRead: readonly string[];
}

/**
 * Jalur tulis tambahan aman bila bukan home/jejakHome, bukan leluhur
 * keduanya atau jalur denyRead, dan tidak berada di dalam jejakHome
 * maupun di dalam jalur denyRead (mis. ~/.ssh/authorized_keys).
 * Jalur spesifik di dalam home (mis. ~/tmp) tetap boleh.
 */
export function isSafeWritePath(path: string, guard: SafeWriteGuard): boolean {
  const value = normalizePath(path);
  const home = normalizePath(guard.home);
  const jejakHome = normalizePath(guard.jejakHome);
  if (isSameOrParent(value, home)) return false;
  if (isSameOrParent(value, jejakHome)) return false;
  if (isSameOrParent(jejakHome, value)) return false;
  for (const deny of guard.denyRead) {
    const normalizedDeny = normalizePath(deny);
    if (isSameOrParent(value, normalizedDeny)) return false;
    if (isSameOrParent(normalizedDeny, value)) return false;
  }
  return true;
}

/**
 * Opsi `sandbox` untuk SDK. `mati` menghasilkan `undefined` sehingga perilaku
 * lama (tanpa opsi sandbox) berlaku persis.
 */
export function buildSandboxOptions(
  input: SandboxOptionsInput,
): Record<string, unknown> | undefined {
  if (input.mode === "mati") return undefined;

  const denyWrite: string[] = [];
  for (const root of uniqueOrdered(input.projectRoots)) {
    for (const rel of DEFAULT_DENY_WRITE_REL) {
      denyWrite.push(join(root, rel));
    }
  }
  for (const path of input.config.extraDenyWrite) {
    denyWrite.push(expandHome(path, input.home));
  }

  const denyRead: string[] = [];
  for (const rel of DEFAULT_DENY_READ_REL) {
    denyRead.push(join(input.home, rel));
  }
  denyRead.push(input.jejakHome);
  for (const path of input.config.extraDenyRead) {
    denyRead.push(expandHome(path, input.home));
  }

  const allowedDomains = uniqueOrdered([
    ...DEFAULT_ALLOWED_DOMAINS,
    ...input.config.allowedDomains,
    ...input.providerHosts,
  ]);

  const writeGuard: SafeWriteGuard = {
    home: input.home,
    jejakHome: input.jejakHome,
    denyRead,
  };
  const extraAllowedWrite = input.config.extraAllowWrite
    .map((path) => expandHome(path, input.home))
    .filter((path) => isSafeWritePath(path, writeGuard));

  const network: Record<string, unknown> = {
    allowedDomains,
    strictAllowlist: true,
    allowLocalBinding: input.config.allowLocalBinding,
  };
  const unixSockets = uniqueSorted(
    input.config.extraAllowUnixSockets
      .map((path) => expandHome(path, input.home))
      .filter((path) => !isSameOrParent(normalizePath(input.jejakHome), normalizePath(path))),
  );
  if (unixSockets.length > 0) network.allowUnixSockets = unixSockets;

  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: uniqueSorted([...input.extraWriteDirs, ...extraAllowedWrite]),
      denyWrite: uniqueSorted(denyWrite),
      denyRead: uniqueSorted(denyRead),
    },
    network,
  };
}

/** Host dari `baseUrl` untuk allowlist jaringan; kosong bila URL tak valid. */
export function providerHostsFrom(baseUrl?: string): string[] {
  if (baseUrl === undefined || baseUrl.trim() === "") return [];
  try {
    const host = new URL(baseUrl).hostname.trim().toLowerCase();
    return host === "" ? [] : [host];
  } catch {
    return [];
  }
}

export interface SandboxAvailability {
  ok: boolean;
  detail: string;
}

/** Apakah prasyarat sandbox SDK tersedia di mesin ini. */
export function sandboxAvailable(
  platform: string = process.platform,
  which: (name: string) => string | null = Bun.which,
): SandboxAvailability {
  if (platform === "darwin") {
    const found = which("sandbox-exec");
    return found === null
      ? { ok: false, detail: "sandbox-exec tidak ditemukan; sandbox macOS tidak tersedia." }
      : { ok: true, detail: `sandbox-exec tersedia (${found})` };
  }
  if (platform === "linux") {
    const bwrap = which("bwrap");
    if (bwrap === null) {
      return {
        ok: false,
        detail: "bwrap tidak ditemukan; pasang bubblewrap agar sandbox Bash tersedia.",
      };
    }
    const socat = which("socat");
    return socat === null
      ? {
          ok: true,
          detail: `bwrap tersedia (${bwrap}); socat tidak ditemukan, sebagian pembatasan jaringan mungkin tidak berlaku.`,
        }
      : { ok: true, detail: `bwrap tersedia (${bwrap}); socat tersedia (${socat})` };
  }
  return {
    ok: false,
    detail: `Sandbox tidak didukung di platform ${platform}.`,
  };
}

/** Baris pelanggaran dari blok `<sandbox_violations>` pada hasil tool Bash. */
export function extractSandboxViolations(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const match = /<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/i.exec(text);
  if (match === null) return [];
  const body = match[1] ?? "";
  const lines: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "") continue;
    lines.push(line.slice(0, 200));
    if (lines.length >= 5) break;
  }
  return lines;
}

/** Petunjuk tambahan bila giliran gagal karena sandbox tak tersedia. */
export function describeSandboxFailure(message: string): string | undefined {
  if (typeof message !== "string") return undefined;
  if (!/sandbox/i.test(message)) return undefined;
  return " Sandbox tidak tersedia di mesin ini; pasang prasyaratnya (lihat jejak doctor) atau buat sesi tanpa sandbox.";
}
