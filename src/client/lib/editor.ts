import { ApiError, type FileContent } from "./api";

const STALE_MESSAGE = "berubah di disk";
const GENERIC_SAVE_ERROR = "Berkas tidak dapat disimpan.";

/** Hanya berkas teks utuh yang punya versi (sha256) yang boleh disunting. */
export function isEditable(file: FileContent): boolean {
  return !file.binary && !file.truncated && file.content !== undefined && file.version !== undefined;
}

export function isDirty(original: string, draft: string): boolean {
  return original !== draft;
}

/** Offset awal baris 1-based; nilai di luar rentang dijepit ke baris pertama/terakhir. */
export function lineStartOffset(text: string, line: number): number {
  const lines = text.split("\n");
  const target = Math.min(Math.max(Math.trunc(line), 1), Math.max(lines.length, 1));
  let offset = 0;
  for (let index = 1; index < target; index += 1) {
    offset += lines[index - 1]!.length + 1;
  }
  return offset;
}

/** Pesan galat simpan; `conflict` hanya untuk 409 akibat berkas berubah di disk. */
export function describeSaveError(error: unknown): { message: string; conflict: boolean } {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      conflict: error.status === 409 && error.message.includes(STALE_MESSAGE),
    };
  }
  return { message: GENERIC_SAVE_ERROR, conflict: false };
}

/** Potongan teks hasil pencarian; `hit` menandai bagian yang cocok. */
export interface MatchSegment {
  text: string;
  hit: boolean;
}

/**
 * Memecah `text` menurut rentang kecocokan dari server. Rentang di luar teks
 * dijepit, yang tumpang tindih atau kosong dibuang.
 */
export function segmentByRanges(
  text: string,
  ranges: readonly { start: number; end: number }[] | undefined,
): MatchSegment[] {
  if (ranges === undefined || ranges.length === 0) return [{ text, hit: false }];
  const segments: MatchSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.min(range.end, text.length);
    if (end <= start) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments.length === 0 ? [{ text, hit: false }] : segments;
}
