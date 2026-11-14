import type { ChangeStatus, ChangedFile, Hunk, RejectScope } from "./api";

export interface Crumb {
  label: string;
  path: string;
}

export const ROOT_LABEL = "folder kerja";

/** Segmen breadcrumb dari akar folder kerja sampai path; akar berlabel "folder kerja". */
export function breadcrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: ROOT_LABEL, path: "" }];
  let current = "";
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    current = current === "" ? segment : `${current}/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** Pecah teks menjadi baris; newline di akhir tidak menambah baris kosong palsu. */
export function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function formatSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "–";
  }
  if (bytes < 1024) {
    return `${new Intl.NumberFormat("id-ID").format(Math.round(bytes))} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

const STATUS_LABELS: Record<ChangeStatus, string> = {
  M: "Diubah",
  A: "Ditambah",
  D: "Dihapus",
  R: "Dipindah",
  U: "Baru (belum dilacak)",
};

export function statusLabel(status: ChangeStatus): string {
  return STATUS_LABELS[status];
}

export function totalStats(files: readonly ChangedFile[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

export interface DiffRow {
  /** Nomor baris lama; kosong untuk baris tambahan. */
  oldNo?: number;
  /** Nomor baris baru; kosong untuk baris yang dihapus. */
  newNo?: number;
  t: "ctx" | "add" | "del";
  text: string;
}

/** Baris diff dengan nomor baris lama/baru dari posisi hunk. */
export function diffRows(hunk: Hunk): DiffRow[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line) => {
    if (line.t === "add") {
      const row: DiffRow = { newNo, t: "add", text: line.text };
      newNo += 1;
      return row;
    }
    if (line.t === "del") {
      const row: DiffRow = { oldNo, t: "del", text: line.text };
      oldNo += 1;
      return row;
    }
    const row: DiffRow = { oldNo, newNo, t: "ctx", text: line.text };
    oldNo += 1;
    newNo += 1;
    return row;
  });
}

export interface ChangesTrigger {
  open: boolean;
  tab: "changes" | "files";
  status: string;
  eventCount: number;
}

export interface ChangesMarker {
  status: string;
  eventCount: number;
}

/** Ambil ulang hanya saat panel terbuka di tab Perubahan dan sesi berubah. */
export function shouldRefreshChanges(
  trigger: ChangesTrigger,
  previous: ChangesMarker | undefined,
): boolean {
  if (!trigger.open || trigger.tab !== "changes") return false;
  if (previous === undefined) return true;
  return previous.status !== trigger.status || previous.eventCount !== trigger.eventCount;
}

/** Hanya berkas M/D non-biner yang punya hunk yang bisa dikembalikan ke HEAD. */
export function canReject(file: ChangedFile): boolean {
  if (file.status !== "M" && file.status !== "D") return false;
  if (file.binary) return false;
  return file.hunks.length > 0;
}

/** Alasan penolakan tidak tersedia, atau undefined bila bisa ditolak. */
export function rejectBlockedReason(input: {
  sessionStatus: string;
  file: ChangedFile;
}): string | undefined {
  if (input.sessionStatus === "berjalan") {
    return "Sesi sedang berjalan. Tunggu selesai atau hentikan dulu.";
  }
  if (!canReject(input.file)) {
    return "Jenis perubahan ini belum bisa ditolak.";
  }
  return undefined;
}

export interface UndoLine {
  undoId: string;
  path: string;
  error?: string;
}

/** Baris urung terbaru di depan, paling banyak 5. */
export function pushUndoLine(lines: readonly UndoLine[], line: UndoLine): UndoLine[] {
  return [line, ...lines].slice(0, 5);
}

export function removeUndoLine(lines: readonly UndoLine[], undoId: string): UndoLine[] {
  return lines.filter((line) => line.undoId !== undoId);
}

export function updateUndoLine(
  lines: readonly UndoLine[],
  undoId: string,
  patch: Partial<UndoLine>,
): UndoLine[] {
  return lines.map((line) => (line.undoId === undoId ? { ...line, ...patch } : line));
}

/** Set path berkas yang terbuka setelah satu berkas dibuka/ditutup. */
export function nextOpenPaths(
  paths: ReadonlySet<string>,
  path: string,
  open: boolean,
): Set<string> {
  const next = new Set(paths);
  if (open) next.add(path);
  else next.delete(path);
  return next;
}

export interface RejectTarget {
  path: string;
  scope: RejectScope;
  hunkId?: string;
}

export function rejectTargetKey(target: RejectTarget | undefined): string | undefined {
  if (target === undefined) return undefined;
  return target.scope === "hunk" ? `${target.path}\0${target.hunkId ?? ""}` : target.path;
}

export interface RejectConfirmContent {
  title: string;
  message: string;
  confirmLabel: string;
  confirmAriaLabel: string;
  cancelAriaLabel: string;
}

/**
 * Isi modal konfirmasi penolakan perubahan untuk satu target.
 * Berisi teks pertanyaan, label tombol, dan label aksesibilitas tombol.
 */
export function rejectConfirmContent(
  target: RejectTarget | undefined,
  files: readonly ChangedFile[],
): RejectConfirmContent | undefined {
  if (target === undefined) return undefined;
  const file = files.find((item) => item.path === target.path);
  if (file === undefined) return undefined;
  if (target.scope === "file") {
    return {
      title: "Tolak seluruh berkas?",
      message: "Kembalikan seluruh berkas ke versi HEAD? Semua perubahan di berkas ini hilang.",
      confirmLabel: "Tolak",
      confirmAriaLabel: `Konfirmasi tolak seluruh berkas ${file.path}`,
      cancelAriaLabel: `Batal menolak seluruh berkas ${file.path}`,
    };
  }
  const index = file.hunks.findIndex((hunk) => hunk.id === target.hunkId) + 1;
  return {
    title: "Tolak hunk?",
    message: "Kembalikan hunk ini ke versi sebelumnya?",
    confirmLabel: "Tolak",
    confirmAriaLabel: `Konfirmasi tolak hunk ${index} di ${file.path}`,
    cancelAriaLabel: `Batal menolak hunk ${index} di ${file.path}`,
  };
}
