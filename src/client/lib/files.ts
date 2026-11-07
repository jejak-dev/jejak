import type { ChangeStatus, ChangedFile, Hunk } from "./api";

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
