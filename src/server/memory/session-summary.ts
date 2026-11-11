import type { AgentEvent } from "../agent/events";
import { MEMORY_BODY_MAX, MEMORY_TITLE_MAX } from "./memory-files";

export const SESSION_SUMMARY_PREFIX = "Ringkasan sesi: ";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_FILES = 8;

export interface SessionSummary {
  title: string;
  body: string;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Buang blok lampiran yang ditempel UI di akhir pesan pengguna. */
function withoutAttachments(text: string): string {
  const index = text.indexOf("\n\nLampiran:\n");
  return index === -1 ? text : text.slice(0, index);
}

function filePathOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * Ringkasan deterministik satu sesi (tanpa panggilan model): permintaan awal,
 * berkas yang diubah, jumlah perintah, dan jawaban akhir agent. Sesi yang tak
 * melakukan apa-apa selain menjawab satu pesan tidak diringkas.
 */
export function buildSessionSummary(
  title: string,
  events: readonly AgentEvent[],
): SessionSummary | undefined {
  const prompts = events.filter((event) => event.type === "user_message");
  let commands = 0;
  let toolCalls = 0;
  const files: string[] = [];
  let finalText = "";
  let lastResult: Extract<AgentEvent, { type: "result" }> | undefined;
  for (const event of events) {
    if (event.type === "tool_call" && event.parentToolUseId === undefined) {
      toolCalls += 1;
      if (event.name === "Bash") commands += 1;
      if (FILE_TOOLS.has(event.name)) {
        const path = filePathOf(event.input);
        if (path !== undefined && !files.includes(path)) files.push(path);
      }
    } else if (event.type === "text" && event.parentToolUseId === undefined) {
      finalText = event.text;
    } else if (event.type === "result") {
      lastResult = event;
    }
  }
  if (toolCalls === 0 && prompts.length < 2) return undefined;

  const lines: string[] = [];
  const first = prompts[0];
  if (first !== undefined) lines.push(`Permintaan: ${clip(withoutAttachments(first.text), 300)}`);
  if (prompts.length > 1) lines.push(`Giliran: ${prompts.length + 1}`);
  if (files.length > 0) {
    const shown = files.slice(0, MAX_FILES).join(", ");
    const more = files.length > MAX_FILES ? ` (+${files.length - MAX_FILES} lainnya)` : "";
    lines.push(`Berkas diubah: ${shown}${more}`);
  }
  if (commands > 0) lines.push(`Perintah dijalankan: ${commands}`);
  const answer = lastResult?.summary?.trim() || finalText.trim();
  if (answer !== "") lines.push(`Jawaban akhir: ${clip(answer, 700)}`);
  if (lastResult !== undefined && !lastResult.ok) lines.push("Catatan: giliran terakhir berakhir gagal.");

  return {
    title: clip(`${SESSION_SUMMARY_PREFIX}${title}`, MEMORY_TITLE_MAX),
    body: lines.join("\n").slice(0, MEMORY_BODY_MAX),
  };
}
