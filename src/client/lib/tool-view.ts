/**
 * Bentuk tampilan isi langkah tool di timeline. Murni: tanpa DOM, tidak pernah
 * melempar galat; input yang tidak sesuai bentuk jatuh ke "generic" (JSON rapi).
 */

import { splitLines } from "./files";

export type DiffLine =
  | { type: "del" | "add"; text: string }
  | { type: "sep" }
  | { type: "more"; count: number };

export type ToolView =
  | { kind: "command"; command: string; description?: string }
  | { kind: "diff"; path: string; lines: DiffLine[]; note?: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "generic" };

/** Batas baris isi (del/add) per tampilan sebelum diganti baris "… N baris lagi". */
export const MAX_VIEW_LINES = 400;

function generic(): ToolView {
  return { kind: "generic" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pathOf(input: Record<string, unknown>): string | undefined {
  return text(input.file_path) ?? text(input.path);
}

/** "mcp__server__Edit" -> "edit"; nama lain menjadi huruf kecil. */
function normalizeName(name: string): string {
  return name.replace(/^mcp__.+?__/i, "").toLowerCase();
}

interface EditParts {
  oldText: string;
  newText: string;
}

function editParts(tool: string, input: Record<string, unknown>): EditParts[] | undefined {
  if (tool === "edit") {
    const oldText = text(input.old_string);
    const newText = text(input.new_string);
    return oldText === undefined || newText === undefined ? undefined : [{ oldText, newText }];
  }
  if (tool === "multiedit") {
    const edits = input.edits;
    if (!Array.isArray(edits) || edits.length === 0) return undefined;
    const out: EditParts[] = [];
    for (const edit of edits) {
      if (!isRecord(edit)) return undefined;
      const oldText = text(edit.old_string);
      const newText = text(edit.new_string);
      if (oldText === undefined || newText === undefined) return undefined;
      out.push({ oldText, newText });
    }
    return out;
  }
  return undefined;
}

function diffLines(parts: readonly EditParts[]): DiffLine[] {
  const lines: DiffLine[] = [];
  parts.forEach((part, index) => {
    if (index > 0) lines.push({ type: "sep" });
    for (const line of splitLines(part.oldText)) lines.push({ type: "del", text: line });
    for (const line of splitLines(part.newText)) lines.push({ type: "add", text: line });
  });
  return lines;
}

function capLines(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let kept = 0;
  let dropped = 0;
  for (const line of lines) {
    if (line.type === "sep") {
      if (dropped === 0) out.push(line);
      continue;
    }
    if (kept < MAX_VIEW_LINES) {
      out.push(line);
      kept += 1;
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) out.push({ type: "more", count: dropped });
  return out;
}

/** Isi "write" dipotong untuk tampilan; `hidden` = jumlah baris yang disembunyikan. */
export function clipContent(content: string): { text: string; hidden: number } {
  const lines = splitLines(content);
  if (lines.length <= MAX_VIEW_LINES) return { text: content, hidden: 0 };
  return { text: lines.slice(0, MAX_VIEW_LINES).join("\n"), hidden: lines.length - MAX_VIEW_LINES };
}

/**
 * Teks untuk tombol salin pada tampilan diff: isi baru hasil edit (Edit), atau
 * semua isi baru yang dipisah baris (MultiEdit). Kosong bila bukan keduanya.
 */
export function diffCopyText(name: string, input: unknown): string {
  try {
    if (!isRecord(input)) return "";
    const parts = editParts(normalizeName(name), input);
    if (parts === undefined) return "";
    return parts.map((part) => part.newText).join("\n");
  } catch {
    return "";
  }
}

export function toolView(name: string, input: unknown): ToolView {
  try {
    const tool = normalizeName(name);
    if (!isRecord(input)) return generic();

    switch (tool) {
      case "bash": {
        const command = text(input.command);
        if (command === undefined) return generic();
        const description = text(input.description);
        if (description !== undefined && description !== "") {
          return { kind: "command", command, description };
        }
        return { kind: "command", command };
      }

      case "edit":
      case "multiedit": {
        const path = pathOf(input);
        const parts = editParts(tool, input);
        if (path === undefined || parts === undefined) return generic();
        const lines = capLines(diffLines(parts));
        if (tool === "edit" && input.replace_all === true) {
          return { kind: "diff", path, lines, note: "semua kemunculan" };
        }
        return { kind: "diff", path, lines };
      }

      case "write": {
        const path = pathOf(input);
        const content = text(input.content);
        if (path === undefined || content === undefined) return generic();
        return { kind: "write", path, content };
      }

      default:
        return generic();
    }
  } catch {
    return generic();
  }
}
