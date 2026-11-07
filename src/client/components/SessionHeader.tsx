import type { SessionInfo } from "../../server/sessions/session-manager";
import { shortPath, statusTone } from "../lib/format";

export interface SessionHeaderProps {
  session: SessionInfo;
  status: string;
  onInterrupt: () => void;
  busy: boolean;
  error?: string;
}

const PERMISSION_LABELS: Record<string, string> = {
  default: "Tanya dulu",
  acceptEdits: "Setujui edit",
  plan: "Hanya rencana",
};

export function SessionHeader({ session, status, onInterrupt, busy, error }: SessionHeaderProps) {
  const effectiveStatus = status;
  const tone = statusTone(effectiveStatus);
  const permissionLabel = PERMISSION_LABELS[session.permissionMode] ?? session.permissionMode;

  return (
    <header class="jk-session-header">
      <div class="jk-session-header-main">
        <h2 class="jk-session-header-title">{session.title}</h2>
        <p class="jk-session-header-meta">
          <span class="jk-mono" title={session.cwd}>
            {shortPath(session.cwd)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{permissionLabel}</span>
          <span class={`jk-badge jk-badge-${tone}`}>{effectiveStatus}</span>
        </p>
      </div>
      {effectiveStatus === "berjalan" && (
        <button
          type="button"
          class="jk-button jk-button-secondary"
          onClick={onInterrupt}
          disabled={busy}
        >
          Hentikan
        </button>
      )}
      {error !== undefined && (
        <p class="jk-error-line" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}
