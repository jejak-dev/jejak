import {
  ConfirmDialogView,
  useConfirmDialogBindings,
  type ConfirmDialogBindings,
} from "./ConfirmDialog";
import { canConsolidate, consolidateHint, projectLabel } from "../lib/memory";

export interface MemoryConsolidateProject {
  /** Folder proyek pemilik ringkasan sesi. */
  projectKey: string;
  /** Jumlah ringkasan sesi yang masih onerous atau aktif. */
  count: number;
}

export interface MemoryConsolidateProps {
  projects: MemoryConsolidateProject[];
  /** Permintaan penggabungan sedang berjalan. */
  busy: boolean;
  /** Proyek yang sedang dikonfirmasi; `undefined` berarti modal tertutup. */
  confirmingProjectKey: string | undefined;
  /** Galat terakhir dari server. */
  failure?: string;
  /** Minta konfirmasi untuk sebuah proyek. */
  onAsk: (projectKey: string) => void;
  /** Batalkan konfirmasi. */
  onCancel: () => void;
  /** Konfirmasi penggabungan untuk proyek yang diminta. */
  onConfirm: (projectKey: string) => void;
}

export interface MemoryConsolidateViewProps extends MemoryConsolidateProps {
  dialog: ConfirmDialogBindings;
}

/**
 * Tampilan panel penggabungan tanpa hook; dipakai uji render tanpa DOM.
 */
export function MemoryConsolidateView(props: MemoryConsolidateViewProps) {
  const { projects, confirmingProjectKey, dialog } = props;
  const visible = projects.filter((entry) => canConsolidate(entry.count));
  const confirming = visible.find((entry) => entry.projectKey === confirmingProjectKey);

  return (
    <div class="jk-memory-consolidate">
      {visible.map((entry) => {
        const hint = consolidateHint(entry.count);
        return (
          <div class="jk-memory-consolidate-row" key={entry.projectKey}>
            <span class="jk-memory-consolidate-project">
              {projectLabel(entry.projectKey)}
            </span>
            {hint !== undefined && (
              <span class="jk-note jk-memory-consolidate-hint">{hint}</span>
            )}
            <button
              type="button"
              class="jk-button"
              disabled={props.busy}
              onClick={() => props.onAsk(entry.projectKey)}
            >
              Gabungkan ringkasan sesi
            </button>
          </div>
        );
      })}

      <ConfirmDialogView
        open={confirming !== undefined}
        title="Gabungkan ringkasan sesi?"
        message={
          confirming === undefined
            ? "Ringkasan sesi proyek ini akan disatukan menjadi satu usulan."
            : `${confirming.count} ringkasan sesi di ${projectLabel(confirming.projectKey)} disatukan menjadi satu usulan. Ringkasan sumber ditolak atau diarsipkan.`
        }
        confirmLabel="Gabungkan"
        busyLabel="Menggabungkan…"
        tone="default"
        busy={props.busy}
        error={props.failure}
        idPrefix="jk-confirm-consolidate"
        onConfirm={() => {
          if (confirmingProjectKey !== undefined) props.onConfirm(confirmingProjectKey);
        }}
        onCancel={props.onCancel}
        {...dialog}
      />
    </div>
  );
}

/** Panel penggabungan ringkasan sesi; fokus dan keyboard diurus modal. */
export function MemoryConsolidate(props: MemoryConsolidateProps) {
  const dialog = useConfirmDialogBindings({
    open: props.confirmingProjectKey !== undefined,
    busy: props.busy,
    tone: "default",
    onCancel: props.onCancel,
  });

  return <MemoryConsolidateView {...props} dialog={dialog} />;
}
