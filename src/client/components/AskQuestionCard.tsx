import { useState } from "preact/hooks";
import {
  allAnswered,
  answerText,
  buildAnswers,
  emptySelection,
  setOther,
  toggleLabel,
  type AskQuestion,
  type AskSelection,
} from "../lib/ask-question";
import { formatCountdown } from "../lib/permission";
import { Icon } from "./Icon";
import { InterruptedNote } from "./PlanCard";

export interface AskQuestionCardProps {
  id: string;
  questions: AskQuestion[];
  remaining: number | null;
  onSubmit: (answers: Record<string, string>) => Promise<void>;
  onSkip: () => Promise<void>;
  /** Sesi sempat terputus: pertanyaan tetap bisa dijawab. */
  interrupted?: boolean;
}

export function AskQuestionCard({
  id,
  questions,
  remaining,
  onSubmit,
  onSkip,
  interrupted,
}: AskQuestionCardProps) {
  const [selections, setSelections] = useState<AskSelection[]>(() =>
    questions.map(() => emptySelection()),
  );
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const last = questions.length - 1;
  const question = questions[step]!;
  const selection = selections[step] ?? emptySelection();
  const name = `jk-ask-${id}-${step}`;
  const type = question.multiSelect ? "checkbox" : "radio";

  const update = (index: number, next: AskSelection): void =>
    setSelections((current) => current.map((entry, i) => (i === index ? next : entry)));

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message !== ""
          ? `Jawaban belum terkirim: ${caught.message}`
          : "Jawaban belum terkirim. Coba lagi.",
      );
    } finally {
      setBusy(false);
    }
  };

  const ready = allAnswered(questions, selections);
  const answeredHere = answerText(selection) !== "";

  return (
    <article class="jk-perm jk-ask" data-permission-id={id} role="group" aria-label="Pertanyaan dari agent" tabIndex={-1}>
      <div class="jk-perm-head">
        <Icon name="cube" />
        <span class="jk-perm-name">Agent bertanya</span>
        {remaining !== null && (
          <span class="jk-perm-timer">
            {remaining > 0 ? `dilewati otomatis dalam ${formatCountdown(remaining)}` : "waktu habis…"}
          </span>
        )}
      </div>

      {questions.length > 1 && (
        <div class="jk-ask-tabs" role="tablist" aria-label="Pertanyaan">
          {questions.map((entry, index) => {
            const done = answerText(selections[index] ?? emptySelection()) !== "";
            return (
              <button
                type="button"
                role="tab"
                key={entry.question}
                class={`jk-ask-tab${index === step ? " jk-ask-tab-on" : ""}${done ? " jk-ask-tab-done" : ""}`}
                aria-selected={index === step}
                disabled={busy}
                onClick={() => setStep(index)}
              >
                <span class="jk-ask-tab-mark" aria-hidden="true">
                  {done ? "✓" : index + 1}
                </span>
                {entry.header !== "" ? entry.header : `Q${index + 1}`}
              </button>
            );
          })}
        </div>
      )}

      <fieldset class="jk-ask-q" key={step} disabled={busy} aria-labelledby={`${name}-q`}>
        <p class="jk-ask-text" id={`${name}-q`}>
          {question.question}
        </p>
        {question.multiSelect && <p class="jk-help">Boleh pilih lebih dari satu.</p>}
        <div class="jk-ask-options">
          {question.options.map((option) => {
            const checked = selection.labels.includes(option.label);
            return (
              <label class={`jk-ask-option${checked ? " jk-ask-option-on" : ""}`} key={option.label}>
                <input
                  type={type}
                  name={name}
                  checked={checked}
                  onChange={() => {
                    update(step, toggleLabel(selection, option.label, question.multiSelect));
                    if (!question.multiSelect && step < last) setStep(step + 1);
                  }}
                />
                <span class="jk-ask-option-body">
                  <span class="jk-ask-option-label">{option.label}</span>
                  {option.description !== "" && <span class="jk-ask-option-desc">{option.description}</span>}
                </span>
              </label>
            );
          })}
          <label class="jk-ask-other">
            <span class="jk-visually-hidden">Jawaban lain</span>
            <input
              type="text"
              class="jk-input"
              placeholder="Other: tulis jawaban sendiri"
              maxLength={500}
              value={selection.other}
              onInput={(event) =>
                update(step, setOther(selection, (event.currentTarget as HTMLInputElement).value, question.multiSelect))
              }
            />
          </label>
        </div>
      </fieldset>

      {interrupted === true && <InterruptedNote />}

      <div class="jk-perm-actions">
        {step < last ? (
          <button
            type="button"
            class="jk-button jk-button-primary"
            disabled={busy || !answeredHere}
            onClick={() => setStep(step + 1)}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            class="jk-button jk-button-primary"
            disabled={busy || !ready}
            onClick={() => void run(() => onSubmit(buildAnswers(questions, selections)))}
          >
            {busy ? "Mengirim…" : "Kirim jawaban"}
          </button>
        )}
        <span class="jk-perm-spacer" />
        <button type="button" class="jk-link-btn" disabled={busy} onClick={() => void run(onSkip)}>
          Lewati
        </button>
      </div>

      {error !== undefined && (
        <p class="jk-perm-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/** Ringkasan read-only pertanyaan (kartu yang sudah diputuskan), dengan jawaban bila ada. */
export function AskQuestionSummary({
  questions,
  answers,
}: {
  questions: AskQuestion[];
  answers?: Record<string, string>;
}) {
  return (
    <ul class="jk-ask-summary">
      {questions.map((question) => {
        const answer = answers?.[question.question];
        return (
          <li key={question.question}>
            <strong>{question.question}</strong>
            {answer !== undefined && answer !== "" ? (
              <span class="jk-ask-answer"> → {answer}</span>
            ) : (
              question.options.length > 0 && (
                <span class="jk-help"> · {question.options.map((option) => option.label).join(" / ")}</span>
              )
            )}
          </li>
        );
      })}
    </ul>
  );
}
