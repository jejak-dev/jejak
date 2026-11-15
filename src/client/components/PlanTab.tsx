import { useEffect, useState } from "preact/hooks";
import { DONE_LABELS, useCountdown } from "../lib/permission";
import type { PlanEntry } from "../lib/plans";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { PlanActionsView, PlanTimer, usePlanDecision, type PlanDecisionState } from "./PlanCard";
import { Select } from "./Select";

export interface PlanTabViewProps extends PlanDecisionState {
  /** Semua rencana pada sesi aktif, urut dari yang paling lama. */
  plans: readonly PlanEntry[];
  /** Id rencana yang sedang ditampilkan; undefined = yang terbaru. */
  selectedId?: string;
  /** Pilih rencana lain dari pemilih. */
  onSelect?: (id: string) => void;
  /** Sisa waktu menuju penolakan otomatis; null bila tak ada batas. */
  remaining: number | null;
}

/**
 * Tab Rencana: dokumen rencana lengkap, bukan ringkasan.
 *
 * Rencana terbaru tampil sebagai dokumen; bila sesi punya beberapa rencana,
 * pemilih di atas membuka yang lama. Tampilan murni tanpa hook supaya bisa
 * diuji tanpa DOM.
 */
export function PlanTabView(props: PlanTabViewProps) {
  const { plans, selectedId } = props;
  if (plans.length === 0) {
    return <p class="jk-empty-line">Belum ada rencana di sesi ini.</p>;
  }

  const aktif = plans.find((entry) => entry.id === selectedId) ?? plans[plans.length - 1];
  if (aktif === undefined) {
    return <p class="jk-empty-line">Belum ada rencana di sesi ini.</p>;
  }
  const menunggu = aktif.status === "menunggu";
  const lencana =
    aktif.status === "menunggu" ? undefined : DONE_LABELS[aktif.status];

  return (
    <div class="jk-plan-tab">
      {plans.length > 1 && (
        <div class="jk-plan-picker">
          <label class="jk-visually-hidden" for="jk-plan-picker">
            Pilih rencana
          </label>
          <Select
            id="jk-plan-picker"
            value={aktif.id}
            options={plans.map((entry, index) => ({
              value: entry.id,
              label: `#${index + 1} ${entry.title}`,
              hint:
                entry.status === "menunggu"
                  ? "Menunggu"
                  : (DONE_LABELS[entry.status]?.text ?? entry.status),
            }))}
            onChange={(value) => props.onSelect?.(value)}
          />
        </div>
      )}

      <div class="jk-plan-head">
        <Icon name="eye" />
        <h3 class="jk-plan-title">{aktif.title}</h3>
        {menunggu ? (
          <PlanTimer remaining={props.remaining} />
        ) : (
          <span class={`jk-step-status ${lencana?.tone ?? ""}`}>{lencana?.text ?? ""}</span>
        )}
      </div>

      <div class="jk-plan-body jk-plan-doc">
        <Markdown text={aktif.plan} />
      </div>

      {menunggu && (
        <PlanActionsView
          id={aktif.id}
          busy={props.busy}
          error={props.error}
          reviseOpen={props.reviseOpen}
          feedback={props.feedback}
          onFeedbackChange={props.onFeedbackChange}
          onToggleRevise={props.onToggleRevise}
          onCancelRevise={props.onCancelRevise}
          onApprove={props.onApprove}
          onSubmitRevise={props.onSubmitRevise}
        />
      )}
    </div>
  );
}

export interface PlanTabProps {
  /** Semua rencana pada sesi aktif, urut dari yang paling lama. */
  plans: readonly PlanEntry[];
  /** Rencana yang difokuskan; undefined = yang terbaru. */
  focusedPlanId?: string;
  /** Kirim keputusan rencana (setujui atau revisi). */
  onDecide?: (
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
  ) => Promise<void>;
}

/** Tab Rencana di panel kanan; dokumennya tidak pernah tampil di chat. */
export function PlanTab({ plans, focusedPlanId, onDecide }: PlanTabProps) {
  const [selected, setSelected] = useState<string | undefined>(focusedPlanId);

  // Rencana yang difokuskan (mis. dari tombol "Buka rencana") selalu menang.
  useEffect(() => {
    setSelected(focusedPlanId);
  }, [focusedPlanId]);

  const aktif = plans.find((entry) => entry.id === selected) ?? plans[plans.length - 1];
  const remaining = useCountdown(aktif?.expiresAt, aktif?.status === "menunggu");
  const planId = aktif?.id;

  const state = usePlanDecision(
    async (): Promise<void> => {
      if (planId === undefined || onDecide === undefined) return;
      await onDecide(planId, "allow");
    },
    async (feedback): Promise<void> => {
      if (planId === undefined || onDecide === undefined) return;
      await onDecide(planId, "deny", feedback);
    },
  );

  return (
    <PlanTabView
      plans={plans}
      selectedId={planId}
      onSelect={setSelected}
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
    />
  );
}
