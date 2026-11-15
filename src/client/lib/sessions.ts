import type { SessionInfo } from "../../server/sessions/session-manager";
import type { TimelineItem } from "./timeline";

/**
 * Batas yang sama dengan server (`validateTitle` di `session-manager.ts`).
 * Disalin agar bundel klien tidak menarik modul server.
 */
export const SESSION_TITLE_MAX = 120;

export function isArchived(session: SessionInfo): boolean {
  return session.archivedAt !== undefined;
}

export interface SplitSessions {
  active: SessionInfo[];
  archived: SessionInfo[];
}

export function splitArchived(sessions: readonly SessionInfo[]): SplitSessions {
  const active: SessionInfo[] = [];
  const archived: SessionInfo[] = [];
  for (const session of sessions) {
    if (isArchived(session)) archived.push(session);
    else active.push(session);
  }
  return { active, archived };
}

/**
 * Cocok tak peka huruf pada judul, cwd, dan nama workspace. Sesi terarsip
 * hanya ikut bila `showArchived`; di luar itu selalu disembunyikan.
 */
export function filterSessions(
  sessions: readonly SessionInfo[],
  query: string,
  showArchived = false,
): SessionInfo[] {
  const needle = query.trim().toLowerCase();
  return sessions.filter((session) => {
    if (isArchived(session) && !showArchived) return false;
    if (needle === "") return true;
    if (session.title.toLowerCase().includes(needle)) return true;
    if (session.cwd.toLowerCase().includes(needle)) return true;
    return session.workspaceName?.toLowerCase().includes(needle) ?? false;
  });
}

/** Pesan galat judul, atau `undefined` bila sah (1..120 karakter, tanpa kontrol). */
export function validateTitle(text: string): string | undefined {
  const value = text.trim();
  if (value === "" || value.length > SESSION_TITLE_MAX) {
    return `Judul harus 1..${SESSION_TITLE_MAX} karakter.`;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return "Judul tidak boleh memuat karakter kontrol.";
  }
  return undefined;
}

/** Arsip dan hapus ditolak server selama sesi berjalan. */
export function canMutate(session: SessionInfo): boolean {
  return session.status !== "berjalan";
}

/** Pesan galat yang ditambahkan saat server dimulai ulang di tengah sesi. */
export const SESSION_RESTART_MESSAGE = "server dimulai ulang saat sesi berjalan";

/**
 * True bila sesi terakhir berakhir karena server dimulai ulang (aplikasi
 * berhenti mendadak) dan belum ada giliran baru sesudahnya.
 */
export function endedByRestart(items: readonly TimelineItem[]): boolean {
  let index = -1;
  for (let position = items.length - 1; position >= 0; position -= 1) {
    if (items[position]!.kind === "error") {
      index = position;
      break;
    }
  }
  if (index === -1) return false;
  const item = items[index]!;
  if (item.kind !== "error" || item.message !== SESSION_RESTART_MESSAGE) return false;
  // Ada pesan pengguna sesudahnya: sesi sudah berjalan lagi.
  return !items.slice(index + 1).some((entry) => entry.kind === "user");
}
