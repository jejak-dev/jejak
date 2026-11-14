import { join } from "node:path";
import { jejakHome } from "../provider-store";
import {
  deleteMemoryFile,
  readProjectMapping,
  writeMemoryFile,
  type Memory,
  type MemoryConfidence,
  type MemoryStatus,
} from "./memory-files";
import {
  MemoryIndex,
  type MemoryCounts,
  type MemoryListQuery,
  type MemoryProblem,
} from "./memory-index";
import {
  cleanupEmptyProjectFolders,
  folderProjectHeading,
  listProjectFolders,
  migrateMemoryLayout,
  writeFolderIndex,
  writeRootIndex,
  type FolderIndexEntry,
  type MigrationResult,
  type RootIndexFolder,
} from "./memory-layout";

export interface MemoryStore {
  /** Folder akar berkas memory (`<JEJAK_HOME>/memory`). */
  readonly dir: string;
  sync(): Promise<MemoryProblem[]>;
  problems(): MemoryProblem[];
  list(query?: MemoryListQuery): Promise<Memory[]>;
  get(id: string): Promise<Memory | null>;
  create(memory: Memory): Promise<Memory>;
  update(memory: Memory): Promise<Memory>;
  setStatus(
    id: string,
    status: MemoryStatus,
    confidence: MemoryConfidence,
    decidedAt: string | null,
  ): Promise<Memory | null>;
  delete(id: string): Promise<boolean>;
  counts(): Promise<MemoryCounts>;
  countActive(layer: Memory["layer"], projectKey: string | null): Promise<number>;
  countProposed(): Promise<number>;
  close(): void;
}

export function memoryDir(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "memory");
}

export function memoryIndexPath(env: Record<string, string | undefined> = process.env): string {
  return join(memoryDir(env), "index.db");
}

export interface MemoryStoreOptions {
  dir: string;
  indexPath?: string;
  now?: () => Date;
}

/** Menggabungkan masalah migrasi dan pemindaian tanpa duplikat. */
function mergeProblems(
  migration: MemoryProblem[],
  scan: MemoryProblem[],
): MemoryProblem[] {
  const merged = new Map<string, MemoryProblem>();
  for (const problem of [...migration, ...scan]) {
    merged.set(`${problem.file}\u0000${problem.reason}`, problem);
  }
  return [...merged.values()].sort((left, right) => left.file.localeCompare(right.file));
}

export class FileMemoryStore implements MemoryStore {
  readonly dir: string;
  private readonly index: MemoryIndex;
  private lastProblems: MemoryProblem[] = [];
  private readonly now: () => Date;
  private migrated = false;
  private synced = false;

  constructor(options: MemoryStoreOptions) {
    this.dir = options.dir;
    this.index = new MemoryIndex(options.indexPath ?? join(options.dir, "index.db"));
    this.now = options.now ?? (() => new Date());
  }

  async sync(): Promise<MemoryProblem[]> {
    const migration = await this.runMigration();
    const scanProblems = await this.index.sync(this.dir);
    // Folder proyek yang tidak lagi berisi memory dibersihkan; `INDEX.md`
    // akar ditulis ulang supaya tidak menautkan folder yang sudah dihapus.
    const removedFolders = await cleanupEmptyProjectFolders(this.dir);
    this.lastProblems = mergeProblems(migration.problems, scanProblems);
    this.synced = true;
    if (migration.changedFolders.length > 0) {
      for (const folder of migration.changedFolders) {
        await this.writeFolderIndexFile(folder);
      }
    }
    if (
      migration.changedFolders.length > 0 ||
      migration.removedFolders.length > 0 ||
      removedFolders.length > 0
    ) {
      await this.writeRootIndexFile();
    }
    return this.lastProblems;
  }

  /** Migrasi layout dijalankan sekali per instance store. */
  private async runMigration(): Promise<MigrationResult> {
    if (this.migrated) return { problems: [], changedFolders: [], removedFolders: [] };
    this.migrated = true;
    try {
      return await migrateMemoryLayout(this.dir);
    } catch {
      // Migrasi yang gagal tidak boleh memblokir pemakaian memory.
      return { problems: [], changedFolders: [], removedFolders: [] };
    }
  }

  problems(): MemoryProblem[] {
    return this.lastProblems;
  }

  async list(query: MemoryListQuery = {}): Promise<Memory[]> {
    await this.sync();
    return this.index.list(query);
  }

  async get(id: string): Promise<Memory | null> {
    await this.sync();
    return this.index.get(id);
  }

  async create(memory: Memory): Promise<Memory> {
    // Pindai sekali di awal supaya path lama untuk id ini ditemukan.
    if (!this.synced) {
      await this.sync();
    }
    // Path lama tetap dipakai supaya nama berkas tidak berubah saat judul diedit.
    const existingPath = this.index.pathOf(memory.id);
    const written = await writeMemoryFile(this.dir, memory, existingPath ?? undefined);
    this.index.upsertFromFile(memory, written.relPath, written.sha256, written.mtimeMs, written.size);
    await this.refreshIndexFiles(written.relPath);
    return memory;
  }

  async update(memory: Memory): Promise<Memory> {
    return this.create(memory);
  }

  async setStatus(
    id: string,
    status: MemoryStatus,
    confidence: MemoryConfidence,
    decidedAt: string | null,
  ): Promise<Memory | null> {
    const current = await this.get(id);
    if (current === null) return null;
    const updated: Memory = {
      ...current,
      status,
      confidence,
      decidedAt,
      updatedAt: this.now().toISOString(),
    };
    await this.create(updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const current = await this.get(id);
    if (current === null) return false;
    const relPath = this.index.pathOf(id);
    if (relPath !== null) {
      await deleteMemoryFile(this.dir, relPath);
    }
    await this.sync();
    await this.refreshIndexFiles(relPath);
    return true;
  }

  /** Membuat ulang `INDEX.md` folder yang terpengaruh dan `INDEX.md` akar. */
  private async refreshIndexFiles(relPath: string | null): Promise<void> {
    if (relPath !== null) {
      const parts = relPath.split("/");
      parts.pop();
      await this.writeFolderIndexFile(parts.join("/"));
    }
    await this.writeRootIndexFile();
  }

  private async writeFolderIndexFile(folderRel: string): Promise<void> {
    const rows = this.index.folderRows(`${folderRel}/`);
    const entries: FolderIndexEntry[] = rows.map((row) => ({
      title: row.title,
      fileName: row.path.split("/").pop() ?? row.path,
      status: row.status as MemoryStatus,
      confidence: row.confidence as MemoryConfidence,
      updatedAt: row.updated_at,
    }));

    const isProject = folderRel.startsWith("projects/");
    const projectKey = isProject
      ? (await readProjectMapping(join(this.dir, ...folderRel.split("/")))).projectKey
      : null;
    const heading = isProject
      ? `Memory proyek: ${folderProjectHeading(projectKey ?? folderRel)}`
      : "Memory profil";
    await writeFolderIndex(this.dir, folderRel, {
      heading,
      projectKey: isProject ? projectKey : null,
      entries,
    });
  }

  private async writeRootIndexFile(): Promise<void> {
    const folders: RootIndexFolder[] = [];
    const profileCounts = this.index.folderCounts("profile/");
    if (this.index.folderRows("profile/").length > 0) {
      await this.writeFolderIndexFile("profile");
      folders.push({
        label: "Profil",
        relPath: "profile/INDEX.md",
        active: profileCounts.active,
        proposed: profileCounts.proposed,
      });
    }
    for (const folder of await listProjectFolders(this.dir)) {
      const folderRel = `projects/${folder.name}`;
      // `INDEX.md` folder ditulis dulu supaya tautan di akar selalu hidup.
      await this.writeFolderIndexFile(folderRel);
      const counts = this.index.folderCounts(`${folderRel}/`);
      folders.push({
        label:
          folder.projectKey === null ? folder.name : `Proyek: ${folder.projectKey}`,
        relPath: `${folderRel}/INDEX.md`,
        active: counts.active,
        proposed: counts.proposed,
      });
    }
    await writeRootIndex(this.dir, folders);
  }

  async counts(): Promise<MemoryCounts> {
    await this.sync();
    return this.index.counts();
  }

  async countActive(layer: Memory["layer"], projectKey: string | null): Promise<number> {
    await this.sync();
    return this.index.countActive(layer, projectKey);
  }

  async countProposed(): Promise<number> {
    await this.sync();
    return this.index.countProposed();
  }

  close(): void {
    this.index.close();
  }
}

export function defaultMemoryStore(
  env: Record<string, string | undefined> = process.env,
  now?: () => Date,
): MemoryStore | undefined {
  if (env.JEJAK_MEMORY?.trim() === "0") {
    return undefined;
  }
  const options: MemoryStoreOptions = { dir: memoryDir(env) };
  if (now !== undefined) options.now = now;
  return new FileMemoryStore(options);
}
