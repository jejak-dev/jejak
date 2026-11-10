import { useEffect, useState } from "preact/hooks";
import {
  describePermission,
  formatCountdown,
  secondsUntil,
  type PermissionPreview,
} from "../lib/permission";
import type { PermissionStatus, TimelineItem } from "../lib/timeline";
import { parseAskQuestions, parsePlan } from "../lib/ask-question";
import { Markdown } from "./Markdown";
import { PlanCard } from "./PlanCard";
import { AskQuestionCard, AskQuestionSummary } from "./AskQuestionCard";
import { Icon } from "./Icon";

export type PermissionItem = Extract<TimelineItem, { kind: "permission" }>;

export interface PermissionCardProps {
  item: PermissionItem;
  cwd: string;
  onDecide: (
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
    answers?: Record<string, string>,
  ) => Promise<void>;
}

const PREVIEW_LINES = 7;

const DONE_LABELS: Record<Exclude<PermissionStatus, "menunggu">, { text: string; tone: string }> = {
  diizinkan: { text: "Diizinkan", tone: "jk-step-selesai" },
  ditolak: { text: "Ditolak", tone: "jk-step-gagal" },
  kedaluwarsa: { text: "Kedaluwarsa", tone: "" },
  dihentikan: { text: "Sesi dihentikan", tone: "" },
};

function Preview({ preview, cwd }: { preview: PermissionPreview; cwd: string }) {
  const [expanded, setExpanded] = useState(false);

  switch (preview.kind) {
    case "file": {
      const total = preview.lines.length;
      const shown = expanded ? preview.lines : preview.lines.slice(0, PREVIEW_LINES);
      return (
        <div class="jk-perm-preview">
          <div class="jk-perm-preview-head">
            <span>{preview.path}</span>
            <span>{total} baris</span>
          </div>
          <div class="jk-perm-code" tabIndex={0} role="region" aria-label="Isi berkas">
            {shown.map((line, index) => (
              <div class="jk-perm-line" key={index}>
                <i>{index + 1}</i>
                <span>{line === "" ? " " : line}</span>
              </div>
            ))}
          </div>
          {total > PREVIEW_LINES && (
            <button
              type="button"
              class="jk-perm-more"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Ciutkan" : `Tampilkan ${total - PREVIEW_LINES} baris lagi`}
            </button>
          )}
        </div>
      );
    }

    case "diff":
      return (
        <div class="jk-perm-preview">
          <div class="jk-perm-preview-head">
            <span>{preview.path}</span>
            <span>
              −{preview.removed.length} +{preview.added.length}
            </span>
          </div>
          <div class="jk-perm-code" tabIndex={0} role="region" aria-label="Perubahan">
            {preview.removed.map((line, index) => (
              <div class="jk-perm-line jk-perm-del" key={`d${index}`}>
                <i>−</i>
                <span>{line === "" ? " " : line}</span>
              </div>
            ))}
            {preview.added.map((line, index) => (
              <div class="jk-perm-line jk-perm-add" key={`a${index}`}>
                <i>+</i>
                <span>{line === "" ? " " : line}</span>
              </div>
            ))}
          </div>
        </div>
      );

    case "command":
      return (
        <div class="jk-perm-preview">
          <div class="jk-perm-preview-head">
            <span>shell</span>
            <span title={cwd}>{cwd}</span>
          </div>
          <div class="jk-perm-cmd" tabIndex={0} role="region" aria-label="Perintah">
            {preview.command}
          </div>
        </div>
      );

    case "path":
      return (
        <div class="jk-perm-preview">
          <div class="jk-perm-preview-head">
            <span>{preview.path}</span>
            <span>folder kerja: {cwd}</span>
          </div>
        </div>
      );

    default:
      return (
        <div class="jk-perm-preview">
          <pre class="jk-perm-cmd jk-perm-json" tabIndex={0}>
            {preview.text}
          </pre>
        </div>
      );
  }
}

function useCountdown(expiresAt: string | undefined, active: boolean): number | null {
  const [seconds, setSeconds] = useState(() => secondsUntil(expiresAt, new Date()));
  useEffect(() => {
    if (!active) return;
    setSeconds(secondsUntil(expiresAt, new Date()));
    const timer = window.setInterval(() => setSeconds(secondsUntil(expiresAt, new Date())), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt, active]);
  return seconds;
}

export function PermissionCard({ item, cwd, onDecide }: PermissionCardProps) {
  const view = describePermission(item.name, item.input, cwd);
  const asks = item.name === "AskUserQuestion" ? parseAskQuestions(item.input) : undefined;
  const plan = item.name === "ExitPlanMode" ? parsePlan(item.input) : undefined;
  const pending = item.status === "menunggu";
  const remaining = useCountdown(item.expiresAt, pending);

  const [busy, setBusy] = useState<"allow" | "deny" | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");

  const decide = async (decision: "allow" | "deny", message?: string): Promise<void> => {
    setBusy(decision);
    setError(undefined);
    try {
      await onDecide(item.id, decision, message);
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message !== ""
          ? `Keputusan belum terkirim: ${caught.message}`
          : "Keputusan belum terkirim. Coba lagi.",
      );
    } finally {
      setBusy(undefined);
    }
  };

  if (item.status !== "menunggu") {
    const label = DONE_LABELS[item.status];
    const arg = view.target !== "" ? view.target : view.preview.kind === "command" ? view.preview.command : "";
    return (
      <details class="jk-step" data-permission-id={item.id}>
        <summary>
          <span class="jk-chev">
            <Icon name="chevron" />
          </span>
          <span class="jk-step-name">{view.tool}</span>
          {arg !== "" && <span class="jk-step-arg">{arg}</span>}
          <span class={`jk-step-status ${label.tone}`}>{label.text}</span>
        </summary>
        <div class="jk-step-body">
          {item.status === "ditolak" && item.message !== undefined && (
            <p class="jk-perm-note">
              Alasan Anda: <em>{item.message}</em>
            </p>
          )}
          {item.status === "kedaluwarsa" && (
            <p class="jk-perm-note">Tidak ada keputusan sampai batas waktu, jadi ditolak otomatis.</p>
          )}
          {asks !== undefined ? (
            <AskQuestionSummary questions={asks} />
          ) : plan !== undefined ? (
            <div class="jk-plan-body">
              <Markdown text={plan} />
            </div>
          ) : (
            <Preview preview={view.preview} cwd={cwd} />
          )}
        </div>
      </details>
    );
  }

  if (plan !== undefined) {
    return (
      <PlanCard
        id={item.id}
        plan={plan}
        remaining={remaining}
        onApprove={() => onDecide(item.id, "allow")}
        onRevise={(feedback) => onDecide(item.id, "deny", feedback)}
      />
    );
  }

  if (asks !== undefined) {
    return (
      <AskQuestionCard
        id={item.id}
        questions={asks}
        remaining={remaining}
        onSubmit={(answers) => onDecide(item.id, "allow", undefined, answers)}
        onSkip={() => onDecide(item.id, "deny", "pengguna melewati pertanyaan")}
      />
    );
  }

  const risky = view.warning !== undefined;
  const disabled = busy !== undefined;

  return (
    <article
      class={`jk-perm${risky ? " jk-perm-risky" : ""}`}
      data-permission-id={item.id}
      role="group"
      aria-label={`Permintaan izin: ${view.tool}`}
      tabIndex={-1}
    >
      <div class="jk-perm-head">
        <Icon name={view.icon} />
        <span class="jk-perm-name">{view.tool}</span>
        <span class="jk-perm-risk">{view.risk}</span>
        {view.warning !== undefined && <span class="jk-perm-warning">· {view.warning}</span>}
        {remaining !== null && (
          <span class="jk-perm-timer">
            {remaining > 0 ? `ditolak otomatis dalam ${formatCountdown(remaining)}` : "waktu habis…"}
          </span>
        )}
      </div>

      <p class="jk-perm-what">
        {view.lead}
        {view.target !== "" && (
          <>
            : <code>{view.target}</code>
          </>
        )}
      </p>

      <Preview preview={view.preview} cwd={cwd} />

      <div class="jk-perm-actions">
        <button
          type="button"
          class={`jk-button ${risky ? "jk-button-caution" : "jk-button-primary"}`}
          disabled={disabled}
          onClick={() => void decide("allow")}
        >
          {busy === "allow" ? "Mengirim…" : "Izinkan sekali"}
        </button>
        <button type="button" class="jk-button" disabled={disabled} onClick={() => void decide("deny")}>
          {busy === "deny" ? "Mengirim…" : "Tolak"}
        </button>
        <span class="jk-perm-spacer" />
        <button
          type="button"
          class="jk-link-btn"
          disabled={disabled}
          aria-expanded={reasonOpen}
          onClick={() => setReasonOpen(!reasonOpen)}
        >
          Tolak dengan alasan
        </button>
      </div>

      {reasonOpen && (
        <div class="jk-perm-reason">
          <label class="jk-visually-hidden" for={`jk-reason-${item.id}`}>
            Alasan penolakan
          </label>
          <textarea
            id={`jk-reason-${item.id}`}
            maxLength={200}
            placeholder="Beri tahu agen alasannya, mis. “pakai folder tests/ saja”"
            value={reason}
            disabled={disabled}
            onInput={(event) => setReason((event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="jk-perm-reason-actions">
            <button type="button" class="jk-button jk-button-ghost" disabled={disabled} onClick={() => setReasonOpen(false)}>
              Batal
            </button>
            <button
              type="button"
              class="jk-button"
              disabled={disabled}
              onClick={() => void decide("deny", reason.trim() === "" ? undefined : reason.trim())}
            >
              Kirim penolakan
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
