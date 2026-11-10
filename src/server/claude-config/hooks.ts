import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../security/redact";

export type HookSource = "proyek" | "proyek-lokal" | "pengguna";

export interface HookInfo {
  source: HookSource;
  event: string;
  matcher?: string;
  command: string;
  active: boolean;
}

export const MAX_HOOKS = 200;
export const MAX_COMMAND_LENGTH = 300;

function homeDir(home: string | undefined): string {
  return typeof home === "string" && home !== "" ? home : homedir();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeCommand(command: string): string {
  let text: string;
  try {
    text = redactSecrets(command).text;
  } catch {
    text = command;
  }
  return text.length > MAX_COMMAND_LENGTH ? text.slice(0, MAX_COMMAND_LENGTH) : text;
}

function hooksFromSettings(
  settings: unknown,
  source: HookSource,
  active: boolean,
): HookInfo[] {
  if (!isRecord(settings) || !isRecord(settings.hooks)) return [];
  const result: HookInfo[] = [];
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue;
      const matcher =
        typeof entry.matcher === "string" && entry.matcher !== "" ? entry.matcher : undefined;
      for (const hook of entry.hooks) {
        if (!isRecord(hook)) continue;
        if (hook.type !== "command") continue;
        if (typeof hook.command !== "string" || hook.command.trim() === "") continue;
        const info: HookInfo = {
          source,
          event,
          command: summarizeCommand(hook.command),
          active,
        };
        if (matcher !== undefined) info.matcher = matcher;
        result.push(info);
        if (result.length >= MAX_HOOKS) return result;
      }
    }
  }
  return result;
}

/** Baca satu berkas settings; JSON/IO rusak -> kosong (sumber dilewati). */
function readSettings(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function listHooks(
  cwd: string | undefined,
  home: string | undefined,
  userEnabled: boolean,
): HookInfo[] {
  const files: Array<{ path: string; source: HookSource; active: boolean }> = [];
  if (typeof cwd === "string" && cwd !== "") {
    files.push({ path: join(cwd, ".claude", "settings.json"), source: "proyek", active: true });
    files.push({
      path: join(cwd, ".claude", "settings.local.json"),
      source: "proyek-lokal",
      active: true,
    });
  }
  files.push({
    path: join(homeDir(home), ".claude", "settings.json"),
    source: "pengguna",
    active: userEnabled,
  });

  const result: HookInfo[] = [];
  for (const file of files) {
    const settings = readSettings(file.path);
    if (settings === undefined) continue;
    result.push(...hooksFromSettings(settings, file.source, file.active));
    if (result.length >= MAX_HOOKS) return result.slice(0, MAX_HOOKS);
  }
  return result;
}
