import { homedir } from "node:os";

export interface NativePickResult {
  /** `undefined` bila pengguna membatalkan dialog. */
  path?: string;
}

export interface NativePickerDeps {
  platform?: NodeJS.Platform;
  run?: (cmd: string[]) => Promise<{ code: number; stdout: string }>;
}

async function defaultRun(cmd: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

export function nativePickerAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/** Membuka dialog pilih folder milik OS (Finder di macOS). Hanya macOS; lainnya: galat. */
export async function pickFolderNative(
  start: string | undefined,
  deps: NativePickerDeps = {},
): Promise<NativePickResult> {
  const platform = deps.platform ?? process.platform;
  if (!nativePickerAvailable(platform)) {
    throw new Error("Dialog folder native hanya tersedia di macOS.");
  }
  const run = deps.run ?? defaultRun;
  const dir = start !== undefined && start.startsWith("/") ? start : homedir();
  // Argumen dikirim lewat argv, bukan disisipkan ke skrip, agar path tidak bisa menyuntikkan AppleScript.
  const script = [
    "on run argv",
    "  set startDir to POSIX file (item 1 of argv)",
    '  try',
    '    set chosen to choose folder with prompt "Pilih folder proyek" default location startDir',
    "  on error",
    '    set chosen to choose folder with prompt "Pilih folder proyek"',
    "  end try",
    "  return POSIX path of chosen",
    "end run",
  ];
  const cmd = ["osascript"];
  for (const line of script) cmd.push("-e", line);
  cmd.push(dir);
  const { code, stdout } = await run(cmd);
  if (code !== 0) return {}; // dibatalkan (error -128)
  const path = stdout.trim().replace(/\/+$/, "");
  return path === "" ? {} : { path };
}
