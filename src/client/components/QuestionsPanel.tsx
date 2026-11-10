import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type QuestionItem, type QuestionStatusFilter } from "../lib/api";
import {
  ANSWER_MAX,
  NAME_MAX,
  answerHint,
  answeredLine,
  canSubmitAnswer,
  loadName,
  questionMeta,
  saveName,
} from "../lib/questions";

export interface QuestionsPanelProps {
  api: ApiClient;
  /** Dipanggil setelah pertanyaan berubah (untuk menyegarkan hitungan/memory). */
  onChanged?: () => void;
}

const FILTERS: { id: QuestionStatusFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "answered", label: "Answered" },
  { id: "dismissed", label: "Dismissed" },
];

const NOTE =
  "Agent mengajukan pertanyaan lewat question_ask. Jawabanmu disimpan sebagai memory berlabel dikonfirmasi (nama dan tanggal). Isi jawaban ikut terkirim ke penyedia model saat dibaca agent; jangan menulis rahasia.";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : "Permintaan gagal.";
}

export function QuestionsPanel({ api, onChanged }: QuestionsPanelProps) {
  const [filter, setFilter] = useState<QuestionStatusFilter>("open");
  const [items, setItems] = useState<QuestionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [disabled, setDisabled] = useState(false);
  const [name, setName] = useState(() => loadName());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [assignees, setAssignees] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | undefined>();
  const [failures, setFailures] = useState<Record<string, string | undefined>>({});
  const reqRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    reqRef.current += 1;
    const ticket = reqRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await api.listQuestions(filter);
      if (ticket !== reqRef.current) return;
      setItems(result.items);
      setDisabled(false);
    } catch (caught) {
      if (ticket !== reqRef.current) return;
      setItems([]);
      if (caught instanceof ApiError && caught.status === 503) setDisabled(true);
      else setError(errorMessage(caught));
    } finally {
      if (ticket === reqRef.current) setLoading(false);
    }
  }, [api, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    if (busyId !== undefined) return;
    setBusyId(id);
    setFailures((prev) => ({ ...prev, [id]: undefined }));
    try {
      await action();
      await load();
      onChanged?.();
    } catch (caught) {
      setFailures((prev) => ({ ...prev, [id]: errorMessage(caught) }));
    } finally {
      setBusyId(undefined);
    }
  };

  if (disabled) {
    return <p class="jk-note">Pertanyaan dimatikan (JEJAK_QUESTIONS=0).</p>;
  }

  return (
    <div class="jk-questions">
      <div class="jk-memory-head">
        <div class="jk-panel-tabs" role="tablist" aria-label="Status pertanyaan">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              class={`jk-panel-tab${filter === entry.id ? " jk-panel-tab-active" : ""}`}
              aria-selected={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <label class="jk-questions-name">
          <span class="jk-label">Namamu</span>
          <input
            class="jk-input"
            type="text"
            maxLength={NAME_MAX}
            value={name}
            autoComplete="off"
            placeholder="untuk label dikonfirmasi"
            onInput={(event) => setName(event.currentTarget.value)}
            onBlur={() => saveName(name)}
          />
        </label>
      </div>

      {loading && (
        <p class="jk-note" role="status" aria-live="polite">
          Memuat…
        </p>
      )}

      {!loading && error !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {error}
          </p>
          <button type="button" class="jk-link-btn" onClick={() => void load()}>
            Coba lagi
          </button>
        </div>
      )}

      {!loading && error === undefined && items.length === 0 && (
        <p class="jk-note">
          {filter === "open"
            ? "Tidak ada pertanyaan terbuka. Agent akan bertanya di sini bila butuh pengetahuan dari manusia."
            : "Belum ada."}
        </p>
      )}

      {!loading && error === undefined && items.length > 0 && (
        <ul class="jk-instruksi-list jk-questions-list">
          {items.map((item) => {
            const answer = answers[item.id] ?? "";
            const busy = busyId === item.id;
            return (
              <li class="jk-question" key={item.id}>
                <p class="jk-question-text">{item.question}</p>
                <p class="jk-help">{questionMeta(item)}</p>
                {item.status === "answered" && (
                  <>
                    <p class="jk-question-answer">{item.answer}</p>
                    <p class="jk-help">{answeredLine(item)}</p>
                  </>
                )}
                {item.status === "open" && (
                  <div class="jk-question-form">
                    <textarea
                      class="jk-textarea"
                      rows={3}
                      aria-label={`Jawaban untuk: ${item.question}`}
                      value={answer}
                      maxLength={ANSWER_MAX}
                      onInput={(event) =>
                        setAnswers((prev) => ({ ...prev, [item.id]: event.currentTarget.value }))
                      }
                    />
                    <div class="jk-form-actions">
                      <button
                        type="button"
                        class="jk-button jk-button-primary"
                        disabled={busy || !canSubmitAnswer(answer)}
                        onClick={() => {
                          saveName(name);
                          void run(item.id, () => api.answerQuestion(item.id, answer, name.trim()));
                        }}
                      >
                        {busy ? "Menyimpan…" : "Jawab dan simpan sebagai memory"}
                      </button>
                      <button
                        type="button"
                        class="jk-button"
                        disabled={busy}
                        onClick={() => void run(item.id, () => api.dismissQuestion(item.id))}
                      >
                        Tutup
                      </button>
                      <span class="jk-help">{answerHint(answer)}</span>
                    </div>
                    <div class="jk-question-assign">
                      <input
                        class="jk-input"
                        type="text"
                        maxLength={NAME_MAX}
                        aria-label={`Tugaskan pertanyaan: ${item.question}`}
                        placeholder="Tugaskan ke…"
                        value={assignees[item.id] ?? item.assignee ?? ""}
                        onInput={(event) =>
                          setAssignees((prev) => ({ ...prev, [item.id]: event.currentTarget.value }))
                        }
                      />
                      <button
                        type="button"
                        class="jk-link-btn"
                        disabled={busy}
                        onClick={() =>
                          void run(item.id, () =>
                            api.assignQuestion(item.id, (assignees[item.id] ?? "").trim()),
                          )
                        }
                      >
                        Simpan penugasan
                      </button>
                    </div>
                  </div>
                )}
                {failures[item.id] !== undefined && (
                  <p class="jk-error-line" role="alert">
                    {failures[item.id]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p class="jk-note jk-instruksi-note">{NOTE}</p>
    </div>
  );
}
