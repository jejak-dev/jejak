import { homedir } from "node:os";
import { pathApi } from "../platform";

export interface NativePickResult {
  /** `undefined` bila pengguna membatalkan dialog. */
  path?: string;
}

export interface NativePickerDeps {
  platform?: NodeJS.Platform;
  run?: (cmd: string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string }>;
}

async function defaultRun(
  cmd: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

export function nativePickerAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** Skrip PowerShell dialog folder; folder awal lewat env, bukan disisipkan ke skrip. */
const WINDOWS_PICK_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Application]::EnableVisualStyles()",
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.TopMost = $true",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description = 'Pilih folder proyek'",
  "$d.ShowNewFolderButton = $true",
  "if ($env:JEJAK_PICK_START -and (Test-Path -LiteralPath $env:JEJAK_PICK_START)) { $d.SelectedPath = $env:JEJAK_PICK_START }",
  "$r = $d.ShowDialog($owner)",
  "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) } else { exit 1 }",
].join("; ");

/** Membuka dialog pilih folder milik OS (Finder di macOS, Explorer di Windows). Lainnya: galat. */
export async function pickFolderNative(
  start: string | undefined,
  deps: NativePickerDeps = {},
): Promise<NativePickResult> {
  const platform = deps.platform ?? process.platform;
  if (!nativePickerAvailable(platform)) {
    throw new Error("Dialog folder native hanya tersedia di macOS dan Windows.");
  }
  const run = deps.run ?? defaultRun;
  if (platform === "win32") {
    const winStart = start !== undefined && pathApi(platform).isAbsolute(start) ? start : "";
    const { code, stdout } = await run(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_PICK_SCRIPT],
      { JEJAK_PICK_START: winStart },
    );
    if (code !== 0) return {};
    const picked = stdout.trim();
    return picked === "" ? {} : { path: picked };
  }
  // Path absolut dicek menurut platform, bukan awalan "/".
  const dir = start !== undefined && pathApi(platform).isAbsolute(start) ? start : homedir();
  // Argumen dikirim lewat argv, bukan disisipkan ke skrip, agar path tidak bisa menyuntikkan AppleScript.
  const script = [
    "on run argv",
    "  set startDir to POSIX file (item 1 of argv)",
    '  try',
    '    set chosen to choose folder with prompt "Pilih folder proyek" default location startDir',
    "  on error errMsg number errNum",
    "    if errNum is -128 then error number -128",
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
