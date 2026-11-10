import { useState } from "preact/hooks";
import { formatCountdown } from "../lib/permission";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

export interface PlanCardProps {
  id: string;
  plan: string;
  remaining: number | null;
  onApprove: () => Promise<void>;
  onRevise: (feedback: string) => Promise<void>;
}

export function PlanCard({ id, plan, remaining, onApprove, onRevise }: PlanCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message !== ""
          ? `Keputusan belum terkirim: ${caught.message}`
          : "Keputusan belum terkirim. Coba lagi.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <article class="jk-perm jk-plan" data-permission-id={id} role="group" aria-label="Persetujuan rencana" tabIndex={-1}>
      <div class="jk-perm-head">
        <Icon name="eye" />
        <span class="jk-perm-name">Plan siap ditinjau</span>
        {remaining !== null && (
          <span class="jk-perm-timer">
            {remaining > 0 ? `ditolak otomatis dalam ${formatCountdown(remaining)}` : "waktu habis…"}
          </span>
        )}
      </div>

      <div class="jk-plan-body" tabIndex={0} role="region" aria-label="Isi rencana">
        <Markdown text={plan} />
      </div>

      <div class="jk-perm-actions">
        <button
          type="button"
          class="jk-button jk-button-primary"
          disabled={busy}
          onClick={() => void run(onApprove)}
        >
          {busy ? "Mengirim…" : "Approve plan"}
        </button>
        <button type="button" class="jk-button" disabled={busy} onClick={() => setReviseOpen(!reviseOpen)} aria-expanded={reviseOpen}>
          Revisi
        </button>
      </div>

      {reviseOpen && (
        <div class="jk-perm-reason">
          <label class="jk-visually-hidden" for={`jk-plan-fb-${id}`}>
            Catatan revisi
          </label>
          <textarea
            id={`jk-plan-fb-${id}`}
            maxLength={200}
            placeholder="Apa yang perlu diubah dari rencana ini?"
            value={feedback}
            disabled={busy}
            onInput={(event) => setFeedback((event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="jk-perm-reason-actions">
            <button type="button" class="jk-button jk-button-ghost" disabled={busy} onClick={() => setReviseOpen(false)}>
              Batal
            </button>
            <button
              type="button"
              class="jk-button"
              disabled={busy || feedback.trim() === ""}
              onClick={() => void run(() => onRevise(feedback.trim()))}
            >
              Kirim revisi
            </button>
          </div>
        </div>
      )}

      {error !== undefined && (
        <p class="jk-perm-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
