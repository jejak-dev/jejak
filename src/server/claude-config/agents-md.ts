import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_INSTRUCTIONS_BYTES } from "./instructions";

/**
 * Berkas yang sudah dimuat SDK sendiri lewat `settingSources: ["project"]`.
 * Bila salah satunya ada, `AGENTS.md` tidak ditambahkan lagi supaya instruksi
 * tidak dobel (pengguna bisa mengimpornya sendiri dengan `@AGENTS.md`).
 */
const CLAUDE_FILES = [
  ["CLAUDE.md"],
  [".claude", "CLAUDE.md"],
] as const;

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Catatan system prompt berisi `AGENTS.md` di akar `cwd`, atau `undefined`
 * bila berkas tidak ada, bukan berkas biasa (symlink ditolak), kosong, lebih
 * dari 256 KB, atau `CLAUDE.md` proyek sudah ada.
 */
export function agentsMdNote(cwd: string): string | undefined {
  for (const parts of CLAUDE_FILES) {
    if (isRegularFile(join(cwd, ...parts))) return undefined;
  }
  const path = join(cwd, "AGENTS.md");
  if (!isRegularFile(path)) return undefined;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(content, "utf8") > MAX_INSTRUCTIONS_BYTES) return undefined;
  const text = content.replace(/\0/g, "").trim();
  if (text === "") return undefined;
  return `Instruksi proyek dari AGENTS.md (berlaku seperti CLAUDE.md):\n\n${text}`;
}
