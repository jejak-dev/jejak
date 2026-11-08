import { useEffect, useRef, useState } from "preact/hooks";
import type { ApiClient } from "../lib/api";
import { readPanelPrefs, writePanelPrefs, type PanelTab } from "../lib/panel-prefs";
import { formatCount } from "../lib/format";
import { ChangesTab } from "./ChangesTab";
import { CheckpointsTab } from "./CheckpointsTab";
import { FilesTab } from "./FilesTab";
import { Icon } from "./Icon";

export interface PanelProps {
  api: ApiClient;
  sessionId: string;
  eventCount: number;
  status: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: "changes", label: "Perubahan" },
  { id: "files", label: "Berkas" },
  { id: "checkpoints", label: "Titik" },
];

export function Panel({ api, sessionId, eventCount, status, open, onOpenChange }: PanelProps) {
  const [tab, setTab] = useState<PanelTab>(() => readPanelPrefs().tab);
  const [fileCount, setFileCount] = useState<number | undefined>(undefined);
  const [checkpointCount, setCheckpointCount] = useState<number | undefined>(undefined);
  const [refreshToken, setRefreshToken] = useState(0);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    writePanelPrefs({ tab });
  }, [tab]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  const select = (next: PanelTab): void => setTab(next);

  const onTabKeyDown = (event: KeyboardEvent, index: number): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const next = TABS[(index + delta + TABS.length) % TABS.length]!;
    select(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <aside class="jk-panel" aria-label="Perubahan, berkas, dan titik">
      <div class="jk-panel-head">
        <div class="jk-panel-tabs" role="tablist" aria-label="Perubahan, berkas, dan titik">
          {TABS.map((entry, index) => (
            <button
              key={entry.id}
              ref={(element) => {
                tabRefs.current[entry.id] = element;
              }}
              type="button"
              role="tab"
              id={`jk-panel-tab-${entry.id}`}
              class={`jk-panel-tab${tab === entry.id ? " jk-panel-tab-active" : ""}`}
              aria-selected={tab === entry.id}
              aria-controls={`jk-panel-panel-${entry.id}`}
              tabIndex={tab === entry.id ? 0 : -1}
              onClick={() => select(entry.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {entry.label}
              {entry.id === "changes" && fileCount !== undefined && fileCount > 0 && (
                <span class="jk-panel-count">{formatCount(fileCount)}</span>
              )}
              {entry.id === "checkpoints" && checkpointCount !== undefined && checkpointCount > 0 && (
                <span class="jk-panel-count">{formatCount(checkpointCount)}</span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          class="jk-icon-btn jk-panel-refresh"
          aria-label="Muat ulang"
          onClick={() => setRefreshToken((value) => value + 1)}
        >
          <Icon name="refresh" />
        </button>
        <button
          ref={closeRef}
          type="button"
          class="jk-icon-btn jk-panel-close"
          aria-label="Tutup panel"
          onClick={() => onOpenChange(false)}
        >
          <Icon name="close" />
        </button>
      </div>

      <div
        class="jk-panel-content"
        role="tabpanel"
        id={`jk-panel-panel-${tab}`}
        aria-labelledby={`jk-panel-tab-${tab}`}
      >
        {tab === "changes" ? (
          <ChangesTab
            api={api}
            sessionId={sessionId}
            open={open}
            eventCount={eventCount}
            status={status}
            refreshToken={refreshToken}
            onFileCount={setFileCount}
          />
        ) : tab === "checkpoints" ? (
          <CheckpointsTab
            api={api}
            sessionId={sessionId}
            open={open}
            eventCount={eventCount}
            status={status}
            refreshToken={refreshToken}
            onCount={setCheckpointCount}
            onChanged={() => setRefreshToken((value) => value + 1)}
          />
        ) : (
          <FilesTab api={api} sessionId={sessionId} open={open} refreshToken={refreshToken} />
        )}
      </div>
    </aside>
  );
}
