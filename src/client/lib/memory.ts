import type {
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
