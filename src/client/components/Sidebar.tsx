import type { SessionInfo } from "../../server/sessions/session-manager";
import { formatRelative, statusTone } from "../lib/format";

export interface SidebarProps {
  info?: { name: string; version: string; mock: boolean };
  sessions: SessionInfo[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  activeProfileLabel?: string;
  providersActive?: boolean;
}

export function Sidebar({
  info,
  sessions,
  selectedId,
  onSelect,
  onNew,
  activeProfileLabel,
  providersActive = false,
}: SidebarProps) {
  const now = new Date();

  return (
    <aside class="jk-sidebar">
      <header class="jk-sidebar-head">
        <div class="jk-brand">
          <h1 class="jk-brand-title">Jejak</h1>
          {info !== undefined && <span class="jk-version">{info.version}</span>}
          {info?.mock === true && <span class="jk-badge jk-badge-muted">mock</span>}
        </div>
        <button type="button" class="jk-button jk-button-secondary" onClick={onNew}>
          Sesi baru
        </button>
      </header>

      <nav class="jk-session-list" aria-label="Daftar sesi">
        {sessions.length === 0 ? (
          <p class="jk-empty-line">
            Belum ada sesi. Tulis tugas di kolom bawah untuk memulai.
          </p>
        ) : (
          <ul class="jk-session-items">
            {sessions.map((session) => {
              const tone = statusTone(session.status);
              const selected = session.id === selectedId;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    class={`jk-session-item${selected ? " jk-session-item-active" : ""}`}
                    onClick={() => onSelect(session.id)}
                    aria-current={selected ? "page" : undefined}
                  >
                    <span class="jk-session-title">{session.title}</span>
                    <span class="jk-session-meta">
                      <span class={`jk-badge jk-badge-${tone}`}>{session.status}</span>
                      <span class="jk-session-profile">{session.profileId}</span>
                      <span class="jk-session-time">
                        {formatRelative(session.updatedAt, now)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <footer class="jk-sidebar-foot">
        <p class="jk-foot-line">
          Aktif: {activeProfileLabel ?? "belum ada profil"}
        </p>
        <a
          class={`jk-foot-link${providersActive ? " jk-foot-link-active" : ""}`}
          href="#/providers"
          aria-current={providersActive ? "page" : undefined}
        >
          Pengaturan provider
        </a>
      </footer>
    </aside>
  );
}
