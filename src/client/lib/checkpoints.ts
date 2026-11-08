import type {
  ChangeAction,
  CheckpointChange,
  CheckpointItem,
  CheckpointKind,
  CheckpointPreview,
  RewindResult,
} from "./api";
import { formatCount, formatRelative } from "./format";

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_LABEL = 80;

const KIND_LABELS: Record<CheckpointKind, string> = {
  turn: "Otomatis",
  manual: "Manual",
  "pre-rewind": "Pengaman rewind",
};

const ACTION_LABELS: Record<ChangeAction, string> = {
  restore: "Dipulihkan",
  recreate: "Dibuat ulang",
  remove: "Dihapus",
};

const ACTION_WORDS: Record<ChangeAction, string> = {
  restore: "dipulihkan",
  recreate: "dibuat ulang",
  remove: "dihapus",
};

const ACTION_ORDER: readonly ChangeAction[] = ["restore", "recreate", "remove"];

export function checkpointTitle(item: CheckpointItem): string {
  if (item.kind === "turn" && item.turn !== undefined) {
    return `Giliran ${item.turn}`;
  }
  const label = item.label.trim();
  if (label !== "") return label;
  if (item.kind === "manual") return "Titik manual";
  if (item.kind === "pre-rewind") return "Sebelum rewind";
  return "Titik";
}

export function kindLabel(kind: CheckpointKind): string {
  return KIND_LABELS[kind];
}

export function actionLabel(action: ChangeAction): string {
  return ACTION_LABELS[action];
}

/** Huruf aksi mono kecil untuk daftar pratinjau. */
export function actionMark(action: ChangeAction): string {
  if (action === "restore") return "P";
  if (action === "recreate") return "B";
  return "H";
}

function countByAction(changes: readonly CheckpointChange[]): Record<ChangeAction, number> {
  const counts: Record<ChangeAction, number> = { restore: 0, recreate: 0, remove: 0 };
  for (const change of changes) counts[change.action] += 1;
  return counts;
}

function summaryOf(counts: Record<ChangeAction, number>): string {
  const parts = ACTION_ORDER.filter((action) => counts[action] > 0).map(
    (action) => `${formatCount(counts[action])} ${ACTION_WORDS[action]}`,
  );
  return parts.join(" · ");
}

export function previewSummary(preview: CheckpointPreview): string {
  const summary = summaryOf(countByAction(preview.changes));
  return summary === "" ? "Tidak ada perubahan: folder sudah sama dengan titik ini." : summary;
}

export function rewindSummary(result: RewindResult): string {
  const summary = summaryOf({
    restore: result.restored,
    recreate: result.recreated,
    remove: result.removed,
  });
  return summary === "" ? "Tidak ada berkas yang diubah." : summary;
}

export function canRewind(sessionStatus: string): boolean {
  return sessionStatus !== "berjalan";
}

export function rewindBlockedReason(sessionStatus: string): string | undefined {
  if (canRewind(sessionStatus)) return undefined;
  return "Sesi sedang berjalan. Tunggu selesai atau hentikan dulu.";
}

/** Label manual: kosong berarti otomatis; selain itu 1..80 tanpa karakter kontrol. */
export function validateLabel(text: string): string | undefined {
  const value = text.trim();
  if (value === "") return undefined;
  if (value.length > MAX_LABEL) return "Label maksimal 80 karakter.";
  if (CONTROL_RE.test(value)) return "Label tidak boleh memuat karakter kontrol.";
  return undefined;
}

export function formatCheckpointTime(iso: string, now: Date): string {
  return formatRelative(iso, now);
}
