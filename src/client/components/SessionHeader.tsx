import type { SessionInfo } from "../../server/sessions/session-manager";
import { budgetBadge } from "../lib/budget";
import { showsBypassMarker } from "../lib/permission-mode";
import { sandboxBadge } from "../lib/sandbox";
import { secretBadge } from "../lib/secret-badge";
import { sessionSubtitle } from "../lib/workspace";
import { worktreeBadge } from "../lib/worktree";
import { Icon } from "./Icon";

export interface TopbarProps {
  onMenu: () => void;
  /** Layar ponsel: tombol menu diganti tombol kembali. */
  mobile?: boolean;
  /** Aksi tombol kembali di layar ponsel. */
  onBack?: () => void;
  title?: string;
  subtitle?: string;
  subtitleTitle?: string;
  state?: { label: string; dot: "" | "run" | "warn" | "bad" };
  bypass?: boolean;
  badge?: { label: string; title: string; tone: "" | "warn" | "bad" };
  secretBadge?: { label: string; title: string; ariaLabel?: string };
  budgetBadge?: { label: string; title: string; tone: "warn" | "bad" };
  sandboxBadge?: { label: string; title: string; tone: "warn" };
  panel?: { open: boolean; onToggle: () => void };
  error?: string;
}

export function Topbar({ onMenu, mobile, onBack, title, subtitle, subtitleTitle, state, bypass, badge, secretBadge, budgetBadge, sandboxBadge: sandbox, panel, error }: TopbarProps) {
  return (
    <header class="jk-top">
      {mobile === true ? (
        <button
          type="button"
          class="jk-icon-btn jk-back-btn"
          onClick={onBack ?? onMenu}
          aria-label="Kembali"
        >
          <Icon name="back" />
        </button>
      ) : (
        <button type="button" class="jk-icon-btn jk-menu-btn" onClick={onMenu} aria-label="Buka sidebar">
          <Icon name="menu" />
        </button>
      )}
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
          <span
            class="jk-secret-badge"
            title={secretBadge.title}
            aria-label={secretBadge.ariaLabel ?? secretBadge.label}
          >
            <Icon name="shield" />
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
        {sandbox !== undefined && (
          <span
            class={`jk-sandbox-badge jk-sandbox-badge-${sandbox.tone}`}
            title={sandbox.title}
            aria-label={sandbox.label}
          >
            <Icon name="shield" />
            <span>{sandbox.label}</span>
          </span>
        )}
      </div>
      {bypass === true && (
        <span
          class="jk-bypass-marker"
          title="Izin dilewati: agen menjalankan tool tanpa bertanya"
        >
          Bypass
        </span>
      )}
      {state !== undefined && (
        <span class="jk-state" role="status" aria-label={state.label} title={state.label}>
          <span class={`jk-dot${state.dot === "" ? "" : ` jk-dot-${state.dot}`}`} aria-hidden="true" />
          <span class="jk-state-label">{state.label}</span>
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
  onMenu: () => void;
  /** Layar ponsel: tombol kembali menggantikan menu. */
  mobile?: boolean;
  /** Kembali ke daftar sesi (batalkan pilihan). */
  onBack?: () => void;
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
  onMenu,
  mobile,
  onBack,
  panelOpen,
  onTogglePanel,
  error,
}: SessionHeaderProps) {
  const props: TopbarProps = {
    onMenu,
    title: session.title,
    subtitle: sessionSubtitle({ workspaceName: session.workspaceName, cwd: session.cwd }),
    subtitleTitle: session.cwd,
    state: sessionState(status, session.pendingPermissions),
    panel: { open: panelOpen, onToggle: onTogglePanel },
  };
  if (mobile === true) {
    props.mobile = true;
    if (onBack !== undefined) props.onBack = onBack;
  }
  if (showsBypassMarker(session.permissionMode)) props.bypass = true;
  const badge = worktreeBadge(session);
  if (badge !== undefined) props.badge = badge;
  const secret = secretBadge(session);
  if (secret !== undefined) props.secretBadge = secret;
  const budget = budgetBadge(session);
  if (budget !== undefined) props.budgetBadge = budget;
  const sandbox = sandboxBadge(session);
  if (sandbox !== undefined) props.sandboxBadge = sandbox;
  if (error !== undefined) props.error = error;
  return <Topbar {...props} />;
}
