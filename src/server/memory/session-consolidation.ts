import { MEMORY_BODY_MAX, MEMORY_TITLE_MAX, type Memory } from "./memory-files";
import { SESSION_SUMMARY_PREFIX } from "./session-summary";

/** Awalan judul memory gabungan ringkasan sesi sebuah proyek. */
export const PROJECT_SUMMARY_PREFIX = "Ringkasan proyek: ";
/** Panjang maksimum jawaban akhir satu sesi pada ringkasan gabungan. */
const ANSWER_MAX = 200;

/** Satu sesi yang akan disatukan ke ringkasan proyek. */
export interface ConsolidatedSession {
  /** Judul sesi tanpa awalan ringkasan. */
  title: string;
  /** Tanggal sesi (`YYYY-MM-DD`). */
  date: string;
  /** Berkas yang diubah sesi ini. */
  files: string[];
  /** Jawaban akhir sesi, dipangkas. */
  answer: string;
}

export interface ConsolidatedSummary {
  title: string;
  body: string;
  /** Jumlah sesi lama yang dipangkas karena panjang isi. */
  dropped: number;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Tanggal ISO dari cap waktu; isi tak terbaca menjadi "tanpa tanggal". */
function dateOf(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "tanpa tanggal";
  return parsed.toISOString().slice(0, 10);
}

/** Nilai satu baris berlabel dari isi ringkasan sesi. */
function lineValue(body: string, label: string): string | undefined {
  for (const line of body.split("\n")) {
    if (line.startsWith(`${label}: `)) return line.slice(label.length + 2).trim();
  }
  return undefined;
}

/**
 * Membaca satu ringkasan sesi menjadi data ringkas: judul tanpa awalan,
 * tanggal, berkas yang diubah, dan jawaban akhir.
 */
export function parseSessionSummary(memory: Memory): ConsolidatedSession {
  const rawTitle = memory.title.startsWith(SESSION_SUMMARY_PREFIX)
    ? memory.title.slice(SESSION_SUMMARY_PREFIX.length).trim()
    : memory.title.trim();
  const rawFiles = lineValue(memory.body, "Berkas diubah") ?? "";
  const files: string[] = [];
  for (const part of rawFiles.replace(/\s*\(\+\d+ lainnya\)$/, "").split(",")) {
    const value = part.trim();
    if (value === "" || files.includes(value)) continue;
    files.push(value);
  }
  const answer = lineValue(memory.body, "Jawaban akhir") ?? "";
  return {
    title: rawTitle === "" ? "Sesi tanpa judul" : rawTitle,
    date: dateOf(memory.updatedAt),
    files,
    answer: clip(answer, ANSWER_MAX),
  };
}

/**
 * Susun isi ringkasan gabungan. Satu butir per sesi: judul tanpa awalan,
 * tanggal, berkas yang diubah (dideduplikasi lintas sesi), dan jawaban akhir
 * yang dipangkas. Bila isi melebihi batas, butir tertua dipangkas dan
 * jumlahnya disebut.
 */
function compose(
  included: readonly ConsolidatedSession[],
  dropped: number,
  oldest: string,
  newest: string,
): string {
  const lines: string[] = [];
  lines.push(`Ringkasan gabungan ${included.length} sesi (${oldest} s/d ${newest}).`);
  if (dropped > 0) lines.push(`${dropped} sesi lebih lama dihilangkan.`);
  const seen = new Set<string>();
  for (const session of included) {
    const fresh = session.files.filter((file) => !seen.has(file));
    for (const file of session.files) seen.add(file);
    const parts: string[] = [];
    if (fresh.length > 0) parts.push(`berkas ${fresh.join(", ")}`);
    else if (session.files.length > 0) parts.push("berkas sudah disebut");
    if (session.answer !== "") parts.push(`jawaban: ${session.answer}`);
    const suffix = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    lines.push(`- ${session.title} (${session.date})${suffix}`);
  }
  return lines.join("\n");
}

/**
 * Ringkasan gabungan dari beberapa sesi, siap dipakai sebagai isi memory
 * proyek. Judul menyebut rentang tanggal seluruh sesi sumber.
 */
export function buildConsolidatedSummary(
  sessions: readonly ConsolidatedSession[],
): ConsolidatedSummary {
  const ordered = [...sessions].sort((left, right) => left.date.localeCompare(right.date));
  const oldest = ordered[0]?.date ?? "";
  const newest = ordered[ordered.length - 1]?.date ?? "";
  const title = clip(`${PROJECT_SUMMARY_PREFIX}${oldest} s/d ${newest}`, MEMORY_TITLE_MAX);
  const included = [...ordered];
  let dropped = 0;
  let body = compose(included, dropped, oldest, newest);
  while (body.length > MEMORY_BODY_MAX && included.length > 1) {
    included.shift();
    dropped = ordered.length - included.length;
    body = compose(included, dropped, oldest, newest);
  }
  if (body.length > MEMORY_BODY_MAX) body = body.slice(0, MEMORY_BODY_MAX).trimEnd();
  return { title, body, dropped };
}
