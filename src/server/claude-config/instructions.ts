import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type InstructionScope = "user" | "project";

export interface InstructionFile {
  path: string;
  exists: boolean;
  content: string;
}

export type InstructionsErrorCode = "terlalu-besar" | "tidak-valid";

export class InstructionsError extends Error {
  constructor(
    message: string,
    public readonly code: InstructionsErrorCode,
  ) {
    super(message);
    this.name = "InstructionsError";
  }
}

export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

function homeDir(home: string | undefined): string {
  return typeof home === "string" && home !== "" ? home : homedir();
}

/** Jalur tetap per cakupan; tidak pernah menerima jalur dari klien. */
export function instructionPath(
  scope: InstructionScope,
  cwd: string,
  home?: string,
): string {
  if (scope === "user") {
    return join(homeDir(home), ".claude", "CLAUDE.md");
  }
  if (scope !== "project") {
    throw new InstructionsError("Cakupan instruksi tidak valid.", "tidak-valid");
  }
  return join(validateCwd(cwd), "CLAUDE.md");
}

function validateCwd(cwd: unknown): string {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new InstructionsError("cwd wajib diisi untuk cakupan proyek.", "tidak-valid");
  }
  if (!isAbsolute(cwd)) {
    throw new InstructionsError("cwd harus berupa path absolut.", "tidak-valid");
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new InstructionsError("cwd tidak ditemukan atau bukan direktori.", "tidak-valid");
  }
  return cwd;
}

function assertSize(text: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_INSTRUCTIONS_BYTES) {
    throw new InstructionsError("Isi CLAUDE.md melebihi batas 256 KB.", "terlalu-besar");
  }
}

export function readInstructions(
  scope: InstructionScope,
  cwd: string | undefined,
  home?: string,
): InstructionFile {
  const path = instructionPath(scope, cwd ?? "", home);
  if (!existsSync(path)) {
    return { path, exists: false, content: "" };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new InstructionsError("CLAUDE.md tidak dapat dibaca.", "tidak-valid");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_INSTRUCTIONS_BYTES) {
    throw new InstructionsError("Isi CLAUDE.md melebihi batas 256 KB.", "terlalu-besar");
  }
  return { path, exists: true, content };
}

/** Tulis atomik (berkas sementara + rename); direktori `.claude` dibuat bila perlu. */
export function writeInstructions(
  scope: InstructionScope,
  cwd: string | undefined,
  content: string,
  home?: string,
): InstructionFile {
  if (typeof content !== "string") {
    throw new InstructionsError("Isi CLAUDE.md harus berupa teks.", "tidak-valid");
  }
  assertSize(content);
  const path = instructionPath(scope, cwd ?? "", home);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content, { mode: 0o644 });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Berkas sementara mungkin sudah hilang; galat asli yang dilempar.
    }
    throw error;
  }
  return { path, exists: true, content };
}
