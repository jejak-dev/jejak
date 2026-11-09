import type { SessionInfo } from "../../server/sessions/session-manager";
import { budgetBadge } from "../lib/budget";
import { showsBypassMarker } from "../lib/permission-mode";
import { secretBadge } from "../lib/secret-badge";
import { sessionContextLabel } from "../lib/workspace";
import { worktreeBadge } from "../lib/worktree";
import { Icon } from "./Icon";

export interface TopbarProps {
  onMenu: () => void;
  title?: string;
  subtitle?: string;
  subtitleTitle?: string;
  state?: { label: string; dot: "" | "run" | "warn" | "bad" };
  bypass?: boolean;
  badge?: { label: string; title: string; tone: "" | "warn" | "bad" };
  secretBadge?: { label: string; title: string };
  budgetBadge?: { label: string; title: string; tone: "warn" | "bad" };
  action?: { label: string; onClick: () => void; disabled?: boolean };
  panel?: { open: boolean; onToggle: () => void };
  error?: string;
}

export function Topbar({ onMenu, title, subtitle, subtitleTitle, state, bypass, badge, secretBadge, budgetBadge, action, panel, error }: TopbarProps) {
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
        {badge !== undefined && (
          <span
            class={`jk-worktree-badge${badge.tone === "" ? "" : ` jk-worktree-badge-${badge.tone}`}`}
            title={badge.title}
            aria-label={`Worktree ${badge.label}`}
          >
            <Icon name="branch" />
            <span>{badge.label}</span>
          </span>
        )}
        {secretBadge !== undefined && (
          <span class="jk-secret-badge" title={secretBadge.title} aria-label={secretBadge.label}>
            <Icon name="shield" />
            <span>{secretBadge.label}</span>
          </span>
        )}
        {budgetBadge !== undefined && (
          <span
            class={`jk-budget-badge jk-budget-badge-${budgetBadge.tone}`}
            title={budgetBadge.title}
            aria-label={budgetBadge.label}
          >
            <Icon name="alert" />
            <span>{budgetBadge.label}</span>
          </span>
        )}
      </div>
      {bypass === true && <span class="jk-bypass-marker">Tanpa izin</span>}
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
  if (showsBypassMarker(session.permissionMode)) props.bypass = true;
  const badge = worktreeBadge(session);
  if (badge !== undefined) props.badge = badge;
  const secret = secretBadge(session);
  if (secret !== undefined) props.secretBadge = secret;
  const budget = budgetBadge(session);
  if (budget !== undefined) props.budgetBadge = budget;
  if (error !== undefined) props.error = error;
  return <Topbar {...props} />;
}
