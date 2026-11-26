import { Icon } from "./Icon";
import { sessionState } from "./SessionHeader";

export interface TeamStripProps {
  /** Judul sesi induk; "sesi induk" bila induk tak ada lagi di daftar. */
  parentTitle: string;
  /** Id induk untuk tautan; tanpa id tautan tak tampil. */
  parentId?: string;
  status: string;
  pendingPermissions: number;
  /** Pindah ke sesi induk. */
  onOpenParent?: (id: string) => void;
}

/** Pita tipis di sesi anak: asal induk dan statusnya, tanpa mengubah komposer. */
export function TeamStrip(props: TeamStripProps) {
  const state = sessionState(props.status, props.pendingPermissions);
  return (
    <div class="jk-team-strip" role="status">
      <Icon name="workspace" />
      <span>
        Anak dari{" "}
        {props.parentId !== undefined && props.onOpenParent !== undefined ? (
          <button
            type="button"
            class="jk-link-btn"
            aria-label={`Buka induk ${props.parentTitle}`}
            onClick={() => props.onOpenParent?.(props.parentId as string)}
          >
            {props.parentTitle}
          </button>
        ) : (
          <strong>{props.parentTitle}</strong>
        )}
      </span>
      <span class="jk-team-strip-state">
        <span class={`jk-dot${state.dot === "" ? "" : ` jk-dot-${state.dot}`}`} aria-hidden="true" />
        {state.label}
      </span>
    </div>
  );
}
