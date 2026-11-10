import { useState } from "preact/hooks";
import {
  allAnswered,
  buildAnswers,
  emptySelection,
  setOther,
  toggleLabel,
  type AskQuestion,
  type AskSelection,
} from "../lib/ask-question";
import { formatCountdown } from "../lib/permission";
import { Icon } from "./Icon";

export interface AskQuestionCardProps {
  id: string;
  questions: AskQuestion[];
  remaining: number | null;
  onSubmit: (answers: Record<string, string>) => Promise<void>;
  onSkip: () => Promise<void>;
}

export function AskQuestionCard({ id, questions, remaining, onSubmit, onSkip }: AskQuestionCardProps) {
  const [selections, setSelections] = useState<AskSelection[]>(() =>
    questions.map(() => emptySelection()),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

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

      {questions.map((question, index) => {
        const selection = selections[index] ?? emptySelection();
        const name = `jk-ask-${id}-${index}`;
        const type = question.multiSelect ? "checkbox" : "radio";
        return (
          <fieldset class="jk-ask-q" key={question.question} disabled={busy} aria-labelledby={`${name}-q`}>
            <div class="jk-ask-legend" id={`${name}-q`}>
              {question.header !== "" && <span class="jk-badge jk-badge-muted">{question.header}</span>}
              <span class="jk-ask-text">{question.question}</span>
            </div>
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
                      onChange={() => update(index, toggleLabel(selection, option.label, question.multiSelect))}
                    />
                    <span class="jk-ask-option-body">
                      <span class="jk-ask-option-label">{option.label}</span>
                      {option.description !== "" && (
                        <span class="jk-ask-option-desc">{option.description}</span>
                      )}
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
                    update(index, setOther(selection, (event.currentTarget as HTMLInputElement).value, question.multiSelect))
                  }
                />
              </label>
            </div>
          </fieldset>
        );
      })}

      <div class="jk-perm-actions">
        <button
          type="button"
          class="jk-button jk-button-primary"
          disabled={busy || !ready}
          onClick={() => void run(() => onSubmit(buildAnswers(questions, selections)))}
        >
          {busy ? "Mengirim…" : "Kirim jawaban"}
        </button>
        <button type="button" class="jk-button" disabled={busy} onClick={() => void run(onSkip)}>
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

/** Ringkasan read-only pertanyaan (kartu yang sudah diputuskan). */
export function AskQuestionSummary({ questions }: { questions: AskQuestion[] }) {
  return (
    <ul class="jk-ask-summary">
      {questions.map((question) => (
        <li key={question.question}>
          <strong>{question.question}</strong>
          {question.options.length > 0 && (
            <span class="jk-help"> · {question.options.map((option) => option.label).join(" / ")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
