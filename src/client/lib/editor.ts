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

export interface MatchParts {
  before: string;
  hit: string;
  after: string;
}

/** Pecah baris menjadi sebelum/kecocokan/sesudah untuk kecocokan pertama. */
export function highlightMatch(
  text: string,
  query: string,
  caseSensitive: boolean,
): MatchParts | undefined {
  if (query === "") return undefined;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index < 0) return undefined;
  return {
    before: text.slice(0, index),
    hit: text.slice(index, index + query.length),
    after: text.slice(index + query.length),
  };
}
