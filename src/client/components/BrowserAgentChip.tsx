import { agentChipLabel, type BrowserAgentInfo } from "../lib/browser";

/** Catatan aktivitas agent dari state server (bila ada). */
export interface BrowserAgentChipProps {
  /** Aktivitas agent terakhir; undefined berarti tak ada agent yang bekerja. */
  agent?: BrowserAgentInfo;
}

/**
 * Chip penanda aktivitas agent (murni, tanpa hook).
 *
 * Ditampilkan di atas layar browser selama agent sedang bertindak. Bila tak
 * ada aktivitas, komponen tak menampilkan apa pun. Teksnya dibaca screen
 * reader lewat `role="status"` dan `aria-live="polite"`.
 */
export function BrowserAgentChip({ agent }: BrowserAgentChipProps) {
  const label = agentChipLabel(agent);
  if (label === "") return null;
  return (
    <div class="jk-browser-agent" role="status" aria-live="polite">
      <span class="jk-browser-agent-dot" aria-hidden="true" />
      <span class="jk-browser-agent-text">{label}</span>
    </div>
  );
}
