import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { hasControlCharacters } from "../memory/memory-files";
import { findSecret } from "../memory/secret-guard";
import { jejakHome } from "../provider-store";

export type ServiceKind = "backend" | "frontend" | "worker" | "library" | "lainnya";

export interface ServiceCard {
  description: string;
  kind: ServiceKind;
  tables: string[];
  queues: string[];
  calls: string[];
  updatedAt: string | null;
}

export interface WorkspaceRepo {
  name: string;
  path: string;
  card: ServiceCard;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  repos: WorkspaceRepo[];
}

export interface WorkspaceProblem {
  file: string;
  reason: string;
}

export const WORKSPACE_VERSION = 1;
export const WORKSPACE_NAME_MAX = 80;
export const WORKSPACES_MAX = 50;
export const WORKSPACE_REPOS_MAX = 20;
export const REPO_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const REPO_PATH_MAX = 1024;
export const CARD_DESCRIPTION_MAX = 1000;
export const CARD_LIST_MAX = 100;
export const CARD_ENTRY_MAX = 120;
export const WORKSPACE_FILE_MAX_BYTES = 1024 * 1024;
export const SERVICE_KINDS: ServiceKind[] = [
  "backend",
  "frontend",
  "worker",
  "library",
  "lainnya",
];

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isWorkspaceId(value: string): boolean {
  return UUID_V4.test(value);
}

/** Folder akar berkas workspace (`<JEJAK_HOME>/workspaces`). */
export function workspacesDir(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "workspaces");
}

export function initialServiceCard(): ServiceCard {
  return {
    description: "",
    kind: "lainnya",
    tables: [],
    queues: [],
    calls: [],
    updatedAt: null,
  };
}

/**
 * Path berkas untuk nama berkas `<id>.json`. `null` bila nama tidak sah,
 * supaya input mentah tidak pernah menjadi bagian path.
 */
export function workspaceFilePath(dir: string, fileName: string): string | null {
  if (!fileName.endsWith(".json")) return null;
  const id = fileName.slice(0, -".json".length);
  if (!isWorkspaceId(id)) return null;
  return join(dir, `${id}.json`);
}

function failure(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isDateText(value: string): boolean {
  return value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretReason(text: string): string | null {
  const secret = findSecret(text);
  return secret === null ? null : `memuat rahasia (${secret})`;
}

export type ParseCardResult =
  | { ok: true; card: ServiceCard }
  | { ok: false; reason: string };

function parseCardList(value: unknown, field: string): { ok: true; items: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return failure(`card.${field} harus berupa daftar`);
  if (value.length > CARD_LIST_MAX) {
    return failure(`card.${field} maks ${CARD_LIST_MAX} entri`);
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return failure(`card.${field} harus berisi teks`);
    const text = raw.trim();
    if (text === "" || text.length > CARD_ENTRY_MAX) {
      return failure(`card.${field} berisi entri di luar 1-${CARD_ENTRY_MAX} karakter`);
    }
    if (hasControlCharacters(text)) {
      return failure(`card.${field} memuat karakter kontrol`);
    }
    const secret = secretReason(text);
    if (secret !== null) return failure(`card.${field} ${secret}`);
    if (!seen.has(text)) {
      seen.add(text);
      items.push(text);
    }
  }
  return { ok: true, items };
}

export function parseServiceCard(value: unknown): ParseCardResult {
  if (!isRecord(value)) return failure("card harus berupa objek");

  const descriptionRaw = value.description;
  if (typeof descriptionRaw !== "string") return failure("card.description harus berupa teks");
  const description = descriptionRaw.trim();
  if (description.length > CARD_DESCRIPTION_MAX) {
    return failure(`card.description maks ${CARD_DESCRIPTION_MAX} karakter`);
  }
  if (hasControlCharacters(description)) return failure("card.description memuat karakter kontrol");
  const descriptionSecret = secretReason(description);
  if (descriptionSecret !== null) return failure(`card.description ${descriptionSecret}`);

  const kind = value.kind;
  if (typeof kind !== "string" || !SERVICE_KINDS.includes(kind as ServiceKind)) {
    return failure("card.kind tidak valid");
  }

  const tables = parseCardList(value.tables, "tables");
  if (!tables.ok) return tables;
  const queues = parseCardList(value.queues, "queues");
  if (!queues.ok) return queues;
  const calls = parseCardList(value.calls, "calls");
  if (!calls.ok) return calls;

  const updatedAtRaw = value.updatedAt;
  if (updatedAtRaw !== null && (typeof updatedAtRaw !== "string" || !isDateText(updatedAtRaw))) {
    return failure("card.updatedAt tidak valid");
  }

  return {
    ok: true,
    card: {
      description,
      kind: kind as ServiceKind,
      tables: tables.items,
      queues: queues.items,
      calls: calls.items,
      updatedAt: updatedAtRaw,
    },
  };
}

export type ParseWorkspaceResult =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: string };

export function parseWorkspace(text: string, fileName: string): ParseWorkspaceResult {
  if (!fileName.endsWith(".json")) return failure("nama berkas tidak valid");
  const expectedId = fileName.slice(0, -".json".length);
  if (!isWorkspaceId(expectedId)) return failure("nama berkas tidak valid");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure("JSON tidak valid");
  }
  if (!isRecord(parsed)) return failure("isi berkas harus berupa objek");

  if (parsed.version !== WORKSPACE_VERSION) return failure("versi berkas tidak dikenal");

  const id = parsed.id;
  if (typeof id !== "string" || !isWorkspaceId(id)) return failure("id bukan UUID v4");
  if (id !== expectedId) return failure("id tidak cocok dengan nama berkas");

  const nameRaw = parsed.name;
  if (typeof nameRaw !== "string") return failure("name harus berupa teks");
  const name = nameRaw.trim();
  if (name === "" || name.length > WORKSPACE_NAME_MAX) {
    return failure(`name harus 1-${WORKSPACE_NAME_MAX} karakter`);
  }
  if (hasControlCharacters(name)) return failure("name memuat karakter kontrol");
  const nameSecret = secretReason(name);
  if (nameSecret !== null) return failure(`name ${nameSecret}`);

  const createdAt = parsed.createdAt;
  if (typeof createdAt !== "string" || !isDateText(createdAt)) return failure("createdAt tidak valid");
  const updatedAt = parsed.updatedAt;
  if (typeof updatedAt !== "string" || !isDateText(updatedAt)) return failure("updatedAt tidak valid");

  const reposRaw = parsed.repos;
  if (!Array.isArray(reposRaw)) return failure("repos harus berupa daftar");
  if (reposRaw.length > WORKSPACE_REPOS_MAX) {
    return failure(`repos maks ${WORKSPACE_REPOS_MAX} entri`);
  }

  const repos: WorkspaceRepo[] = [];
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const entry of reposRaw) {
    if (!isRecord(entry)) return failure("repos berisi entri bukan objek");
    const repoName = entry.name;
    if (typeof repoName !== "string" || !REPO_NAME_PATTERN.test(repoName)) {
      return failure("nama repo tidak valid");
    }
    if (names.has(repoName)) return failure("nama repo duplikat");
    names.add(repoName);

    const repoPath = entry.path;
    if (typeof repoPath !== "string" || repoPath.includes("\0")) {
      return failure("path repo tidak valid");
    }
    if (repoPath.length > REPO_PATH_MAX || !isAbsolute(repoPath)) {
      return failure("path repo harus absolut dan maks 1024 karakter");
    }
    if (paths.has(repoPath)) return failure("path repo duplikat");
    paths.add(repoPath);

    const card = parseServiceCard(entry.card);
    if (!card.ok) return failure(card.reason);
    repos.push({ name: repoName, path: repoPath, card: card.card });
  }

  return {
    ok: true,
    workspace: { id, name, createdAt, updatedAt, repos },
  };
}

export function serializeWorkspace(workspace: Workspace): string {
  const payload = {
    version: WORKSPACE_VERSION,
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    repos: workspace.repos.map((repo) => ({
      name: repo.name,
      path: repo.path,
      card: {
        description: repo.card.description,
        kind: repo.card.kind,
        tables: repo.card.tables,
        queues: repo.card.queues,
        calls: repo.card.calls,
        updatedAt: repo.card.updatedAt,
      },
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    await chmod(path, 0o700);
  } catch {
    // Direktori induk mungkin milik sistem; berkas tetap dibatasi di bawah.
  }
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, target);
    await chmod(target, 0o600);
  } catch (error) {
    try {
      await unlink(temp);
    } catch {
      // Berkas sementara mungkin sudah tidak ada; error asli yang dilempar.
    }
    throw error;
  }
}

export async function writeWorkspaceFile(dir: string, workspace: Workspace): Promise<void> {
  if (!isWorkspaceId(workspace.id)) {
    throw new Error("Id workspace harus UUID v4.");
  }
  await ensureDirectory(dir);
  await writeFileAtomic(join(dir, `${workspace.id}.json`), serializeWorkspace(workspace));
}

export async function readWorkspaceFile(
  dir: string,
  fileName: string,
): Promise<ParseWorkspaceResult> {
  const target = workspaceFilePath(dir, fileName);
  if (target === null) return failure("nama berkas tidak valid");

  let info;
  try {
    info = await stat(target);
  } catch {
    return failure("berkas tidak ditemukan");
  }
  if (!info.isFile()) return failure("bukan berkas biasa");
  if (info.size > WORKSPACE_FILE_MAX_BYTES) return failure("berkas terlalu besar");

  let contents: string;
  try {
    contents = await readFile(target, "utf8");
  } catch {
    return failure("berkas tidak dapat dibaca");
  }
  return parseWorkspace(contents, fileName);
}

export async function deleteWorkspaceFile(dir: string, id: string): Promise<boolean> {
  const target = workspaceFilePath(dir, `${id}.json`);
  if (target === null) return false;
  try {
    await unlink(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Membaca semua `<id>.json` tanpa menulis apa pun. Berkas rusak masuk
 * `problems` dan tidak menggagalkan berkas lain.
 */
export async function scanWorkspaceFiles(
  dir: string,
): Promise<{ items: Workspace[]; problems: WorkspaceProblem[] }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { items: [], problems: [] };
  }

  const items: Workspace[] = [];
  const problems: WorkspaceProblem[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const read = await readWorkspaceFile(dir, entry.name);
    if (read.ok) {
      items.push(read.workspace);
    } else {
      problems.push({ file: entry.name, reason: read.reason });
    }
  }

  items.sort((left, right) =>
    left.name === right.name
      ? left.id.localeCompare(right.id)
      : left.name.localeCompare(right.name),
  );
  problems.sort((left, right) => left.file.localeCompare(right.file));
  return { items, problems };
}
