import { runGit, type GitOptions } from "../files/changes";
import type { GitProviderProfile } from "../gitprovider/provider-store";

export interface RemoteMatch {
  providerId: string;
  fullPath: string;
}

interface ParsedRemote {
  host: string;
  /** Port eksplisit; "" bila remote tidak menyebut port. */
  port: string;
  path: string;
}

/**
 * Memecah alamat remote git menjadi host, port, dan jalur.
 * Menangani `https://host/grup/proyek.git`, `ssh://git@host:2222/grup/proyek.git`,
 * dan gaya scp `git@host:grup/proyek.git`.
 */
function parseRemote(remoteUrl: string): ParsedRemote | undefined {
  const raw = remoteUrl.trim();
  if (raw === "") return undefined;

  if (!raw.includes("://")) {
    const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(raw);
    if (scp !== null) {
      return { host: (scp[1] ?? "").toLowerCase(), port: "", path: scp[2] ?? "" };
    }
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const protocol = url.protocol.replace(":", "");
  if (protocol !== "http" && protocol !== "https" && protocol !== "ssh" && protocol !== "git") {
    return undefined;
  }
  return { host: url.hostname.toLowerCase(), port: url.port, path: url.pathname };
}

/** Jalur remote menjadi `fullPath`: tanpa garis miring di ujung dan tanpa `.git`. */
function toFullPath(path: string): string {
  let value = path;
  try {
    value = decodeURIComponent(value);
  } catch {
    // Jalur bukan percent-encoded valid; pakai bentuk mentah.
  }
  value = value.replace(/^\/+/, "").replace(/\/+$/, "");
  if (value.endsWith(".git")) value = value.slice(0, -".git".length);
  return value;
}

/** Port bawaan dari skema base URL profil. */
function defaultPort(protocol: string): string {
  if (protocol === "https:") return "443";
  if (protocol === "http:") return "80";
  if (protocol === "ssh:") return "22";
  return "";
}

/**
 * Mencocokkan remote origin dengan profil GitLab. Hanya profil gitlab yang
 * dipakai; profil lain diabaikan. Host dibandingkan huruf kecil; port hanya
 * dibandingkan bila remote menyebut port.
 */
export function matchRemote(
  remoteUrl: string,
  profiles: readonly GitProviderProfile[],
): RemoteMatch | undefined {
  const parsed = parseRemote(remoteUrl);
  if (parsed === undefined) return undefined;
  const fullPath = toFullPath(parsed.path);
  if (fullPath === "") return undefined;

  for (const profile of profiles) {
    if (profile.kind !== "gitlab" || profile.baseUrl === undefined) continue;
    let base: URL;
    try {
      base = new URL(profile.baseUrl);
    } catch {
      continue;
    }
    if (base.hostname.toLowerCase() !== parsed.host) continue;
    if (parsed.port !== "") {
      const basePort = base.port === "" ? defaultPort(base.protocol) : base.port;
      if (parsed.port !== basePort) continue;
    }
    return { providerId: profile.id, fullPath };
  }
  return undefined;
}

/** Alamat remote `origin` sebuah folder; undefined bila tidak ada atau bukan repo. */
export async function originOf(
  cwd: string,
  options: GitOptions = {},
): Promise<string | undefined> {
  const result = await runGit(["remote", "get-url", "origin"], cwd, options, 4096);
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value === "" ? undefined : value;
}
