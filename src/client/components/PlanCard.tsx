import { useState } from "preact/hooks";
import { DONE_LABELS, formatCountdown } from "../lib/permission";
import { planExcerpt, planTitle } from "../lib/plans";
import type { PermissionStatus } from "../lib/timeline";
import { Icon } from "./Icon";

/** Status keputusan; dipakai juga untuk lencana di tab Rencana. */
export type PlanDecisionStatus = PermissionStatus;

/**
 * Catatan untuk rencana yang sempat terputus tapi masih bisa diputuskan.
 *
 * Menyetujui akan melanjutkan sesi; agent mulai lagi dari rencana ini.
 */
export const PLAN_INTERRUPTED_NOTE =
  "Sesi sempat terputus. Menyetujui akan melanjutkan sesi dan agent mulai dari rencana ini.";

/**
 * Catatan kecil untuk keputusan yang diambil setelah sesi terputus.
 *
 * Tampilan murni tanpa hook supaya bisa diuji tanpa DOM.
 */
export function InterruptedNote() {
  return <p class="jk-perm-note jk-interrupted-note">{PLAN_INTERRUPTED_NOTE}</p>;
}

/** Keadaan aksi keputusan; dipisahkan dari tampilan supaya bisa diuji tanpa hook. */
export interface PlanDecisionState {
  busy: boolean;
  error?: string;
  reviseOpen: boolean;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  onToggleRevise: () => void;
  onCancelRevise: () => void;
  onApprove: () => void;
  onSubmitRevise: () => void;
}

/** Sisa waktu menuju penolakan otomatis; disembunyikan bila tak ada batas. */
export function PlanTimer({ remaining }: { remaining: number | null }) {
  if (remaining === null) return null;
  return (
    <span class="jk-perm-timer">
      {remaining > 0 ? `ditolak otomatis dalam ${formatCountdown(remaining)}` : "waktu habis…"}
    </span>
  );
}

export interface PlanActionsViewProps extends PlanDecisionState {
  id: string;
  /** Buka tab Rencana pada rencana ini; undefined = tombol tak tampil. */
  onOpenPlan?: () => void;
}

/**
 * Tombol keputusan rencana: setujui, revisi, dan buka dokumen.
 *
 * Tampilan murni tanpa hook supaya bisa diuji tanpa DOM.
 */
export function PlanActionsView(props: PlanActionsViewProps) {
  const { id, busy, error, reviseOpen, feedback } = props;
  return (
    <>
      <div class="jk-perm-actions">
        <button
          type="button"
          class="jk-button jk-button-primary"
          disabled={busy}
          onClick={props.onApprove}
        >
          {busy ? "Mengirim…" : "Approve plan"}
        </button>
        <button
          type="button"
          class="jk-button"
          disabled={busy}
          onClick={props.onToggleRevise}
          aria-expanded={reviseOpen}
        >
          Revisi
        </button>
        {props.onOpenPlan !== undefined && (
          <button type="button" class="jk-button" disabled={busy} onClick={props.onOpenPlan}>
            Buka rencana
          </button>
        )}
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
            onInput={(event) =>
              props.onFeedbackChange((event.currentTarget as HTMLTextAreaElement).value)
            }
          />
          <div class="jk-perm-reason-actions">
            <button type="button" class="jk-button jk-button-ghost" disabled={busy} onClick={props.onCancelRevise}>
              Batal
            </button>
            <button
              type="button"
              class="jk-button"
              disabled={busy || feedback.trim() === ""}
              onClick={props.onSubmitRevise}
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
    </>
  );
}

/**
 * Keadaan aksi keputusan: sibuk, galat, dan kolom revisi.
 *
 * Dipakai kartu ringkas di chat dan tab Rencana supaya alurnya sama.
 */
export function usePlanDecision(
  onApprove: () => Promise<void>,
  onRevise: (feedback: string) => Promise<void>,
): PlanDecisionState {
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

  return {
    busy,
    error,
    reviseOpen,
    feedback,
    onFeedbackChange: setFeedback,
    onToggleRevise: () => setReviseOpen((value) => !value),
    onCancelRevise: () => setReviseOpen(false),
    onApprove: () => void run(onApprove),
    onSubmitRevise: () => void run(() => onRevise(feedback.trim())),
  };
}

export interface PlanCardViewProps extends PlanDecisionState {
  id: string;
  title: string;
  excerpt: string;
  remaining: number | null;
  onOpenPlan?: () => void;
  /** Sesi sempat terputus: tombol tetap aktif tanpa hitung mundur. */
  interrupted?: boolean;
}

/**
 * Kartu ringkas rencana di riwayat chat.
 *
 * Dokumennya tidak dirender di sini; hanya judul dan kutipan singkat. Dokumen
 * lengkap dibuka lewat tab Rencana di panel kanan.
 */
export function PlanCardView(props: PlanCardViewProps) {
  const { id, title, excerpt, remaining } = props;
  return (
    <article
      class="jk-perm jk-plan"
      data-permission-id={id}
      role="group"
      aria-label="Persetujuan rencana"
      tabIndex={-1}
    >
      <div class="jk-perm-head">
        <Icon name="eye" />
        <span class="jk-perm-name">Plan siap ditinjau</span>
        <PlanTimer remaining={remaining} />
      </div>

      <div class="jk-plan-summary">
        <p class="jk-plan-title">{title}</p>
        {excerpt !== "" && <p class="jk-plan-excerpt">{excerpt}</p>}
      </div>

      {props.interrupted === true && <InterruptedNote />}

      <PlanActionsView
        id={id}
        busy={props.busy}
        error={props.error}
        reviseOpen={props.reviseOpen}
        feedback={props.feedback}
        onFeedbackChange={props.onFeedbackChange}
        onToggleRevise={props.onToggleRevise}
        onCancelRevise={props.onCancelRevise}
        onApprove={props.onApprove}
        onSubmitRevise={props.onSubmitRevise}
        onOpenPlan={props.onOpenPlan}
      />
    </article>
  );
}

export interface PlanCardProps {
  id: string;
  plan: string;
  remaining: number | null;
  onApprove: () => Promise<void>;
  onRevise: (feedback: string) => Promise<void>;
  /** Buka tab Rencana pada rencana ini; undefined = tombol tak tampil. */
  onOpenPlan?: () => void;
  /** Sesi sempat terputus: tombol tetap aktif tanpa hitung mundur. */
  interrupted?: boolean;
}

/** Kartu ringkas rencana yang masih menunggu keputusan. */
export function PlanCard({
  id,
  plan,
  remaining,
  onApprove,
  onRevise,
  onOpenPlan,
  interrupted,
}: PlanCardProps) {
  const state = usePlanDecision(onApprove, onRevise);
  return (
    <PlanCardView
      id={id}
      title={planTitle(plan)}
      excerpt={planExcerpt(plan)}
      remaining={remaining}
      busy={state.busy}
      error={state.error}
      reviseOpen={state.reviseOpen}
      feedback={state.feedback}
      onFeedbackChange={state.onFeedbackChange}
      onToggleRevise={state.onToggleRevise}
      onCancelRevise={state.onCancelRevise}
      onApprove={state.onApprove}
      onSubmitRevise={state.onSubmitRevise}
      onOpenPlan={onOpenPlan}
      interrupted={interrupted}
    />
  );
}

export interface PlanDoneRowProps {
  id: string;
  title: string;
  status: Exclude<PlanDecisionStatus, "menunggu">;
  message?: string;
  onOpenPlan?: () => void;
}

/**
 * Baris ringkasan rencana yang sudah diputuskan.
 *
 * Isi dokumen tak ikut dirender; hanya judul, status, dan tombol buka.
 */
export function PlanDoneRow({ id, title, status, message, onOpenPlan }: PlanDoneRowProps) {
  const label = DONE_LABELS[status];
  return (
    <div class="jk-step jk-plan-done" data-permission-id={id}>
      <span class="jk-step-name">Rencana: {title}</span>
      <span class={`jk-step-status ${label.tone}`}>{label.text}</span>
      {onOpenPlan !== undefined && (
        <button type="button" class="jk-link-btn" onClick={onOpenPlan}>
          Buka rencana
        </button>
      )}
      {status === "ditolak" && message !== undefined && (
        <p class="jk-perm-note">
          Alasan Anda: <em>{message}</em>
        </p>
      )}
      {status === "kedaluwarsa" && (
        <p class="jk-perm-note">Tidak ada keputusan sampai batas waktu, jadi ditolak otomatis.</p>
      )}
    </div>
  );
}
