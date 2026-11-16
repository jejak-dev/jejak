import { useState } from "preact/hooks";
import {
  describePermission,
  DONE_LABELS,
  formatCountdown,
  useCountdown,
  type PermissionPreview,
} from "../lib/permission";
import type { TimelineItem } from "../lib/timeline";
import { askSummaryLine, parseAskQuestions, parsePlan } from "../lib/ask-question";
import { planTitle } from "../lib/plans";
import { PlanCard, PlanDoneRow } from "./PlanCard";
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
  /** Buka tab Rencana pada rencana ini; undefined = tombol tak tampil. */
  onOpenPlan?: (permissionId: string) => void;
  /**
   * Izin terputus yang masih bisa diputuskan (rencana atau pertanyaan agent).
   * Izin tool biasa tak pernah bisa diputuskan dari jalur ini.
   */
  resumable?: boolean;
}

const PREVIEW_LINES = 7;

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

    case "browser":
      return (
        <div class="jk-perm-preview">
          <div class="jk-perm-preview-head">
            <span>{preview.label}</span>
          </div>
          {preview.lines.length > 0 && (
            <div class="jk-perm-cmd" tabIndex={0} role="region" aria-label={preview.label}>
              {preview.lines.join("\n")}
            </div>
          )}
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

export function PermissionCard({
  item,
  cwd,
  onDecide,
  onOpenPlan,
  resumable,
}: PermissionCardProps) {
  const view = describePermission(item.name, item.input, cwd);
  const asks = item.name === "AskUserQuestion" ? parseAskQuestions(item.input) : undefined;
  const plan = item.name === "ExitPlanMode" ? parsePlan(item.input) : undefined;
  const pending = item.status === "menunggu";
  // Sesi sempat terputus: rencana dan pertanyaan masih bisa diputuskan.
  const terputus = item.status === "terputus";
  const lanjut = terputus && resumable === true;
  const remaining = useCountdown(item.expiresAt, pending);
  // Hitung mundur tak berlaku untuk izin yang sudah terputus.
  const sisaWaktu = terputus ? null : remaining;

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

  if ((pending || lanjut) && plan !== undefined) {
    return (
      <PlanCard
        id={item.id}
        plan={plan}
        remaining={sisaWaktu}
        interrupted={terputus}
        onApprove={() => onDecide(item.id, "allow")}
        onRevise={(feedback) => onDecide(item.id, "deny", feedback)}
        onOpenPlan={onOpenPlan === undefined ? undefined : () => onOpenPlan(item.id)}
      />
    );
  }

  if ((pending || lanjut) && asks !== undefined) {
    return (
      <AskQuestionCard
        id={item.id}
        questions={asks}
        remaining={sisaWaktu}
        interrupted={terputus}
        onSubmit={(answers) => onDecide(item.id, "allow", undefined, answers)}
        onSkip={() => onDecide(item.id, "deny", "pengguna melewati pertanyaan")}
      />
    );
  }

  if (item.status !== "menunggu") {
    // Rencana yang sudah diputuskan: hanya baris ringkasan, dokumennya
    // dibuka lewat tab Rencana di panel kanan.
    if (plan !== undefined) {
      return (
        <PlanDoneRow
          id={item.id}
          title={planTitle(plan)}
          status={item.status}
          message={item.message}
          onOpenPlan={onOpenPlan === undefined ? undefined : () => onOpenPlan(item.id)}
        />
      );
    }
    const label = DONE_LABELS[item.status];
    // Pertanyaan agent yang sudah diizinkan tampil sebagai "Dijawab".
    const tampilLabel =
      asks !== undefined && item.status === "diizinkan"
        ? { text: "Dijawab", tone: DONE_LABELS.diizinkan.tone }
        : label;
    const arg = view.target !== "" ? view.target : view.preview.kind === "command" ? view.preview.command : "";
    const ringkas = asks !== undefined ? askSummaryLine(asks, item.answers) : arg;
    return (
      <details
        class={`jk-step${asks !== undefined ? " jk-step-ask" : ""}`}
        data-permission-id={item.id}
      >
        <summary>
          <span class="jk-chev">
            <Icon name="chevron" />
          </span>
          <span class="jk-step-name">
            {asks !== undefined ? "Pertanyaan agent" : view.tool}
          </span>
          {ringkas !== "" && (
            <span
              class={`jk-step-arg${asks !== undefined ? " jk-step-arg-text" : ""}`}
            >
              {ringkas}
            </span>
          )}
          <span class={`jk-step-status ${tampilLabel.tone}`}>{tampilLabel.text}</span>
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
          {item.status === "terputus" && (
            <p class="jk-perm-note">Sesi terputus sebelum izin ini diputuskan.</p>
          )}
          {asks !== undefined ? (
            <AskQuestionSummary questions={asks} answers={item.answers} />
          ) : (
            <Preview preview={view.preview} cwd={cwd} />
          )}
        </div>
      </details>
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
