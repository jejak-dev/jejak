import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export type AgentScope = "user" | "project";

export interface AgentInfo {
  scope: AgentScope;
  name: string;
  description: string;
  /** Daftar tool dari frontmatter `tools` (kosong = mewarisi semua). */
  tools: string[];
  model: string;
  path: string;
  /** Alasan berkas tidak dapat dipakai (mis. terlalu besar). */
  invalid?: string;
}

export interface AgentFile extends AgentInfo {
  content: string;
}

export type AgentErrorCode = "tidak-valid" | "tidak-ditemukan" | "terlalu-besar";

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: AgentErrorCode,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export const MAX_AGENTS = 200;
export const MAX_AGENT_BYTES = 64 * 1024;
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const TOO_BIG = "Berkas subagent melebihi batas 64 KB.";

function homeDir(home: string | undefined): string {
  return typeof home === "string" && home !== "" ? home : homedir();
}

function validateCwd(cwd: string | undefined): string {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new AgentError("cwd wajib diisi untuk cakupan proyek.", "tidak-valid");
  }
  if (!isAbsolute(cwd)) {
    throw new AgentError("cwd harus berupa path absolut.", "tidak-valid");
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new AgentError("cwd tidak ditemukan atau bukan direktori.", "tidak-valid");
  }
  return cwd;
}

function validateName(name: unknown): string {
  if (typeof name !== "string" || !AGENT_NAME_PATTERN.test(name)) {
    throw new AgentError("Nama subagent tidak valid.", "tidak-valid");
  }
  return name;
}

/** Akar subagent untuk satu cakupan; jalur tetap, bukan dari klien. */
export function agentsRoot(scope: AgentScope, cwd: string | undefined, home?: string): string {
  if (scope === "user") return join(homeDir(home), ".claude", "agents");
  if (scope !== "project") {
    throw new AgentError("Cakupan subagent hanya user atau project.", "tidak-valid");
  }
  return join(validateCwd(cwd), ".claude", "agents");
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(rootReal: string, target: string): boolean {
  return target === rootReal || target.startsWith(rootReal + sep);
}

function assertInside(rootReal: string, target: string): void {
  if (!isInside(rootReal, realOrSelf(target))) {
    throw new AgentError("Jalur subagent di luar folder agents.", "tidak-valid");
  }
}

/** Ambil nilai kunci frontmatter YAML sederhana (satu baris) tanpa dependensi. */
export function frontmatterValue(content: string, key: string): string {
  if (!content.startsWith("---")) return "";
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return "";
  const pattern = new RegExp(`^${key}\\s*:\\s*(.*)$`);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") break;
    const match = pattern.exec(line);
    if (match === null) continue;
    let value = (match[1] ?? "").trim();
    if (value.length >= 2) {
      const first = value.charAt(0);
      const last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    return value;
  }
  return "";
}

/** Daftar tool dari `tools: A, B` atau `tools: [A, B]`. */
export function parseTools(content: string): string[] {
  let raw = frontmatterValue(content, "tools").trim();
  if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
  return raw
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter((part) => part !== "");
}

function readAgentFile(path: string): { content: string; invalid?: string } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { content: "" };
  }
  if (size > MAX_AGENT_BYTES) return { content: "", invalid: TOO_BIG };
  try {
    const content = readFileSync(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_AGENT_BYTES) {
      return { content: "", invalid: TOO_BIG };
    }
    return { content };
  } catch {
    return { content: "", invalid: "Berkas subagent tidak dapat dibaca." };
  }
}

function infoFrom(scope: AgentScope, name: string, path: string, content: string, invalid?: string): AgentInfo {
  const info: AgentInfo = {
    scope,
    name,
    description: invalid === undefined ? frontmatterValue(content, "description") : "",
    tools: invalid === undefined ? parseTools(content) : [],
    model: invalid === undefined ? frontmatterValue(content, "model") : "",
    path,
  };
  if (invalid !== undefined) info.invalid = invalid;
  return info;
}

function listScope(
  scope: AgentScope,
  cwd: string | undefined,
  home: string | undefined,
  limit: number,
): AgentInfo[] {
  const root = agentsRoot(scope, cwd, home);
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
  const rootReal = realOrSelf(root);
  const result: AgentInfo[] = [];
  for (const name of names) {
    if (result.length >= limit) break;
    if (!AGENT_NAME_PATTERN.test(name)) continue;
    const path = join(root, `${name}.md`);
    if (!isInside(rootReal, realOrSelf(path))) continue;
    const read = readAgentFile(path);
    result.push(infoFrom(scope, name, path, read.content, read.invalid));
  }
  return result;
}

export function listAgents(cwd: string | undefined, home?: string): AgentInfo[] {
  const project = cwd === undefined ? [] : listScope("project", cwd, home, MAX_AGENTS);
  const user = listScope("user", cwd, home, Math.max(0, MAX_AGENTS - project.length));
  return [...project, ...user];
}

function agentPath(scope: AgentScope, name: string, cwd: string | undefined, home: string | undefined) {
  const root = agentsRoot(scope, cwd, home);
  const path = join(root, `${name}.md`);
  if (existsSync(path)) assertInside(realOrSelf(root), path);
  return { root, path };
}

export function readAgent(scope: AgentScope, name: unknown, cwd?: string, home?: string): AgentFile {
  const agent = validateName(name);
  const { path } = agentPath(scope, agent, cwd, home);
  if (!existsSync(path)) {
    throw new AgentError(`Subagent "${agent}" tidak ditemukan.`, "tidak-ditemukan");
  }
  const read = readAgentFile(path);
  if (read.invalid !== undefined) throw new AgentError(read.invalid, "terlalu-besar");
  return { ...infoFrom(scope, agent, path, read.content), content: read.content };
}

export function writeAgent(
  scope: AgentScope,
  name: unknown,
  content: string,
  cwd?: string,
  home?: string,
): AgentFile {
  const agent = validateName(name);
  if (typeof content !== "string") {
    throw new AgentError("Isi subagent harus berupa teks.", "tidak-valid");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_AGENT_BYTES) {
    throw new AgentError(TOO_BIG, "terlalu-besar");
  }
  const { root, path } = agentPath(scope, agent, cwd, home);
  if (!existsSync(path) && countAgents(root) >= MAX_AGENTS) {
    throw new AgentError(`Batas ${MAX_AGENTS} subagent terlampaui.`, "tidak-valid");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertInside(realOrSelf(root), path);
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
  return { ...infoFrom(scope, agent, path, content), content };
}

function countAgents(root: string): number {
  try {
    return readdirSync(root, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".md"),
    ).length;
  } catch {
    return 0;
  }
}
