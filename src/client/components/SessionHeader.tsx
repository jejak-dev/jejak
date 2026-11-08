import type { SessionInfo } from "../../server/sessions/session-manager";
import { sessionContextLabel } from "../lib/workspace";
import { Icon } from "./Icon";

export interface TopbarProps {
  onMenu: () => void;
  title?: string;
  subtitle?: string;
  subtitleTitle?: string;
  state?: { label: string; dot: "" | "run" | "warn" | "bad" };
  action?: { label: string; onClick: () => void; disabled?: boolean };
  panel?: { open: boolean; onToggle: () => void };
  error?: string;
}

export function Topbar({ onMenu, title, subtitle, subtitleTitle, state, action, panel, error }: TopbarProps) {
  return (
    <header class="jk-top">
      <button type="button" class="jk-icon-btn jk-menu-btn" onClick={onMenu} aria-label="Buka sidebar">
        <Icon name="menu" />
      </button>
      <div class="jk-top-title">
        {title !== undefined && <h2>{title}</h2>}
        {subtitle !== undefined && (
          <span class="jk-mono" title={subtitleTitle}>
            {subtitle}
          </span>
        )}
      </div>
      {state !== undefined && (
        <span class="jk-state" role="status">
          <span class={`jk-dot${state.dot === "" ? "" : ` jk-dot-${state.dot}`}`} aria-hidden="true" />
          {state.label}
        </span>
      )}
      {panel !== undefined && (
        <button
          type="button"
          class="jk-icon-btn"
          aria-label="Perubahan dan berkas"
          aria-pressed={panel.open}
          onClick={panel.onToggle}
        >
          <Icon name="folder" />
        </button>
      )}
      {action !== undefined && (
        <button type="button" class="jk-pill-btn" onClick={action.onClick} disabled={action.disabled}>
          <Icon name="stop" />
          {action.label}
        </button>
      )}
      {error !== undefined && (
        <p class="jk-top-error" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}

export interface SessionHeaderProps {
  session: SessionInfo;
  status: string;
  onInterrupt: () => void;
  onMenu: () => void;
  busy: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
  error?: string;
}

export function sessionState(
  status: string,
  pendingPermissions: number,
): { label: string; dot: "" | "run" | "warn" | "bad" } {
  if (status === "berjalan") {
    return pendingPermissions > 0
      ? { label: `Menunggu izin${pendingPermissions > 1 ? ` (${pendingPermissions})` : ""}`, dot: "warn" }
      : { label: "Berjalan", dot: "run" };
  }
  if (status === "gagal") return { label: "Gagal", dot: "bad" };
  if (status === "dibatalkan") return { label: "Dihentikan", dot: "" };
  return { label: "Selesai", dot: "" };
}

export function SessionHeader({
  session,
  status,
  onInterrupt,
  onMenu,
  busy,
  panelOpen,
  onTogglePanel,
  error,
}: SessionHeaderProps) {
  const props: TopbarProps = {
    onMenu,
    title: session.title,
    subtitle: sessionContextLabel({ workspaceName: session.workspaceName, cwd: session.cwd }),
    subtitleTitle: session.cwd,
    state: sessionState(status, session.pendingPermissions),
    panel: { open: panelOpen, onToggle: onTogglePanel },
  };
  if (status === "berjalan") props.action = { label: "Hentikan", onClick: onInterrupt, disabled: busy };
  if (error !== undefined) props.error = error;
  return <Topbar {...props} />;
}
