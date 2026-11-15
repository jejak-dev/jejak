import type {
  ClaudeMemoryDir,
  ClaudeMemoryItem,
  ClaudeMemoryResponse,
  ClaudeMemoryType,
} from "../../server/memory/claude-memory";

export type {
  ClaudeMemoryDir,
  ClaudeMemoryItem,
  ClaudeMemoryResponse,
  ClaudeMemoryType,
};

/** Lencana tipe memory Claude Code. */
export function claudeMemoryTypeLabel(type: ClaudeMemoryType): string {
  switch (type) {
    case "user":
      return "Pengguna";
    case "feedback":
      return "Masukan";
    case "project":
      return "Proyek";
    case "reference":
      return "Referensi";
    default:
      return "Tanpa tipe";
  }
}

/** Urut item dari yang baru saja diubah. */
export function sortClaudeMemoryItems(
  items: readonly ClaudeMemoryItem[],
): ClaudeMemoryItem[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    const a = Number.isNaN(leftTime) ? 0 : leftTime;
    const b = Number.isNaN(rightTime) ? 0 : rightTime;
    if (a !== b) return b - a;
    return left.file.localeCompare(right.file);
  });
}

/** Deskripsi satu baris; baris baru diganti spasi. */
export function claudeMemoryDescriptionLine(item: ClaudeMemoryItem): string {
  const text = item.description.replace(/\s+/g, " ").trim();
  return text === "" ? "" : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TYPES: readonly ClaudeMemoryType[] = [
  "user",
  "feedback",
  "project",
  "reference",
  "unknown",
];

function itemFrom(value: unknown): ClaudeMemoryItem | null {
  if (!isRecord(value)) return null;
  const { file, title, description, type, body, updatedAt } = value;
  if (typeof file !== "string" || file === "") return null;
  if (typeof title !== "string") return null;
  if (typeof description !== "string") return null;
  if (typeof body !== "string") return null;
  if (typeof updatedAt !== "string") return null;
  const found = TYPES.find((entry) => entry === type);
  if (found === undefined) return null;
  return {
    file,
    title,
    description,
    type: found,
    body,
    updatedAt,
    truncated: value.truncated === true,
  };
}

function dirFrom(value: unknown): ClaudeMemoryDir | null {
  if (!isRecord(value)) return null;
  const { label, dirExists, items } = value;
  if (typeof label !== "string" || label === "") return null;
  if (typeof dirExists !== "boolean") return null;
  if (!Array.isArray(items)) return null;
  const parsed = items.map(itemFrom);
  if (parsed.some((entry) => entry === null)) return null;
  return {
    label,
    dirExists,
    items: parsed as ClaudeMemoryItem[],
  };
}

/**
 * Baca respons rute memory Claude Code. Bentuk tak dikenal menghasilkan
 * `null` supaya pemanggil bisa menampilkan galat.
 */
export function parseClaudeMemoryResponse(value: unknown): ClaudeMemoryResponse | null {
  if (!isRecord(value)) return null;
  const { project, dirs } = value;
  if (typeof project !== "string") return null;
  if (!Array.isArray(dirs)) return null;
  const parsed = dirs.map(dirFrom);
  if (parsed.some((entry) => entry === null)) return null;
  return {
    project,
    dirs: (parsed as ClaudeMemoryDir[]).map((dir) => ({
      ...dir,
      items: sortClaudeMemoryItems(dir.items),
    })),
  };
}

/** Jumlah item pada seluruh folder yang dicek. */
export function claudeMemoryCount(response: ClaudeMemoryResponse): number {
  return response.dirs.reduce((total, dir) => total + dir.items.length, 0);
}
