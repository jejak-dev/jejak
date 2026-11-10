import { useEffect, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import type { ApiClient } from "../lib/api";
import { readPanelPrefs, writePanelPrefs, type PanelTab } from "../lib/panel-prefs";
import { formatCount } from "../lib/format";
import {
  effectivePanelRepo,
  checkpointRepoNote,
  panelRepoOptions,
  repoForRequest,
} from "../lib/workspace";
import { useSessionRepos } from "../hooks";
import { ChangesTab } from "./ChangesTab";
import { CheckpointsTab } from "./CheckpointsTab";
import { FilesTab } from "./FilesTab";
import { GitTab } from "./GitTab";
import { Icon } from "./Icon";
import { SecretsTab } from "./SecretsTab";
import { TerminalTab } from "./TerminalTab";

export interface PanelProps {
  api: ApiClient;
  sessionId: string;
  /** Sesi terpilih; diteruskan ke tab Git untuk kotak worktree. */
  session?: SessionInfo;
  eventCount: number;
  status: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Permintaan pindah tab dari luar (palette); `nonce` memaksa ulang. */
  tabRequest?: { tab: PanelTab; nonce: number };
  /** Dipanggil setelah aksi yang mengubah sesi (mis. hapus/pulihkan worktree). */
  onSessionChanged?: () => void;
}

const TABS: { id: PanelTab; label: string }[] = [
  { id: "changes", label: "Perubahan" },
  { id: "files", label: "Berkas" },
  { id: "git", label: "Git" },
  { id: "checkpoints", label: "Titik" },
  { id: "rahasia", label: "Rahasia" },
  { id: "terminal", label: "Terminal" },
];

export function Panel({
  api,
  sessionId,
  session,
  eventCount,
  status,
  open,
  onOpenChange,
  tabRequest,
  onSessionChanged,
}: PanelProps) {
  const [tab, setTab] = useState<PanelTab>(() => readPanelPrefs().tab);
  const [fileCount, setFileCount] = useState<number | undefined>(undefined);
  const [gitCount, setGitCount] = useState<number | undefined>(undefined);
  const [checkpointCount, setCheckpointCount] = useState<number | undefined>(undefined);
  const [refreshToken, setRefreshToken] = useState(0);
  // Draf pesan commit bertahan saat pindah tab selama panel (per sesi) hidup.
  const [commitDraft, setCommitDraft] = useState("");
  // Pilihan repo hanya disimpan di state; panel dipasang ulang per sesi, jadi
  // pindah sesi kembali ke repo utama.
  const [repoChoice, setRepoChoice] = useState<string | undefined>(undefined);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const repos = useSessionRepos(api, sessionId, status).repos;
  const multiRepo = repos !== undefined && repos.length > 1;
  const effective = multiRepo ? effectivePanelRepo(repos, repoChoice) : undefined;
  const repo = multiRepo ? repoForRequest(repos, repoChoice) : undefined;
  const repoOptions = multiRepo ? panelRepoOptions(repos) : [];
  const checkpointNote = checkpointRepoNote(repos);

  useEffect(() => {
    writePanelPrefs({ tab });
  }, [tab]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (tabRequest === undefined) return;
    setTab(tabRequest.tab);
  }, [tabRequest?.nonce]);

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
    <aside class="jk-panel" aria-label="Perubahan, berkas, git, titik, dan rahasia">
      <div class="jk-panel-head">
        <div class="jk-panel-tabs" role="tablist" aria-label="Perubahan, berkas, git, titik, dan rahasia">
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
              {entry.id === "git" && gitCount !== undefined && gitCount > 0 && (
                <span class="jk-panel-count">{formatCount(gitCount)}</span>
              )}
              {entry.id === "checkpoints" && checkpointCount !== undefined && checkpointCount > 0 && (
                <span class="jk-panel-count">{formatCount(checkpointCount)}</span>
              )}
            </button>
          ))}
        </div>
        {multiRepo && (
          <label class="jk-chip" title="Repo">
            <Icon name="folder" />
            <span>{effective}</span>
            <select
              class="jk-chip-select"
              aria-label="Repo"
              value={effective ?? ""}
              onChange={(event) =>
                setRepoChoice((event.currentTarget as HTMLSelectElement).value)
              }
            >
              {repoOptions.map((option) => (
                <option key={option.value} value={option.value} disabled={option.missing}>
                  {option.missing ? `${option.label} (hilang)` : option.label}
                </option>
              ))}
            </select>
          </label>
        )}
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
            repo={repo}
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
            repoNote={checkpointNote}
            onCount={setCheckpointCount}
            onChanged={() => setRefreshToken((value) => value + 1)}
          />
        ) : tab === "git" ? (
          <GitTab
            api={api}
            sessionId={sessionId}
            session={session}
            open={open}
            eventCount={eventCount}
            status={status}
            refreshToken={refreshToken}
            repo={repo}
            draft={commitDraft}
            onDraftChange={setCommitDraft}
            onOpenChanges={() => select("changes")}
            onCount={setGitCount}
            onChanged={() => setRefreshToken((value) => value + 1)}
            onSessionChanged={onSessionChanged}
          />
        ) : tab === "rahasia" ? (
          <SecretsTab api={api} sessionId={sessionId} />
        ) : tab === "terminal" ? (
          <TerminalTab api={api} cwd={session?.cwd ?? ""} />
        ) : (
          <FilesTab
            api={api}
            sessionId={sessionId}
            open={open}
            refreshToken={refreshToken}
            repo={repo}
            sessionRunning={status === "berjalan"}
          />
        )}
      </div>
    </aside>
  );
}
