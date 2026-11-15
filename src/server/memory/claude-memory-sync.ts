import { createHash } from "node:crypto";
import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  CLAUDE_MEMORY_INDEX_FILE,
  canonicalPath,
  claudeMemoryDir,
  parseFrontmatter,
  type ClaudeProjectEntry,
} from "./claude-memory";
import {
  MEMORY_BODY_MAX,
  ensureDirectory,
  isMemoryId,
  writeFileAtomic,
  type Memory,
} from "./memory-files";
import { findSecret } from "./secret-guard";

/** Awalan nama berkas yang ditulis Jejak di folder memory Claude Code. */
export const CLAUDE_SYNC_FILE_PREFIX = "jejak_";
/** Panjang maksimum deskripsi satu baris pada frontmatter. */
export const CLAUDE_SYNC_DESCRIPTION_MAX = 150;
/** Kunci hash isi berkas; dipakai untuk mendeteksi suntingan dari sisi Claude. */
export const CLAUDE_SYNC_HASH_KEY = "jejak_hash";
/** Kunci id memory Jejak pada frontmatter. */
export const CLAUDE_SYNC_ID_KEY = "jejak_id";

/** Jenis memory yang ditulis ke folder Claude Code. */
export type ClaudeSyncType = "project" | "feedback";

/** Dependensi berkas; disuntikkan agar bisa diuji dengan folder sementara. */
export interface ClaudeSyncFs {
  /** Baca berkas sebagai teks; galat dilempar. */
  readFile(path: string): Promise<string>;
  /** Tulis berkas secara atomik dengan izin 0600. */
  writeFile(path: string, content: string): Promise<void>;
  /** Buat folder beserta induknya (izin 0700). */
  mkdir(path: string): Promise<void>;
  /** Hapus berkas; galat dilempar. */
  unlink(path: string): Promise<void>;
  /** Info berkas tanpa mengikuti symlink; `null` bila tak ada. */
  lstat(path: string): Promise<ClaudeSyncStat | null>;
  /** Daftar nama isi folder; galat dilempar. */
  readdir(path: string): Promise<string[]>;
}

export interface ClaudeSyncStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** Implementasi default di atas `node:fs/promises`. */
export const nodeClaudeSyncFs: ClaudeSyncFs = {
  async readFile(path) {
    return await readFile(path, "utf8");
  },
  async writeFile(path, content) {
    await writeFileAtomic(path, content);
  },
  async mkdir(path) {
    await ensureDirectory(path);
  },
  async unlink(path) {
    await unlink(path);
  },
  async lstat(path) {
    try {
      const info = await lstat(path);
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        isSymbolicLink: info.isSymbolicLink(),
      };
    } catch {
      return null;
    }
  },
  async readdir(path) {
    return await readdir(path);
  },
};

/* ---------- Render berkas (fungsi murni) ---------- */

/** Nilai YAML sederhana; nilai berisiko dikutip dengan gaya JSON. */
export function yamlScalar(value: string): string {
  const risky =
    value === "" ||
    value !== value.trim() ||
    /[:#\n\r"'{}[\],&*?|<>=!%@`]/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^-?\d+(\.\d+)?$/.test(value) ||
    /^-/.test(value);
  if (!risky) return value;
  return JSON.stringify(value);
}

/**
 * Tipe memory untuk folder Claude Code: `feedback` bila asal memory adalah
 * masukan langsung manusia (manual atau wawancara), `project` selain itu.
 */
export function claudeSyncType(memory: Pick<Memory, "origin">): ClaudeSyncType {
  return memory.origin.kind === "manual" || memory.origin.kind === "interview"
    ? "feedback"
    : "project";
}

/** Deskripsi satu baris dari isi memory; paling banyak 150 karakter. */
export function claudeSyncDescription(memory: Pick<Memory, "title" | "body">): string {
  const firstLine = memory.body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  const source = firstLine === undefined || firstLine === "" ? memory.title : firstLine;
  const flat = source.replace(/\s+/g, " ").trim();
  if (flat.length <= CLAUDE_SYNC_DESCRIPTION_MAX) return flat;
  return flat.slice(0, CLAUDE_SYNC_DESCRIPTION_MAX - 1).trimEnd() + "…";
}

/** Nama berkas memory Jejak di folder Claude Code. */
export function claudeSyncFileName(id: string): string {
  if (!isMemoryId(id)) throw new Error("Id memory harus UUID v4.");
  return `${CLAUDE_SYNC_FILE_PREFIX}${id}.md`;
}

/** Buang baris `jejak_hash` dari frontmatter; hash dihitung atas sisa isi. */
export function stripHashLine(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return normalized;
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === "---") {
      close = index;
      break;
    }
  }
  if (close === -1) return normalized;
  const kept = lines.filter((line, index) => {
    if (index <= 0 || index >= close) return true;
    return !new RegExp(`^[ \\t]*${CLAUDE_SYNC_HASH_KEY}:`).test(line);
  });
  return kept.join("\n");
}

/** Hash sha256 isi berkas tanpa baris `jejak_hash`. */
export function claudeSyncHash(text: string): string {
  return createHash("sha256").update(stripHashLine(text), "utf8").digest("hex");
}

/** Hasil render berkas memory untuk folder Claude Code. */
export interface ClaudeSyncFile {
  /** Nama berkas relatif, mis. `jejak_<id>.md`. */
  fileName: string;
  /** Isi berkas lengkap (frontmatter + isi memory). */
  content: string;
  /** Hash isi tanpa baris `jejak_hash`. */
  hash: string;
  /** Deskripsi satu baris yang dipakai di frontmatter dan indeks. */
  description: string;
  /** Tipe memory untuk folder Claude Code. */
  type: ClaudeSyncType;
}

/**
 * Render berkas memory Jejak untuk folder memory Claude Code. Fungsi murni:
 * hasil hanya bergantung pada memory yang diberikan.
 */
export function renderClaudeSyncFile(memory: Memory): ClaudeSyncFile {
  if (!isMemoryId(memory.id)) throw new Error("Id memory harus UUID v4.");
  const description = claudeSyncDescription(memory);
  const type = claudeSyncType(memory);
  const body = memory.body.slice(0, MEMORY_BODY_MAX);
  const head = [
    "---",
    `name: ${yamlScalar(memory.title)}`,
    `description: ${yamlScalar(description)}`,
    "metadata:",
    `  type: ${type}`,
    `  ${CLAUDE_SYNC_ID_KEY}: ${memory.id}`,
    `  jejak_confidence: ${memory.confidence}`,
  ].join("\n");
  const tail = ["---", "", body, ""].join("\n");
  const core = `${head}\n${tail}`;
  const hash = createHash("sha256").update(core, "utf8").digest("hex");
  const content = `${head}\n  ${CLAUDE_SYNC_HASH_KEY}: ${hash}\n${tail}`;
  return {
    fileName: claudeSyncFileName(memory.id),
    content,
    hash,
    description,
    type,
  };
}

/** Penanda Jejak pada frontmatter sebuah berkas. */
export interface ClaudeSyncMarker {
  /** Id memory Jejak bila frontmatter memuat `jejak_id`. */
  jejakId?: string;
  /** Hash isi yang dicatat Jejak. */
  jejakHash?: string;
}

/** Baca penanda Jejak dari frontmatter sebuah berkas. */
export function readClaudeSyncMarker(text: string): ClaudeSyncMarker {
  const split = parseFrontmatter(text);
  if (split === null) return {};
  const read = (key: string): string | undefined => {
    const raw = split.fields.get(key);
    if (raw === undefined) return undefined;
    const value = raw.trim().replace(/^"|"$/g, "").trim();
    return value === "" ? undefined : value;
  };
  const marker: ClaudeSyncMarker = {};
  const jejakId = read(`metadata.${CLAUDE_SYNC_ID_KEY}`) ?? read(CLAUDE_SYNC_ID_KEY);
  const jejakHash = read(`metadata.${CLAUDE_SYNC_HASH_KEY}`) ?? read(CLAUDE_SYNC_HASH_KEY);
  if (jejakId !== undefined) marker.jejakId = jejakId;
  if (jejakHash !== undefined) marker.jejakHash = jejakHash;
  return marker;
}

/* ---------- Layanan sinkron ---------- */

/** Hasil satu aksi sinkron. */
export interface ClaudeSyncOutcome {
  status:
    | "ditulis"
    | "diperbarui"
    | "dilewati"
    | "konflik"
    | "ditolak-rahasia"
    | "dihapus";
  /** Nama berkas yang bermasalah (konflik). */
  file?: string;
  /** Alasan singkat kalau hasil bukan tulisan. */
  reason?: string;
}

/** Ringkasan sinkron penuh. */
export interface ClaudeSyncSummary {
  /** Berkas baru yang ditulis. */
  ditulis: number;
  /** Berkas lama yang diperbarui. */
  diperbarui: number;
  /** Memory yang dilewati (bukan proyek/aktif, atau proyek tak dikenal). */
  dilewati: number;
  /** Berkas Jejak yang dihapus. */
  dihapus: number;
  /** Nama berkas yang bentrok dengan suntingan sisi Claude. */
  konflik: string[];
  /** Memory yang ditolak karena memuat rahasia. */
  ditolakRahasia: number;
}

export interface ClaudeMemorySyncOptions {
  /** Root konfigurasi Claude Code (`CLAUDE_CONFIG_DIR` atau `~/.claude`). */
  configRoot: string;
  /** Saklar efektif; false berarti tak ada berkas yang ditulis. */
  enabled: () => boolean;
  /** Proyek yang dikenal Jejak (dipakai untuk mencari folder tujuan). */
  projects: () => readonly ClaudeProjectEntry[];
  /** Daftar memory Jejak untuk sinkron penuh; tanpa ini sinkron penuh dilewati. */
  memories?: () => Promise<Memory[]>;
  /** Dependensi berkas; default `node:fs/promises`. */
  fs?: ClaudeSyncFs;
}

function summaryOf(): ClaudeSyncSummary {
  return {
    ditulis: 0,
    diperbarui: 0,
    dilewati: 0,
    dihapus: 0,
    konflik: [],
    ditolakRahasia: 0,
  };
}

/** True bila `path` berada di dalam `dir`. */
function insideDir(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

/**
 * Sinkron memory Jejak ke folder memory Claude Code. Folder Claude dianggap
 * milik bersama: Jejak hanya menyentuh berkas `jejak_*` yang ia tulis sendiri
 * dan tidak pernah menimpa berkas yang disunting di sisi Claude.
 */
export class ClaudeMemorySync {
  private readonly configRoot: string;
  private readonly enabledFn: () => boolean;
  private readonly projectsFn: () => readonly ClaudeProjectEntry[];
  private readonly memoriesFn: (() => Promise<Memory[]>) | undefined;
  private readonly fs: ClaudeSyncFs;

  constructor(options: ClaudeMemorySyncOptions) {
    this.configRoot = options.configRoot;
    this.enabledFn = options.enabled;
    this.projectsFn = options.projects;
    this.memoriesFn = options.memories;
    this.fs = options.fs ?? nodeClaudeSyncFs;
  }

  /** True bila sinkron sedang menyala. */
  get enabled(): boolean {
    return this.enabledFn();
  }

  /**
   * Terapkan satu memory: memory proyek aktif ditulis, memory lain (usulan,
   * arsip, ditolak) cleaned dari folder Claude.
   */
  async apply(memory: Memory): Promise<ClaudeSyncOutcome> {
    if (!this.enabledFn()) return { status: "dilewati", reason: "saklar mati" };
    if (memory.layer === "project" && memory.status === "active") {
      return await this.writeMemory(memory);
    }
    if (memory.layer === "project") {
      return await this.removeFile(memory);
    }
    return { status: "dilewati", reason: "bukan memory proyek" };
  }

  /** Hapus berkas Jejak milik satu memory (mis. memory dihapus). */
  async remove(memory: Memory): Promise<ClaudeSyncOutcome> {
    if (!this.enabledFn()) return { status: "dilewati", reason: "saklar mati" };
    if (memory.layer !== "project") {
      return { status: "dilewati", reason: "bukan memory proyek" };
    }
    return await this.removeFile(memory);
  }

  /**
   * Sinkron penuh: semua memory proyek aktif ditulis, dan berkas Jejak yang
   * tak lagi punya memory aktif dihapus. Idempoten.
   */
  async run(): Promise<ClaudeSyncSummary> {
    const summary = summaryOf();
    if (!this.enabledFn()) return summary;
    const memories = this.memoriesFn === undefined ? undefined : await this.memoriesFn();
    if (memories === undefined) return summary;

    const active = memories.filter(
      (memory) => memory.layer === "project" && memory.status === "active",
    );
    for (const memory of active) {
      const outcome = await this.writeMemory(memory);
      this.count(summary, outcome);
    }
    // Berkas Jejak yang memory-nya sudah tidak aktif dibersihkan.
    for (const memory of memories) {
      if (memory.layer !== "project") continue;
      if (memory.status === "active") continue;
      const outcome = await this.removeFile(memory);
      if (outcome.status === "dihapus" || outcome.status === "konflik") {
        this.count(summary, outcome);
      }
    }
    await this.prune(memories, summary);
    return summary;
  }

  private count(summary: ClaudeSyncSummary, outcome: ClaudeSyncOutcome): void {
    if (outcome.status === "ditulis") summary.ditulis += 1;
    else if (outcome.status === "diperbarui") summary.diperbarui += 1;
    else if (outcome.status === "ditolak-rahasia") summary.ditolakRahasia += 1;
    else if (outcome.status === "dihapus") summary.dihapus += 1;
    else if (outcome.status === "konflik") {
      summary.konflik.push(outcome.file ?? "");
      summary.dilewati += 1;
    } else summary.dilewati += 1;
  }

  /** Folder tujuan memory: repo asal untuk worktree Jejak, else path proyek. */
  private targetDir(projectKey: string): string | undefined {
    const wanted = canonicalPath(projectKey);
    for (const entry of this.projectsFn()) {
      const candidates = [
        entry.key,
        entry.path,
        ...(entry.altPaths ?? []),
        ...(entry.aliases ?? []),
        ...(entry.originPath === undefined ? [] : [entry.originPath]),
        ...(entry.originAltPath === undefined ? [] : [entry.originAltPath]),
      ];
      const match = candidates.some(
        (candidate) => canonicalPath(candidate) === wanted,
      );
      if (!match) continue;
      return claudeMemoryDir(this.configRoot, entry.originPath ?? entry.path);
    }
    return undefined;
  }

  /** Siapkan folder tujuan; menolak symlink di lintasan folder. */
  private async prepareDir(dir: string): Promise<boolean> {
    const root = resolve(this.configRoot);
    const rel = relative(root, resolve(dir));
    if (rel === "" || rel.startsWith("..")) return false;
    const segments = rel.split(sep).filter((segment) => segment !== "");
    let current = root;
    const rootStat = await this.fs.lstat(root);
    if (rootStat !== null && !rootStat.isDirectory) return false;
    if (rootStat === null) await this.fs.mkdir(root);
    for (const segment of segments) {
      current = join(current, segment);
      const info = await this.fs.lstat(current);
      if (info !== null) {
        if (info.isSymbolicLink) return false;
        if (!info.isDirectory) return false;
        continue;
      }
      await this.fs.mkdir(current);
    }
    return true;
  }

  /** Tulis (atau perbarui) berkas memory Jejak di folder Claude. */
  private async writeMemory(memory: Memory): Promise<ClaudeSyncOutcome> {
    if (!isMemoryId(memory.id)) {
      return { status: "dilewati", reason: "id memory tidak valid" };
    }
    if (memory.projectKey === null || memory.projectKey === "") {
      return { status: "dilewati", reason: "memory proyek tanpa folder proyek" };
    }
    const secret = findSecret(memory.title) ?? findSecret(memory.body);
    if (secret !== null) {
      return { status: "ditolak-rahasia", reason: secret };
    }
    const dir = this.targetDir(memory.projectKey);
    if (dir === undefined) {
      return { status: "dilewati", reason: "proyek tidak dikenal" };
    }
    const fileName = claudeSyncFileName(memory.id);
    const filePath = join(dir, fileName);
    if (!insideDir(dir, filePath)) {
      return { status: "dilewati", reason: "path berkas tidak valid" };
    }
    if (!(await this.prepareDir(dir))) {
      return { status: "dilewati", reason: "folder tujuan tak bisa dipakai" };
    }

    const existing = await this.fs.lstat(filePath);
    let mode: "ditulis" | "diperbarui" = "ditulis";
    if (existing !== null) {
      if (existing.isSymbolicLink) {
        return { status: "dilewati", reason: "berkas adalah symlink" };
      }
      if (!existing.isFile) {
        return { status: "dilewati", reason: "berkas bukan berkas biasa" };
      }
      let content: string;
      try {
        content = await this.fs.readFile(filePath);
      } catch {
        return { status: "dilewati", reason: "berkas tidak dapat dibaca" };
      }
      const marker = readClaudeSyncMarker(content);
      if (marker.jejakId !== memory.id) {
        return { status: "dilewati", reason: "berkas bukan milik memory ini" };
      }
      if (marker.jejakHash === undefined) {
        return { status: "konflik", file: fileName, reason: "hash tak ada" };
      }
      if (claudeSyncHash(content) !== marker.jejakHash) {
        return { status: "konflik", file: fileName, reason: "berkas diubah di luar Jejak" };
      }
      mode = "diperbarui";
    }

    const rendered = renderClaudeSyncFile(memory);
    try {
      await this.fs.writeFile(filePath, rendered.content);
    } catch {
      return { status: "dilewati", reason: "berkas tak bisa ditulis" };
    }
    try {
      await this.updateIndex(dir, rendered.fileName, rendered.description, memory.title);
    } catch {
      // Indeks gagal ditulis; berkas memory tetap tersimpan.
    }
    return { status: mode };
  }

  /** Hapus berkas Jejak milik memory beserta baris indeksnya. */
  private async removeFile(memory: Memory): Promise<ClaudeSyncOutcome> {
    if (!isMemoryId(memory.id)) {
      return { status: "dilewati", reason: "id memory tidak valid" };
    }
    if (memory.projectKey === null || memory.projectKey === "") {
      return { status: "dilewati", reason: "memory proyek tanpa folder proyek" };
    }
    const dir = this.targetDir(memory.projectKey);
    if (dir === undefined) {
      return { status: "dilewati", reason: "proyek tidak dikenal" };
    }
    const fileName = claudeSyncFileName(memory.id);
    const filePath = join(dir, fileName);
    if (!insideDir(dir, filePath)) {
      return { status: "dilewati", reason: "path berkas tidak valid" };
    }
    const existing = await this.fs.lstat(filePath);
    if (existing === null) {
      await this.removeIndexLine(dir, fileName);
      return { status: "dilewati", reason: "berkas tidak ada" };
    }
    if (existing.isSymbolicLink) {
      return { status: "dilewati", reason: "berkas adalah symlink" };
    }
    if (!existing.isFile) {
      return { status: "dilewati", reason: "berkas bukan berkas biasa" };
    }
    let content: string;
    try {
      content = await this.fs.readFile(filePath);
    } catch {
      return { status: "dilewati", reason: "berkas tidak dapat dibaca" };
    }
    const marker = readClaudeSyncMarker(content);
    if (marker.jejakId !== memory.id) {
      return { status: "dilewati", reason: "berkas bukan milik memory ini" };
    }
    if (marker.jejakHash === undefined) {
      return { status: "konflik", file: fileName, reason: "hash tak ada" };
    }
    if (claudeSyncHash(content) !== marker.jejakHash) {
      return { status: "konflik", file: fileName, reason: "berkas diubah di luar Jejak" };
    }
    try {
      await this.fs.unlink(filePath);
    } catch {
      return { status: "dilewati", reason: "berkas tak bisa dihapus" };
    }
    try {
      await this.removeIndexLine(dir, fileName);
    } catch {
      // Indeks gagal ditulis; berkas tetap terhapus.
    }
    return { status: "dihapus", reason: "dihapus", file: fileName };
  }

  /**
   * Bersihkan berkas `jejak_*` yang memory-nya tak lagi aktif. Berkas tanpa
   * penanda Jejak tak pernah disentuh.
   */
  private async prune(memories: readonly Memory[], summary: ClaudeSyncSummary): Promise<void> {
    const activeIds = new Set(
      memories
        .filter((memory) => memory.layer === "project" && memory.status === "active")
        .map((memory) => memory.id),
    );
    const known = new Map<string, Memory>();
    for (const memory of memories) {
      if (memory.layer === "project") known.set(memory.id, memory);
    }
    const dirs = new Set<string>();
    for (const memory of memories) {
      if (memory.layer !== "project") continue;
      if (memory.projectKey === null) continue;
      const dir = this.targetDir(memory.projectKey);
      if (dir !== undefined) dirs.add(dir);
    }
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await this.fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.startsWith(CLAUDE_SYNC_FILE_PREFIX) || !name.endsWith(".md")) continue;
        const filePath = join(dir, name);
        if (!insideDir(dir, filePath)) continue;
        const info = await this.fs.lstat(filePath);
        if (info === null || !info.isFile) continue;
        let content: string;
        try {
          content = await this.fs.readFile(filePath);
        } catch {
          continue;
        }
        const marker = readClaudeSyncMarker(content);
        const jejakId = marker.jejakId;
        if (jejakId === undefined || !isMemoryId(jejakId)) continue;
        if (activeIds.has(jejakId)) continue;
        const memory = known.get(jejakId);
        if (memory !== undefined) {
          const outcome = await this.removeFile(memory);
          if (outcome.status === "konflik") {
            summary.konflik.push(outcome.file ?? name);
            summary.dilewati += 1;
          } else if (outcome.status === "dihapus") {
            summary.dihapus += 1;
          }
          continue;
        }
        // Memory tak dikenal lagi; berkas dihapus bila hash masih cocok.
        if (marker.jejakHash === undefined || claudeSyncHash(content) !== marker.jejakHash) {
          summary.konflik.push(name);
          summary.dilewati += 1;
          continue;
        }
        try {
          await this.fs.unlink(filePath);
          await this.removeIndexLine(dir, name);
          summary.dihapus += 1;
        } catch {
          summary.dilewati += 1;
        }
      }
    }
  }

  /** Tambah atau perbarui baris indeks `MEMORY.md`; baris lain tak berubah. */
  private async updateIndex(
    dir: string,
    fileName: string,
    description: string,
    title: string,
  ): Promise<void> {
    const indexPath = join(dir, CLAUDE_MEMORY_INDEX_FILE);
    const line = `- [${title.replace(/\s+/g, " ").trim()}](${fileName}) — ${description}`;
    const existing = await this.readIndex(indexPath);
    const kept = (existing?.lines ?? []).filter((entry) => !entry.includes(`(${fileName})`));
    kept.push(line);
    await this.writeIndex(indexPath, kept);
  }

  /** Buang baris indeks milik satu berkas. */
  private async removeIndexLine(dir: string, fileName: string): Promise<void> {
    const indexPath = join(dir, CLAUDE_MEMORY_INDEX_FILE);
    const existing = await this.readIndex(indexPath);
    if (existing === undefined || !existing.exists) return;
    const kept = existing.lines.filter((entry) => !entry.includes(`(${fileName})`));
    if (kept.length === existing.lines.length) return;
    await this.writeIndex(indexPath, kept);
  }

  /**
   * Baca ulang `MEMORY.md` tepat sebelum menulis. `exists` menandai apakah
   * berkas itu ada; `lines` berisi baris yang ada.
   */
  private async readIndex(
    indexPath: string,
  ): Promise<{ exists: boolean; lines: string[] } | undefined> {
    let raw: string;
    try {
      raw = await this.fs.readFile(indexPath);
    } catch {
      return undefined;
    }
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\n$/, "");
    return { exists: true, lines: normalized === "" ? [] : normalized.split("\n") };
  }

  private async writeIndex(indexPath: string, lines: readonly string[]): Promise<void> {
    const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    await this.fs.writeFile(indexPath, body);
  }
}
