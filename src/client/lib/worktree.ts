import type { SessionInfo } from "../../server/sessions/session-manager";
import type { WorktreeInfo, WorktreeInspect } from "../../server/git/worktree-service";

export type WorktreeSession = Pick<SessionInfo, "worktree">;

export interface WorktreeBadge {
  label: string;
  title: string;
  tone: "" | "warn" | "bad";
}

const BRANCH_PREFIX = "jejak/";
const LABEL_MAX = 28;
/** Karakter yang aman di shell tanpa tanda petik. */
const SAFE_SHELL = /^[A-Za-z0-9_./:@%+=,-]+$/;

function truncateLabel(text: string): string {
  if (text.length <= LABEL_MAX) return text;
  return `${text.slice(0, LABEL_MAX - 1)}…`;
}

/** Nama cabang pendek (tanpa `jejak/`), dipotong agar muat di header. */
function shortBranch(branch: string): string {
  const name = branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : branch;
  return truncateLabel(name);
}

/** Lencana header; undefined untuk sesi tanpa worktree. */
export function worktreeBadge(session: WorktreeSession): WorktreeBadge | undefined {
  const worktree = session.worktree;
  if (worktree === undefined) return undefined;
  const removed = worktree.removed === true;
  const missing = !removed && worktree.missing === true;
  const suffix = removed ? " (dihapus)" : missing ? " (folder hilang)" : "";
  return {
    label: `${shortBranch(worktree.branch)}${suffix}`,
    title: `${worktree.branch}\n${worktree.path}`,
    tone: removed ? "bad" : missing ? "warn" : "",
  };
}

/** Bungkus nilai dengan petik tunggal bila memuat spasi/karakter khusus. */
export function shellQuote(value: string): string {
  if (value !== "" && SAFE_SHELL.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Perintah yang bisa disalin untuk menggabungkan hasil kerja. */
export function mergeCommands(worktree: {
  repoRoot: string;
  branch: string;
  baseCommit: string;
}): string[] {
  return [
    `cd ${shellQuote(worktree.repoRoot)}`,
    `git merge ${shellQuote(worktree.branch)}`,
    `git cherry-pick ${shellQuote(worktree.baseCommit)}..${shellQuote(worktree.branch)}`,
  ];
}

/** Teks konfirmasi hapus worktree; membedakan kondisi bersih dan kotor. */
export function removeConfirmText(inspect: WorktreeInspect): string {
  const dirtyFiles = Math.max(0, inspect.dirtyFiles);
  const commitsAhead = Math.max(0, inspect.commitsAhead);
  if (dirtyFiles === 0 && commitsAhead === 0) {
    return "Hapus folder worktree? Cabang jejak tetap ada, jadi tidak ada commit yang hilang.";
  }
  return (
    `Worktree punya ${dirtyFiles} berkas berubah dan ${commitsAhead} commit belum digabung. ` +
    "Hapus paksa akan MENGHILANGKAN perubahan yang belum di-commit; cabang jejak/… tetap ada."
  );
}

/** Pesan lanjutan hanya boleh saat worktree ada dan foldernya tersedia. */
export function canSendToSession(session: WorktreeSession): { allowed: boolean; reason?: string } {
  const worktree: WorktreeInfo | undefined = session.worktree;
  if (worktree === undefined) return { allowed: true };
  if (worktree.removed === true) {
    return { allowed: false, reason: "Worktree sesi sudah dihapus." };
  }
  if (worktree.missing === true) {
    return { allowed: false, reason: "Folder worktree hilang; pulihkan dulu." };
  }
  return { allowed: true };
}

/** Peringatan perubahan di folder asli yang tidak ikut ke worktree. */
export function dirtyWarning(dirtyInSource: boolean | undefined): string | undefined {
  if (dirtyInSource !== true) return undefined;
  return "Perubahan yang belum di-commit di folder asli tidak ikut ke worktree.";
}
