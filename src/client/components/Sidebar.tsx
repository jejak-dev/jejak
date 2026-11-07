import type { SessionInfo } from "../../server/sessions/session-manager";
import { formatAgo, groupSessions } from "../lib/format";
import { Icon } from "./Icon";

export interface SidebarProps {
  info?: { name: string; version: string; mock: boolean };
  sessions: SessionInfo[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
  activeProfileLabel?: string;
  providersActive?: boolean;
}

function dotClass(session: SessionInfo): string {
  if (session.pendingPermissions > 0) return "jk-dot jk-dot-warn";
  if (session.status === "berjalan") return "jk-dot jk-dot-run";
  if (session.status === "gagal") return "jk-dot jk-dot-bad";
  return "jk-dot";
}

function dotLabel(session: SessionInfo): string | undefined {
  if (session.pendingPermissions > 0) return "Menunggu izin";
  if (session.status === "berjalan") return "Berjalan";
  if (session.status === "gagal") return "Gagal";
  return undefined;
}

export function Sidebar({
  info,
  sessions,
  selectedId,
  onSelect,
  onNew,
  onClose,
  activeProfileLabel,
  providersActive = false,
}: SidebarProps) {
  const now = new Date();
  const groups = groupSessions(sessions);

  return (
    <aside class="jk-sidebar" aria-label="Navigasi">
      <header class="jk-brand">
        <h1 class="jk-brand-title">Jejak</h1>
        {info?.mock === true && <span class="jk-brand-tag">mock</span>}
        <button type="button" class="jk-icon-btn jk-drawer-close" onClick={onClose} aria-label="Tutup sidebar">
          <Icon name="menu" />
        </button>
      </header>

      <button type="button" class="jk-button jk-button-primary jk-new" onClick={onNew}>
        <Icon name="plus" />
        Sesi baru
      </button>

      <nav class="jk-groups" aria-label="Daftar sesi">
        {groups.length === 0 ? (
          <p class="jk-empty-line">Belum ada sesi.</p>
        ) : (
          groups.map((group) => (
            <section class="jk-group" key={group.cwd}>
              <h2 class="jk-group-label" title={group.cwd}>
                <Icon name="folder" />
                <span>{group.label}</span>
              </h2>
              <ul class="jk-session-items">
                {group.items.map((session) => {
                  const selected = session.id === selectedId;
                  const label = dotLabel(session);
                  return (
                    <li key={session.id}>
                      <button
                        type="button"
                        class={`jk-session-row${selected ? " jk-session-row-active" : ""}`}
                        onClick={() => onSelect(session.id)}
                        aria-current={selected ? "page" : undefined}
                      >
                        <span
                          class={dotClass(session)}
                          title={label}
                          role={label === undefined ? undefined : "img"}
                          aria-label={label}
                          aria-hidden={label === undefined ? "true" : undefined}
                        />
                        <span class="jk-session-title">{session.title}</span>
                        <time class="jk-session-time" dateTime={session.updatedAt}>
                          {formatAgo(session.updatedAt, now)}
                        </time>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </nav>

      <footer class="jk-sidebar-foot">
        <a
          class={`jk-foot-link${providersActive ? " jk-foot-link-active" : ""}`}
          href="#/providers"
          aria-current={providersActive ? "page" : undefined}
        >
          <Icon name="cube" />
          <span class="jk-foot-text">{activeProfileLabel ?? "Atur provider"}</span>
          <Icon name="gear" />
        </a>
      </footer>
    </aside>
  );
}
