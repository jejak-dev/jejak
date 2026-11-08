import { join } from "node:path";
import { jejakHome } from "../provider-store";
import {
  deleteMemoryFile,
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

export class FileMemoryStore implements MemoryStore {
  readonly dir: string;
  private readonly index: MemoryIndex;
  private lastProblems: MemoryProblem[] = [];
  private readonly now: () => Date;

  constructor(options: MemoryStoreOptions) {
    this.dir = options.dir;
    this.index = new MemoryIndex(options.indexPath ?? join(options.dir, "index.db"));
    this.now = options.now ?? (() => new Date());
  }

  async sync(): Promise<MemoryProblem[]> {
    this.lastProblems = await this.index.sync(this.dir);
    return this.lastProblems;
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
    const written = await writeMemoryFile(this.dir, memory);
    this.index.upsertFromFile(memory, written.relPath, written.sha256, written.mtimeMs, written.size);
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
    await deleteMemoryFile(this.dir, current);
    await this.sync();
    return true;
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
