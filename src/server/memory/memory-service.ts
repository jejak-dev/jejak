import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { FileError, resolveInside } from "../files/path";
import { findSecret } from "./secret-guard";
import {
  MEMORY_BODY_MAX,
  MEMORY_PROJECT_KEY_MAX,
  MEMORY_TITLE_MAX,
  hasControlCharacters,
  type Memory,
  type MemoryConfidence,
  type MemoryLayer,
  type MemoryOrigin,
  type MemoryStatus,
} from "./memory-files";
import type { MemoryCounts, MemoryListQuery, MemoryProblem } from "./memory-index";
import type { MemoryStore } from "./memory-store";

export const MEMORY_FROM_CODE_CONFIDENCE: MemoryConfidence = "from_code";
export const MEMORY_ACTIVE_LIMIT = 500;
export const MEMORY_PROPOSED_LIMIT = 200;
export const MEMORY_DEFAULT_LIMIT = 100;
export const MEMORY_MAX_LIMIT = 200;
const STALE_FILE_MAX_BYTES = 1024 * 1024;

const SECRET_MESSAGE = (kind: string): string =>
  `Teks tampak memuat rahasia (${kind}). Hapus dulu sebelum menyimpan.`;

export type MemoryErrorCode = "tidak-valid" | "tidak-ditemukan" | "konflik";

export class MemoryError extends Error {
  constructor(
    message: string,
    public readonly code: MemoryErrorCode,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export interface MemoryServiceOptions {
  store: MemoryStore;
  /** Folder kerja sesi; dipakai untuk verifikasi basi dan berkas asal. */
  cwd?: string;
  now?: () => Date;
}

export interface CreateMemoryInput {
  layer?: unknown;
  projectKey?: unknown;
  title?: unknown;
  body?: unknown;
}

export interface UpdateMemoryInput {
  title?: unknown;
  body?: unknown;
}

export interface ProposeInput extends CreateMemoryInput {
  originFile?: unknown;
  sessionId?: unknown;
  commit?: unknown;
}

export interface ListMemoryQuery {
  status?: unknown;
  layer?: unknown;
  project?: unknown;
  q?: unknown;
  limit?: unknown;
}

export interface MemoryListResult {
  items: Memory[];
  counts: MemoryCounts;
  problems: MemoryProblem[];
}

const LAYERS: MemoryLayer[] = ["profile", "project"];
const STATUSES: MemoryStatus[] = ["proposed", "active", "rejected", "archived"];

function invalid(message: string): MemoryError {
  return new MemoryError(message, "tidak-valid");
}

function notFound(id: string): MemoryError {
  return new MemoryError(`Memory "${id}" tidak ditemukan.`, "tidak-ditemukan");
}

function conflict(message: string): MemoryError {
  return new MemoryError(message, "konflik");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class MemoryService {
  private readonly store: MemoryStore;
  private readonly cwd: string | undefined;
  private readonly now: () => Date;

  constructor(options: MemoryServiceOptions) {
    this.store = options.store;
    this.cwd = options.cwd;
    this.now = options.now ?? (() => new Date());
  }

  private clock(): string {
    return this.now().toISOString();
  }

  private normalizeLayer(value: unknown): MemoryLayer {
    if (typeof value !== "string") {
      throw invalid("Field layer harus berupa 'profile' atau 'project'.");
    }
    const layer = value.trim();
    if (layer !== "profile" && layer !== "project") {
      throw invalid("Field layer harus berupa 'profile' atau 'project'.");
    }
    return layer;
  }

  private normalizeProjectKey(layer: MemoryLayer, value: unknown): string | null {
    if (layer === "profile") {
      if (value !== undefined && value !== null && value !== "") {
        throw invalid("Memory profil tidak boleh menyertakan projectKey.");
      }
      return null;
    }
    if (typeof value !== "string") {
      throw invalid("Field projectKey harus berupa teks untuk memory proyek.");
    }
    const projectKey = value.trim();
    if (projectKey === "") {
      throw invalid("Field projectKey tidak boleh kosong untuk memory proyek.");
    }
    if (projectKey.includes("\0") || projectKey.length > MEMORY_PROJECT_KEY_MAX) {
      throw invalid("Field projectKey tidak valid.");
    }
    if (!isAbsolute(projectKey)) {
      throw invalid("Field projectKey harus berupa path absolut.");
    }
    return projectKey;
  }

  private normalizeText(
    value: unknown,
    field: string,
    max: number,
  ): string {
    if (typeof value !== "string") {
      throw invalid(`Field ${field} harus berupa teks.`);
    }
    const text = value.trim();
    if (text === "" || text.length > max) {
      throw invalid(`Field ${field} harus ${1}-${max} karakter.`);
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

  private async enforceLimits(layer: MemoryLayer, projectKey: string | null): Promise<void> {
    const active = await this.store.countActive(layer, projectKey);
    if (active >= MEMORY_ACTIVE_LIMIT) {
      throw conflict(
        `Batas ${MEMORY_ACTIVE_LIMIT} memory aktif untuk lingkup ini sudah tercapai.`,
      );
    }
  }

  private async enforceProposedLimit(): Promise<void> {
    const proposed = await this.store.countProposed();
    if (proposed >= MEMORY_PROPOSED_LIMIT) {
      throw conflict(`Batas ${MEMORY_PROPOSED_LIMIT} usulan terbuka sudah tercapai.`);
    }
  }

  async create(input: CreateMemoryInput): Promise<Memory> {
    const layer = this.normalizeLayer(input.layer);
    const projectKey = this.normalizeProjectKey(layer, input.projectKey);
    const title = this.normalizeText(input.title, "title", MEMORY_TITLE_MAX);
    const body = this.normalizeText(input.body, "body", MEMORY_BODY_MAX);

    await this.enforceLimits(layer, projectKey);

    const at = this.clock();
    const memory: Memory = {
      id: crypto.randomUUID(),
      layer,
      projectKey,
      title,
      body,
      status: "active",
      confidence: "confirmed",
      origin: { kind: "manual", at },
      staleReason: null,
      createdAt: at,
      updatedAt: at,
      decidedAt: null,
    };
    return this.store.create(memory);
  }

  /**
   * Membuat usulan dari agent: selalu `proposed`, confidence `inferred`, atau
   * `from_code` bila berkas asal berhasil diverifikasi. Tidak pernah `active`.
   */
  async propose(input: ProposeInput, cwd?: string): Promise<Memory> {
    const baseCwd = cwd ?? this.cwd;
    const layer = this.normalizeLayer(input.layer);
    const projectKey = this.normalizeProjectKey(layer, input.projectKey);
    const title = this.normalizeText(input.title, "title", MEMORY_TITLE_MAX);
    const body = this.normalizeText(input.body, "body", MEMORY_BODY_MAX);

    await this.enforceProposedLimit();

    const at = this.clock();
    const origin: MemoryOrigin = { kind: "session", at };
    if (typeof input.sessionId === "string" && input.sessionId.trim() !== "") {
      origin.sessionId = input.sessionId.trim();
    }
    if (typeof input.commit === "string" && input.commit.trim() !== "") {
      origin.commit = input.commit.trim();
    }

    let confidence: MemoryConfidence = "inferred";
    if (input.originFile !== undefined && input.originFile !== null) {
      if (typeof input.originFile !== "string" || input.originFile.trim() === "") {
        throw invalid("Field originFile harus berupa teks.");
      }
      if (baseCwd === undefined || baseCwd === "") {
        throw invalid("Berkas asal hanya bisa diverifikasi bila folder kerja diketahui.");
      }
      const rel = input.originFile.trim();
      let resolved;
      try {
        resolved = await resolveInside(baseCwd, rel);
      } catch (error) {
        if (error instanceof FileError && error.code === "tidak-ditemukan") {
          throw invalid("Berkas asal tidak ditemukan.");
        }
        throw invalid("Berkas asal di luar folder kerja.");
      }

      let bytes: Uint8Array;
      try {
        const handle = await open(resolved.target, "r");
        try {
          const info = await handle.stat();
          if (!info.isFile()) {
            throw invalid("Berkas asal bukan berkas biasa.");
          }
          const buffer = new Uint8Array(Math.max(1, info.size));
          const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
          bytes = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof MemoryError) throw error;
        throw invalid("Berkas asal tidak dapat dibaca.");
      }

      origin.kind = "file";
      origin.file = resolved.path;
      origin.fileSha256 = sha256Hex(bytes);
      confidence = MEMORY_FROM_CODE_CONFIDENCE;
    }

    const memory: Memory = {
      id: crypto.randomUUID(),
      layer,
      projectKey,
      title,
      body,
      status: "proposed",
      confidence,
      origin,
      staleReason: null,
      createdAt: at,
      updatedAt: at,
      decidedAt: null,
    };
    return this.store.create(memory);
  }

  async list(query: ListMemoryQuery = {}): Promise<MemoryListResult> {
    const filter: MemoryListQuery = {};

    if (query.status !== undefined && query.status !== null && query.status !== "") {
      if (typeof query.status !== "string" || !STATUSES.includes(query.status as MemoryStatus)) {
        throw invalid("Nilai status tidak dikenal.");
      }
      filter.status = query.status as MemoryStatus;
    }
    if (query.layer !== undefined && query.layer !== null && query.layer !== "") {
      if (typeof query.layer !== "string" || !LAYERS.includes(query.layer as MemoryLayer)) {
        throw invalid("Nilai layer tidak dikenal.");
      }
      filter.layer = query.layer as MemoryLayer;
    }
    if (query.project !== undefined && query.project !== null) {
      if (typeof query.project !== "string" || query.project.trim() === "") {
        throw invalid("Nilai project tidak dikenal.");
      }
      filter.project = query.project.trim();
    }
    if (query.q !== undefined && query.q !== null) {
      if (typeof query.q !== "string") {
        throw invalid("Nilai q harus berupa teks.");
      }
      filter.q = query.q;
    }
    if (query.limit !== undefined && query.limit !== null && query.limit !== "") {
      const raw = query.limit;
      const limit = typeof raw === "number" ? raw : Number(String(raw));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_MAX_LIMIT) {
        throw invalid(`Nilai limit harus 1-${MEMORY_MAX_LIMIT}.`);
      }
      filter.limit = limit;
    }

    const items = await this.store.list(filter);
    const counts = await this.store.counts();
    const problems = this.store.problems();
    const decorated = await Promise.all(items.map((memory) => this.withStale(memory)));
    return { items: decorated, counts, problems };
  }

  async get(id: string): Promise<Memory> {
    const memory = await this.store.get(id);
    if (memory === null) {
      throw notFound(id);
    }
    return this.withStale(memory);
  }

  /** Menghitung ulang tanda basi tanpa menulis apa pun ke indeks. */
  private async withStale(memory: Memory): Promise<Memory> {
    const reason = await this.staleReason(memory);
    return reason === memory.staleReason ? memory : { ...memory, staleReason: reason };
  }

  private async staleReason(memory: Memory): Promise<string | null> {
    const file = memory.origin.file;
    const expected = memory.origin.fileSha256;
    if (file === undefined || expected === undefined) return null;
    if (this.cwd === undefined || this.cwd === "") return null;
    if (memory.layer === "project" && memory.projectKey !== this.cwd) return null;

    let target: string;
    try {
      target = (await resolveInside(this.cwd, file)).target;
    } catch (error) {
      if (error instanceof FileError && error.code === "tidak-ditemukan") {
        return "berkas asal hilang";
      }
      return null;
    }

    let bytes: Uint8Array;
    try {
      const handle = await open(target, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > STALE_FILE_MAX_BYTES) return null;
        const buffer = new Uint8Array(Math.max(1, info.size));
        const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return "berkas asal hilang";
    }

    return sha256Hex(bytes) === expected ? null : "berkas asal berubah";
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory> {
    const current = await this.store.get(id);
    if (current === null) {
      throw notFound(id);
    }
    if (current.status !== "proposed" && current.status !== "active") {
      throw conflict("Hanya memory usulan atau aktif yang bisa diubah.");
    }

    const next: Memory = { ...current };
    let changed = false;
    if (input.title !== undefined) {
      next.title = this.normalizeText(input.title, "title", MEMORY_TITLE_MAX);
      changed = true;
    }
    if (input.body !== undefined) {
      next.body = this.normalizeText(input.body, "body", MEMORY_BODY_MAX);
      changed = true;
    }
    if (!changed) {
      throw invalid("Tidak ada field yang diubah.");
    }

    next.updatedAt = this.clock();
    return this.store.update(next);
  }

  private async transition(
    id: string,
    from: MemoryStatus[],
    to: MemoryStatus,
    confidence: MemoryConfidence,
    decided: boolean,
  ): Promise<Memory> {
    const current = await this.store.get(id);
    if (current === null) {
      throw notFound(id);
    }
    if (!from.includes(current.status)) {
      throw conflict(
        `Memory berstatus "${current.status}" tidak bisa berpindah ke "${to}".`,
      );
    }
    if (to === "active") {
      await this.enforceLimits(current.layer, current.projectKey);
    }
    const updated = await this.store.setStatus(
      id,
      to,
      confidence,
      decided ? this.clock() : current.decidedAt,
    );
    if (updated === null) {
      throw notFound(id);
    }
    return updated;
  }

  accept(id: string): Promise<Memory> {
    return this.transition(id, ["proposed"], "active", "confirmed", true);
  }

  reject(id: string): Promise<Memory> {
    return this.transition(id, ["proposed"], "rejected", "inferred", false);
  }

  archive(id: string): Promise<Memory> {
    return this.transition(id, ["active"], "archived", "confirmed", false);
  }

  async delete(id: string): Promise<void> {
    const current = await this.store.get(id);
    if (current === null) {
      throw notFound(id);
    }
    const removed = await this.store.delete(id);
    if (!removed) {
      throw notFound(id);
    }
  }
}
