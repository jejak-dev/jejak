import type {
  ImportResult,
  ImportSkipReason,
  MemoryItem,
  MemoryLayer,
  MemoryOrigin,
  MemoryStatus,
} from "./api";
import { folderName } from "./format";

/**
 * Batas yang sama dengan server (`src/server/memory/memory-files.ts`).
 * Disalin agar bundel klien tidak menarik modul server (node:crypto, node:fs).
 */
export const MEMORY_TITLE_MAX = 120;
export const MEMORY_BODY_MAX = 2000;

export type MemoryLayerFilter = MemoryLayer | "semua";

export function layerLabel(layer: MemoryLayer): string {
  return layer === "profile" ? "Profil" : "Proyek";
}

export function statusLabel(status: MemoryStatus): string {
  switch (status) {
    case "proposed":
      return "Usulan";
    case "active":
      return "Aktif";
    case "rejected":
      return "Ditolak";
    default:
      return "Diarsipkan";
  }
}

export function confidenceLabel(confidence: MemoryItem["confidence"]): string {
  switch (confidence) {
    case "confirmed":
      return "Dikonfirmasi";
    case "from_code":
      return "Dari kode";
    default:
      return "Kesimpulan agent";
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** Tanggal singkat id-ID untuk baris meta; ISO tidak valid menjadi string kosong. */
export function memoryDateLabel(iso: string): string {
  return formatDate(iso);
}

export function originLabel(origin: MemoryOrigin): string {
  if (origin.kind === "manual") {
    const date = formatDate(origin.at);
    return date === "" ? "Ditulis manual" : `Ditulis manual · ${date}`;
  }
  if (origin.kind === "file" && origin.file !== undefined) {
    return `Dari berkas ${origin.file}`;
  }
  if (origin.kind === "interview") {
    const date = formatDate(origin.at);
    const by = origin.by === undefined ? "" : ` oleh ${origin.by}`;
    return date === "" ? `Dikonfirmasi${by}` : `Dikonfirmasi${by} · ${date}`;
  }
  return "Dari sesi";
}

/** Nama folder terakhir; `null` berarti berlaku di semua proyek. */
export function projectLabel(projectKey: string | null): string {
  if (projectKey === null || projectKey === "") return "Semua proyek";
  return folderName(projectKey);
}

export function canAccept(status: MemoryStatus): boolean {
  return status === "proposed";
}

export function canReject(status: MemoryStatus): boolean {
  return status === "proposed";
}

export function canArchive(status: MemoryStatus): boolean {
  return status === "active";
}

export function canEdit(status: MemoryStatus): boolean {
  return status === "proposed" || status === "active";
}

/** Teks tanda basi dari `staleReason` server; null berarti tidak ada tanda. */
export function staleLabel(reason: string | null): string | undefined {
  if (reason === null || reason.trim() === "") return undefined;
  return `Mungkin basi: ${reason}`;
}

export interface MemoryDraft {
  layer: MemoryLayer;
  projectKey: string;
  title: string;
  body: string;
}

export function validateDraft(draft: MemoryDraft): string | undefined {
  const title = draft.title.trim();
  if (title === "" || title.length > MEMORY_TITLE_MAX) {
    return `Judul harus 1-${MEMORY_TITLE_MAX} karakter.`;
  }
  const body = draft.body.trim();
  if (body === "" || body.length > MEMORY_BODY_MAX) {
    return `Isi harus 1-${MEMORY_BODY_MAX} karakter.`;
  }
  if (draft.layer === "project" && draft.projectKey.trim() === "") {
    return "Pilih folder proyek untuk memory lapis proyek.";
  }
  return undefined;
}

export function filterByLayer(
  items: readonly MemoryItem[],
  layer: MemoryLayerFilter,
): MemoryItem[] {
  if (layer === "semua") return [...items];
  return items.filter((item) => item.layer === layer);
}

const SKIP_REASONS: ImportSkipReason[] = [
  "sudah-ada",
  "rahasia",
  "terlalu-panjang",
  "kosong",
  "batas",
];

/** Label alasan bagian dokumen dilewati saat impor. */
export function skippedReasonLabel(reason: ImportSkipReason): string {
  switch (reason) {
    case "sudah-ada":
      return "Sudah ada";
    case "rahasia":
      return "Memuat rahasia";
    case "terlalu-panjang":
      return "Terlalu panjang";
    case "kosong":
      return "Kosong";
    default:
      return "Batas usulan tercapai";
  }
}

export interface SkippedGroup {
  reason: ImportSkipReason;
  label: string;
  count: number;
}

/** Hitungan bagian yang dilewati per alasan, urut tetap tanpa alasan kosong. */
export function groupSkipped(
  skipped: readonly ImportResult["skipped"][number][],
): SkippedGroup[] {
  return SKIP_REASONS.map((reason) => ({
    reason,
    label: skippedReasonLabel(reason),
    count: skipped.filter((entry) => entry.reason === reason).length,
  })).filter((group) => group.count > 0);
}

function foundFileNames(files: readonly ImportResult["files"][number][]): string[] {
  return files.filter((entry) => entry.found).map((entry) => entry.file);
}

/** Ringkasan satu kalimat hasil impor dokumen proyek. */
export function importSummary(result: ImportResult): string {
  const names = foundFileNames(result.files);
  if (names.length === 0) {
    return "AGENTS.md dan CLAUDE.md tidak ditemukan di folder ini.";
  }
  const source = names.join(" dan ");
  if (result.created.length > 0) {
    return `${result.created.length} usulan baru dari ${source}.`;
  }
  const skipped = result.skipped.length;
  if (skipped === 0) {
    return `Tidak ada bagian baru di ${source}.`;
  }
  const allExisting = result.skipped.every((entry) => entry.reason === "sudah-ada");
  if (allExisting) {
    return `Tidak ada usulan baru (${skipped} sudah ada).`;
  }
  return `Tidak ada usulan baru (${skipped} dilewati).`;
}
