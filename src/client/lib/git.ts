import type {
  GitFile,
  GitFileStatus,
  GitState,
  GitStatus,
} from "../../server/git/git-read";

export const COMMIT_MESSAGE_MAX = 2000;

export interface GitStatusLabel {
  /** Huruf pendek untuk baris daftar. */
  short: string;
  /** Teks lengkap untuk aria/title. */
  label: string;
}

const STATUS_LABELS: Record<GitFileStatus, GitStatusLabel> = {
  ditambah: { short: "A", label: "Ditambah" },
  diubah: { short: "M", label: "Diubah" },
  dihapus: { short: "D", label: "Dihapus" },
  diganti: { short: "R", label: "Diganti" },
  disalin: { short: "C", label: "Disalin" },
  konflik: { short: "!", label: "Konflik" },
  "tipe-berubah": { short: "T", label: "Tipe berubah" },
};

export function fileStatusLabel(status: GitFileStatus): GitStatusLabel {
  return STATUS_LABELS[status];
}

export type GitGroupId = "staged" | "unstaged" | "untracked";

export interface GitGroupFile {
  path: string;
  from?: string;
  status?: GitFileStatus;
  short: string;
  label: string;
  conflict: boolean;
}

export interface GitGroup {
  id: GitGroupId;
  title: string;
  files: GitGroupFile[];
  count: number;
}

function groupFile(file: GitFile): GitGroupFile {
  const label = fileStatusLabel(file.status);
  const entry: GitGroupFile = {
    path: file.path,
    status: file.status,
    short: label.short,
    label: label.label,
    conflict: file.status === "konflik",
  };
  if (file.from !== undefined) entry.from = file.from;
  return entry;
}

/** Pecah status menjadi tiga bagian; berkas konflik ditandai `conflict`. */
export function groupStatus(status: GitStatus): GitGroup[] {
  const staged = status.staged.map(groupFile);
  const unstaged = status.unstaged.map(groupFile);
  const untracked: GitGroupFile[] = status.untracked.map((path) => ({
    path,
    short: "?",
    label: "Tak terlacak",
    conflict: false,
  }));
  return [
    { id: "staged", title: "Staged", files: staged, count: staged.length },
    { id: "unstaged", title: "Belum di-stage", files: unstaged, count: unstaged.length },
    { id: "untracked", title: "Tak terlacak", files: untracked, count: untracked.length },
  ];
}

/** Jumlah baris lencana tab: staged + unstaged + tak terlacak. */
export function totalFiles(status: GitStatus): number {
  return status.staged.length + status.unstaged.length + status.untracked.length;
}

export interface CanWriteInput {
  status: string;
  state: GitState;
  writeDisabled: boolean;
}

export interface WritePermission {
  allowed: boolean;
  reason?: string;
}

/** Aksi tulis git hanya boleh saat sesi diam, repo normal, dan penulisan aktif. */
export function canWrite(input: CanWriteInput): WritePermission {
  if (input.status === "berjalan") {
    return { allowed: false, reason: "Sesi sedang berjalan; tunggu selesai." };
  }
  if (input.state !== "normal") {
    return { allowed: false, reason: `Sedang ada ${input.state}; selesaikan di terminal.` };
  }
  if (input.writeDisabled) {
    return { allowed: false, reason: "Penulisan git dimatikan." };
  }
  return { allowed: true };
}

export function validateMessage(text: string): { ok: boolean; error?: string } {
  const value = text.trim();
  if (value.length === 0 || value.length > COMMIT_MESSAGE_MAX) {
    return { ok: false, error: `Pesan commit harus 1 sampai ${COMMIT_MESSAGE_MAX} karakter.` };
  }
  return { ok: true };
}

/** Baris pertama pesan, dipotong agar muat di baris ringkasan. */
export function commitSubject(text: string, max = 72): string {
  const line = (text.trim().split("\n")[0] ?? "").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

const DAY_MS = 86_400_000;

export function relativeTime(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = now.getTime() - date.getTime();
  if (diff < 45_000) return "baru saja";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} mnt lalu`;
  if (diff < DAY_MS) return `${Math.max(1, Math.floor(diff / 3_600_000))} jam lalu`;
  const days = Math.floor(diff / DAY_MS);
  if (days <= 30) return `${days} hari lalu`;
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function aheadBehindLabel(
  status: Pick<GitStatus, "upstream" | "ahead" | "behind">,
): string {
  if (status.upstream === undefined || status.upstream === "") return "";
  const parts: string[] = [];
  if (status.ahead !== undefined && status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind !== undefined && status.behind > 0) parts.push(`↓${status.behind}`);
  return parts.join(" ");
}

export function branchLabel(
  status: Pick<GitStatus, "branch" | "detached" | "head">,
): string {
  if (status.detached) {
    const short = status.head === undefined ? "" : ` ${status.head.slice(0, 7)}`;
    return `HEAD terlepas${short}`;
  }
  return status.branch ?? "HEAD";
}

const STATE_LABELS: Record<GitState, string | undefined> = {
  normal: undefined,
  merge: "merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
  bisect: "bisect",
};

/** Label penanda state git; undefined saat normal. */
export function stateLabel(state: GitState): string | undefined {
  return STATE_LABELS[state];
}

export interface GitTrigger {
  open: boolean;
  eventCount: number;
  status: string;
  refreshToken: number;
}

export interface GitMarker {
  eventCount: number;
  status: string;
  refreshToken: number;
}

/** Muat ulang saat event/refresh berubah atau sesi berpindah dari `berjalan`. */
export function shouldRefreshGit(
  trigger: GitTrigger,
  previous: GitMarker | undefined,
): boolean {
  if (!trigger.open) return false;
  if (previous === undefined) return true;
  if (previous.refreshToken !== trigger.refreshToken) return true;
  if (previous.eventCount !== trigger.eventCount) return true;
  return previous.status === "berjalan" && trigger.status !== "berjalan";
}
