import type { SessionInfo } from "../../server/sessions/session-manager";
import { folderName, formatAgo, sessionHash } from "../lib/format";
import { filterSessions } from "../lib/sessions";
import { dotClass, dotLabel } from "./Sidebar";

export interface RecentSessionsProps {
  sessions: SessionInfo[];
  /** Jumlah sesi yang ditampilkan; bawaan 4. */
  limit?: number;
}

/**
 * Daftar "Lanjutkan sesi" di beranda: sesi terbaru (bukan arsip) supaya
 * pengguna bisa lanjut kerja tanpa membuka sidebar. Urutan dan waktu relatif
 * mengikuti sidebar (pembaruan terakhir, `formatAgo`).
 */
export function RecentSessions({ sessions, limit = 4 }: RecentSessionsProps) {
  const now = new Date();
  const terbaru = filterSessions(sessions, "")
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, limit);

  if (terbaru.length === 0) return null;

  return (
    <section class="jk-home-recent" aria-labelledby="jk-home-recent-title">
      <h3 id="jk-home-recent-title" class="jk-home-recent-title">
        Lanjutkan sesi
      </h3>
      <ul class="jk-home-recent-list">
        {terbaru.map((session) => {
          const label = dotLabel(session);
          return (
            <li key={session.id}>
              <a class="jk-home-recent-row" href={sessionHash(session.id)}>
                <span
                  class={dotClass(session)}
                  title={label}
                  role={label === undefined ? undefined : "img"}
                  aria-label={label}
                  aria-hidden={label === undefined ? "true" : undefined}
                />
                <span class="jk-home-recent-name">{session.title}</span>
                <span class="jk-home-recent-folder jk-mono">{folderName(session.cwd)}</span>
                <time class="jk-home-recent-time" dateTime={session.updatedAt}>
                  {formatAgo(session.updatedAt, now)}
                </time>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
