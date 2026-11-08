import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { hasControlCharacters } from "../memory/memory-files";
import { findSecret } from "../memory/secret-guard";
import {
  CARD_DESCRIPTION_MAX,
  CARD_ENTRY_MAX,
  CARD_LIST_MAX,
  REPO_NAME_PATTERN,
  REPO_PATH_MAX,
  SERVICE_KINDS,
  WORKSPACES_MAX,
  WORKSPACE_NAME_MAX,
  WORKSPACE_REPOS_MAX,
  initialServiceCard,
  deleteWorkspaceFile,
  scanWorkspaceFiles,
  writeWorkspaceFile,
  type ServiceCard,
  type ServiceKind,
  type Workspace,
  type WorkspaceProblem,
  type WorkspaceRepo,
} from "./workspace-files";

const SECRET_MESSAGE = (kind: string): string =>
  `Teks tampak memuat rahasia (${kind}). Hapus dulu sebelum menyimpan.`;

export type WorkspaceErrorCode = "tidak-valid" | "tidak-ditemukan" | "konflik";

export class WorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code: WorkspaceErrorCode,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

function invalid(message: string): WorkspaceError {
  return new WorkspaceError(message, "tidak-valid");
}

function notFound(id: string): WorkspaceError {
  return new WorkspaceError(`Workspace "${id}" tidak ditemukan.`, "tidak-ditemukan");
}

function conflict(message: string): WorkspaceError {
  return new WorkspaceError(message, "konflik");
}

export interface WorkspaceRepoView extends WorkspaceRepo {
  missing: boolean;
}

export interface WorkspaceView extends Omit<Workspace, "repos"> {
  repos: WorkspaceRepoView[];
}

export interface WorkspaceListResult {
  items: WorkspaceView[];
  problems: WorkspaceProblem[];
}

export interface RepoInput {
  name: string;
  path: string;
}

export interface CreateWorkspaceInput {
  name?: unknown;
  repos?: unknown;
}

export interface UpdateWorkspaceInput {
  name?: unknown;
  repos?: unknown;
}

export interface SetCardInput {
  description?: unknown;
  kind?: unknown;
  tables?: unknown;
  queues?: unknown;
  calls?: unknown;
}

export interface WorkspaceServiceOptions {
  dir: string;
  now?: () => Date;
}

export class WorkspaceService {
  readonly dir: string;
  private readonly now: () => Date;

  constructor(options: WorkspaceServiceOptions) {
    this.dir = options.dir;
    this.now = options.now ?? (() => new Date());
  }

  private clock(): string {
    return this.now().toISOString();
  }

  private normalizeName(value: unknown): string {
    if (typeof value !== "string") {
      throw invalid("Field name harus berupa teks.");
    }
    const name = value.trim();
    if (name === "" || name.length > WORKSPACE_NAME_MAX) {
      throw invalid(`Field name harus 1-${WORKSPACE_NAME_MAX} karakter.`);
    }
    if (hasControlCharacters(name)) {
      throw invalid("Field name memuat karakter kontrol yang tidak diizinkan.");
    }
    const secret = findSecret(name);
    if (secret !== null) {
      throw invalid(SECRET_MESSAGE(secret));
    }
    return name;
  }

  private async normalizeRepos(
    value: unknown,
    previous: WorkspaceRepo[] = [],
  ): Promise<WorkspaceRepo[]> {
    if (!Array.isArray(value)) {
      throw invalid("Field repos harus berupa daftar.");
    }
    if (value.length > WORKSPACE_REPOS_MAX) {
      throw conflict(`Batas ${WORKSPACE_REPOS_MAX} repo per workspace terlampaui.`);
    }

    const before = new Map(previous.map((repo) => [repo.name, repo.card]));
    const names = new Set<string>();
    const paths = new Set<string>();
    const repos: WorkspaceRepo[] = [];

    for (const entry of value) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw invalid("Setiap repo harus berupa objek { name, path }.");
      }
      const record = entry as { name?: unknown; path?: unknown };

      if (typeof record.name !== "string" || !REPO_NAME_PATTERN.test(record.name)) {
        throw invalid(
          "Nama repo harus [a-z0-9][a-z0-9._-]{0,39} (huruf kecil, angka, titik, garis bawah, strip).",
        );
      }
      const name = record.name;
      if (names.has(name)) {
        throw invalid(`Nama repo "${name}" duplikat dalam workspace.`);
      }
      names.add(name);

      const path = await this.normalizeRepoPath(record.path);
      if (paths.has(path)) {
        throw invalid(`Path repo "${path}" duplikat dalam workspace.`);
      }
      paths.add(path);

      repos.push({ name, path, card: before.get(name) ?? initialServiceCard() });
    }

    return repos;
  }

  private async normalizeRepoPath(value: unknown): Promise<string> {
    if (typeof value !== "string") {
      throw invalid("Field path repo harus berupa teks.");
    }
    const raw = value.trim();
    if (raw === "" || raw.includes("\0") || raw.length > REPO_PATH_MAX) {
      throw invalid(`Path repo harus absolut, tanpa NUL, maks ${REPO_PATH_MAX} karakter.`);
    }
    if (!isAbsolute(raw)) {
      throw invalid("Path repo harus berupa path absolut.");
    }
    let resolved: string;
    try {
      resolved = await realpath(raw);
    } catch {
      throw invalid(`Folder repo "${raw}" tidak ditemukan.`);
    }
    let info;
    try {
      info = await stat(resolved);
    } catch {
      throw invalid(`Folder repo "${raw}" tidak ditemukan.`);
    }
    if (!info.isDirectory()) {
      throw invalid(`Path repo "${raw}" bukan direktori.`);
    }
    return resolved;
  }

  private async withMissing(repo: WorkspaceRepo): Promise<WorkspaceRepoView> {
    let missing = false;
    try {
      const info = await stat(repo.path);
      missing = !info.isDirectory();
    } catch {
      missing = true;
    }
    return { ...repo, missing };
  }

  private async view(workspace: Workspace): Promise<WorkspaceView> {
    const repos = await Promise.all(workspace.repos.map((repo) => this.withMissing(repo)));
    return { ...workspace, repos };
  }

  private async readAll(): Promise<WorkspaceListResult> {
    const scanned = await scanWorkspaceFiles(this.dir);
    const items = await Promise.all(scanned.items.map((workspace) => this.view(workspace)));
    return { items, problems: scanned.problems };
  }

  async list(): Promise<WorkspaceListResult> {
    return this.readAll();
  }

  async get(id: string): Promise<WorkspaceView | null> {
    const all = await this.readAll();
    return all.items.find((workspace) => workspace.id === id) ?? null;
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceView> {
    const name = this.normalizeName(input.name);
    const repos =
      input.repos === undefined
        ? []
        : await this.normalizeRepos(input.repos);

    const existing = await this.readAll();
    if (existing.items.length >= WORKSPACES_MAX) {
      throw conflict(`Batas ${WORKSPACES_MAX} workspace sudah tercapai.`);
    }

    const at = this.clock();
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name,
      createdAt: at,
      updatedAt: at,
      repos,
    };
    await writeWorkspaceFile(this.dir, workspace);
    return this.view(workspace);
  }

  async update(id: string, input: UpdateWorkspaceInput): Promise<WorkspaceView> {
    const current = await this.get(id);
    if (current === null) {
      throw notFound(id);
    }
    if (input.name === undefined && input.repos === undefined) {
      throw invalid("Tidak ada field yang diubah.");
    }

    const name = input.name === undefined ? current.name : this.normalizeName(input.name);
    const repos =
      input.repos === undefined
        ? current.repos.map(({ missing: _missing, ...repo }) => repo)
        : await this.normalizeRepos(input.repos, current.repos);

    const workspace: Workspace = {
      id: current.id,
      name,
      createdAt: current.createdAt,
      updatedAt: this.clock(),
      repos,
    };
    await writeWorkspaceFile(this.dir, workspace);
    return this.view(workspace);
  }

  private normalizeCardText(value: unknown, field: string, max: number): string {
    if (typeof value !== "string") {
      throw invalid(`Field ${field} harus berupa teks.`);
    }
    const text = value.trim();
    if (text.length > max) {
      throw invalid(`Field ${field} maks ${max} karakter.`);
    }
    if (hasControlCharacters(text)) {
      throw invalid(`Field ${field} memuat karakter kontrol yang tidak diizinkan.`);
    }
    const secret = findSecret(text);
    if (secret !== null) {
      throw invalid(SECRET_MESSAGE(secret));
    }
    return text;
  }

  private normalizeCardList(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
      throw invalid(`Field ${field} harus berupa daftar.`);
    }
    if (value.length > CARD_LIST_MAX) {
      throw invalid(`Field ${field} maks ${CARD_LIST_MAX} entri.`);
    }
    const seen = new Set<string>();
    const items: string[] = [];
    for (const raw of value) {
      const text = this.normalizeCardText(raw, field, CARD_ENTRY_MAX);
      if (text === "") {
        throw invalid(`Field ${field} berisi entri kosong.`);
      }
      if (!seen.has(text)) {
        seen.add(text);
        items.push(text);
      }
    }
    return items;
  }

  async setCard(id: string, repoName: string, input: SetCardInput): Promise<WorkspaceView> {
    const current = await this.get(id);
    if (current === null) {
      throw notFound(id);
    }
    const index = current.repos.findIndex((repo) => repo.name === repoName);
    if (index === -1) {
      throw notFound(`${id}/${repoName}`);
    }
    if (
      input.description === undefined &&
      input.kind === undefined &&
      input.tables === undefined &&
      input.queues === undefined &&
      input.calls === undefined
    ) {
      throw invalid("Tidak ada field yang diubah.");
    }

    const existing = current.repos[index]!;
    const card: ServiceCard = { ...existing.card };

    if (input.description !== undefined) {
      card.description = this.normalizeCardText(
        input.description,
        "description",
        CARD_DESCRIPTION_MAX,
      );
    }
    if (input.kind !== undefined) {
      if (
        typeof input.kind !== "string" ||
        !SERVICE_KINDS.includes(input.kind as ServiceKind)
      ) {
        throw invalid(`Field kind harus salah satu: ${SERVICE_KINDS.join(", ")}.`);
      }
      card.kind = input.kind as ServiceKind;
    }
    if (input.tables !== undefined) card.tables = this.normalizeCardList(input.tables, "tables");
    if (input.queues !== undefined) card.queues = this.normalizeCardList(input.queues, "queues");
    if (input.calls !== undefined) card.calls = this.normalizeCardList(input.calls, "calls");
    card.updatedAt = this.clock();

    const repos: WorkspaceRepo[] = current.repos.map((repo, position) =>
      position === index
        ? { name: repo.name, path: repo.path, card }
        : { name: repo.name, path: repo.path, card: repo.card },
    );
    const workspace: Workspace = {
      id: current.id,
      name: current.name,
      createdAt: current.createdAt,
      updatedAt: this.clock(),
      repos,
    };
    await writeWorkspaceFile(this.dir, workspace);
    return this.view(workspace);
  }

  /**
   * Menghapus hanya berkas workspace; folder repo tidak pernah disentuh.
   */
  async delete(id: string): Promise<void> {
    const current = await this.get(id);
    if (current === null) {
      throw notFound(id);
    }
    const removed = await deleteWorkspaceFile(this.dir, id);
    if (!removed) {
      throw notFound(id);
    }
  }
}
