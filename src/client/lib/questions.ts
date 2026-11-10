import type { QuestionItem } from "./api";
import { memoryDateLabel, projectLabel } from "./memory";

export const ANSWER_MAX = 1500;
export const NAME_MAX = 60;
const NAME_KEY = "jejak.nama";

/** Baris meta: proyek · ditugaskan ke · tanggal. */
export function questionMeta(item: QuestionItem): string {
  const parts = [item.layer === "profile" ? "Semua proyek" : projectLabel(item.projectKey)];
  if (item.assignee !== undefined) parts.push(`untuk ${item.assignee}`);
  const date = memoryDateLabel(item.createdAt);
  if (date !== "") parts.push(date);
  return parts.join(" · ");
}

/** Jawaban boleh dikirim bila tidak kosong dan tidak melebihi batas server. */
export function canSubmitAnswer(answer: string): boolean {
  const text = answer.trim();
  return text !== "" && text.length <= ANSWER_MAX;
}

export function answerHint(answer: string): string {
  return `${answer.trim().length} / ${ANSWER_MAX}`;
}

/** Ringkasan jawaban untuk daftar yang sudah dijawab. */
export function answeredLine(item: QuestionItem): string {
  const by = item.answeredBy ?? "pengguna";
  const date = item.answeredAt === undefined ? "" : memoryDateLabel(item.answeredAt);
  return date === "" ? `Dijawab oleh ${by}` : `Dijawab oleh ${by} · ${date}`;
}

/** Nama pengonfirmasi terakhir yang dipakai (per perambah); tanpa penyimpanan → kosong. */
export function loadName(storage?: Pick<Storage, "getItem">): string {
  try {
    return (storage ?? localStorage).getItem(NAME_KEY)?.slice(0, NAME_MAX) ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? localStorage).setItem(NAME_KEY, name.trim().slice(0, NAME_MAX));
  } catch {
    // Penyimpanan bisa diblokir; nama tetap dipakai untuk permintaan ini.
  }
}
