import {
  goalCostCapLabel,
  goalIsFinished,
  goalIsLive,
  goalProgressLabel,
  goalReasonLabel,
  goalStatusLabel,
  type GoalView,
} from "../lib/goal";
import { Icon } from "./Icon";

export interface GoalBarProps {
  goal: GoalView;
  /** Permintaan jeda/lanjut/hentikan sedang berjalan. */
  busy?: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  /** Sembunyikan kartu hasil di sisi klien. */
  onDismiss?: () => void;
  /** Mode izin sesi; `bypassPermissions` memunculkan peringatan. */
  permissionMode?: string;
}

/** Alasan yang membuat "Lanjutkan" mereset penghitung giliran. */
function resetsTurnCounter(reason: string | undefined): boolean {
  return (
    reason === "plafon-giliran" ||
    reason === "plafon-biaya" ||
    reason === "tanpa-kemajuan" ||
    reason === "anggaran-sesi"
  );
}

export function GoalBar({
  goal,
  busy = false,
  onPause,
  onResume,
  onStop,
  onDismiss,
  permissionMode,
}: GoalBarProps) {
  const bypass = permissionMode === "bypassPermissions";
  const progress = goalProgressLabel(goal);
  const cap = goalCostCapLabel(goal);

  // Hasil akhir: kartu ringkasan dengan tombol tutup.
  if (goalIsFinished(goal)) {
    return (
      <div class="jk-goal-bar jk-goal-result" role="status" aria-label="Hasil tujuan">
        <div class="jk-goal-head">
          <span class="jk-goal-mark" aria-hidden="true" />
          <strong class="jk-goal-title">{goalStatusLabel(goal)}</strong>
        </div>
        {goal.endedReason !== undefined && (
          <p class="jk-goal-reason">{goalReasonLabel(goal.endedReason)}</p>
        )}
        {goal.summary !== undefined && goal.summary !== "" && (
          <p class="jk-note jk-goal-summary">{goal.summary}</p>
        )}
        {onDismiss !== undefined && (
          <div class="jk-goal-actions">
            <button
              type="button"
              class="jk-button"
              disabled={busy}
              onClick={onDismiss}
              aria-label="Tutup kartu tujuan"
            >
              Tutup
            </button>
          </div>
        )}
      </div>
    );
  }

  // Sedang berjalan: tujuan, progres, dan kendali jeda/hentikan.
  if (goalIsLive(goal)) {
    return (
      <div class="jk-goal-bar jk-goal-active" role="status" aria-label="Tujuan berjalan">
        <div class="jk-goal-head">
          <span class="jk-goal-dot" aria-hidden="true" />
          <span class="jk-goal-objective" title={goal.objective}>
            Tujuan: {goal.objective}
          </span>
        </div>
        <div class="jk-goal-meta">
          <span>{progress}</span>
          {cap !== undefined && <span>{cap}</span>}
        </div>
        {bypass && (
          <p class="jk-note jk-goal-warn">Mode bypass: agent bekerja tanpa meminta izin.</p>
        )}
        <div class="jk-goal-actions">
          <button
            type="button"
            class="jk-button"
            disabled={busy}
            onClick={onPause}
            aria-label="Jeda tujuan"
          >
            Jeda
          </button>
          <button
            type="button"
            class="jk-button"
            disabled={busy}
            onClick={onStop}
            aria-label="Hentikan tujuan"
          >
            Hentikan
          </button>
        </div>
      </div>
    );
  }

  // Dijeda: alasan berhenti, progres, dan kendali lanjut/hentikan.
  const reason =
    goal.endedReason === undefined ? goalStatusLabel(goal) : goalReasonLabel(goal.endedReason);
  return (
    <div class="jk-goal-bar jk-goal-paused" role="status" aria-label="Tujuan dijeda">
      <div class="jk-goal-head">
        <span class="jk-goal-objective" title={goal.objective}>
          Tujuan: {goal.objective}
        </span>
      </div>
      <div class="jk-goal-meta">
        <span>{reason}</span>
        <span>{progress}</span>
        {cap !== undefined && <span>{cap}</span>}
      </div>
      {resetsTurnCounter(goal.endedReason) && (
        <p class="jk-note jk-goal-hint">
          Lanjutkan mereset penghitung giliran dan memberi giliran otomatis baru.
        </p>
      )}
      {bypass && (
        <p class="jk-note jk-goal-warn">Mode bypass: agent bekerja tanpa meminta izin.</p>
      )}
      <div class="jk-goal-actions">
        <button
          type="button"
          class="jk-button"
          disabled={busy}
          onClick={onResume}
          aria-label="Lanjutkan tujuan"
        >
          Lanjutkan
        </button>
        <button
          type="button"
          class="jk-button"
          disabled={busy}
          onClick={onStop}
          aria-label="Hentikan tujuan"
        >
          Hentikan
        </button>
      </div>
    </div>
  );
}

/** Ikon kecil untuk penanda tujuan di sidebar. */
export function GoalMark({ status }: { status: "active" | "paused" }) {
  return (
    <span
      class={`jk-session-goal jk-session-goal-${status}`}
      role="img"
      aria-label={status === "active" ? "Tujuan aktif" : "Tujuan dijeda"}
      title={status === "active" ? "Tujuan aktif" : "Tujuan dijeda"}
    >
      <Icon name="target" />
    </span>
  );
}
