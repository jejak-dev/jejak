export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

/** Pilihan per pertanyaan: label terpilih dan/atau teks bebas ("Other"). */
export interface AskSelection {
  labels: string[];
  other: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Membaca input tool AskUserQuestion; undefined bila bentuknya tidak dikenali. */
export function parseAskQuestions(input: unknown): AskQuestion[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.questions)) return undefined;
  const questions: AskQuestion[] = [];
  for (const raw of input.questions) {
    if (!isRecord(raw)) continue;
    const question = str(raw.question);
    if (question === "") continue;
    const options: AskOption[] = [];
    if (Array.isArray(raw.options)) {
      for (const option of raw.options) {
        if (!isRecord(option)) continue;
        const label = str(option.label);
        if (label !== "") options.push({ label, description: str(option.description) });
      }
    }
    questions.push({
      question,
      header: str(raw.header),
      multiSelect: raw.multiSelect === true,
      options,
    });
  }
  return questions.length === 0 ? undefined : questions;
}

export function emptySelection(): AskSelection {
  return { labels: [], other: "" };
}

export function toggleLabel(
  selection: AskSelection,
  label: string,
  multiSelect: boolean,
): AskSelection {
  if (multiSelect) {
    const labels = selection.labels.includes(label)
      ? selection.labels.filter((entry) => entry !== label)
      : [...selection.labels, label];
    return { ...selection, labels };
  }
  // Pilihan tunggal: memilih label menghapus teks bebas.
  return { labels: [label], other: "" };
}

export function setOther(
  selection: AskSelection,
  text: string,
  multiSelect: boolean,
): AskSelection {
  return { labels: multiSelect ? selection.labels : [], other: text };
}

export function answerText(selection: AskSelection): string {
  const parts = [...selection.labels];
  const other = selection.other.trim();
  if (other !== "") parts.push(other);
  return parts.join(", ");
}

export function allAnswered(questions: AskQuestion[], selections: AskSelection[]): boolean {
  return questions.every((_, index) => answerText(selections[index] ?? emptySelection()) !== "");
}

/** Peta pertanyaan -> jawaban yang dikirim ke SDK. */
export function buildAnswers(
  questions: AskQuestion[],
  selections: AskSelection[],
): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    answers[question.question] = answerText(selections[index] ?? emptySelection());
  });
  return answers;
}

/**
 * Ringkasan satu baris untuk pertanyaan yang sudah dijawab:
 * jumlah pertanyaan dan jawaban singkatnya, mis. "2 pertanyaan: Push, A".
 * Tanpa jawaban cukup "2 pertanyaan".
 */
export function askSummaryLine(
  questions: AskQuestion[],
  answers?: Record<string, string>,
): string {
  const jumlah = questions.length;
  const bagian: string[] = [];
  for (const question of questions) {
    const jawaban = (answers?.[question.question] ?? "").trim();
    if (jawaban !== "") bagian.push(jawaban);
  }
  const kepala = `${jumlah} pertanyaan`;
  return bagian.length === 0 ? kepala : `${kepala}: ${bagian.join(", ")}`;
}

/** Rencana (markdown) dari input tool ExitPlanMode; undefined bila kosong/tak dikenal. */
export function parsePlan(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const plan = typeof input.plan === "string" ? input.plan.trim() : "";
  return plan === "" ? undefined : plan;
}
