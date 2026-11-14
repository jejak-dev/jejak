import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import type { ApiClient } from "../lib/api";
import { readPanelPrefs, writePanelPrefs, type PanelTab } from "../lib/panel-prefs";
import {
  PANEL_RAIL_GROUPS,
  PANEL_RAIL_TABS,
  nextPanelTabIndex,
  panelTabLabel,
} from "../lib/panel-rail";
import { formatCount } from "../lib/format";
import type { TimelineItem } from "../lib/timeline";
import { latestTodos, todoProgress } from "../lib/todos";
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
import { RunnerTab } from "./RunnerTab";
import { SecretsTab } from "./SecretsTab";
import { TerminalTab } from "./TerminalTab";
import { TodosTab } from "./TodosTab";
import { WikiTab } from "./WikiTab";

export interface PanelProps {
  /** Lebar panel dalam px; default dari CSS bila kosong. */
  width?: number;
  api: ApiClient;
  sessionId: string;
  /** Sesi terpilih; diteruskan ke tab Git untuk kotak worktree. */
  session?: SessionInfo;
  eventCount: number;
  status: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Item timeline berjalan; sumber daftar langkah agent (tool TodoWrite). */
  timelineItems?: readonly TimelineItem[];
  /** Permintaan pindah tab dari luar (palette); `nonce` memaksa ulang. */
  tabRequest?: { tab: PanelTab; nonce: number };
  /** Dipanggil setelah aksi yang mengubah sesi (mis. hapus/pulihkan worktree). */
  onSessionChanged?: () => void;
  /** Kutipan wiki yang ditempel ke kolom pesan; tidak mengirim apa pun. */
  onQuote?: (text: string) => void;
}

const PANEL_LABEL =
  "Perubahan, langkah, berkas, git, checkpoint, rahasia, wiki, perintah, dan terminal";

/** Kunci navigasi keyboard pada rel ikon. */
const RAIL_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

export function Panel({
  width,
  api,
  sessionId,
  session,
  eventCount,
  status,
  open,
  onOpenChange,
  timelineItems,
  tabRequest,
  onSessionChanged,
  onQuote,
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
  // Terminal yang dibuat peluncur perintah; tab Terminal menempel ke sana.
  const [terminalToAttach, setTerminalToAttach] = useState<string | undefined>(undefined);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const repos = useSessionRepos(api, sessionId, status).repos;
  const multiRepo = repos !== undefined && repos.length > 1;
  const effective = multiRepo ? effectivePanelRepo(repos, repoChoice) : undefined;
  const repo = multiRepo ? repoForRequest(repos, repoChoice) : undefined;
  const repoOptions = multiRepo ? panelRepoOptions(repos) : [];
  const checkpointNote = checkpointRepoNote(repos);

  // Daftar langkah agent berasal dari tool TodoWrite di timeline berjalan.
  const todos = useMemo(() => latestTodos(timelineItems ?? []), [timelineItems]);
  const todoProgressValue = todoProgress(todos);
  const todoPending = todoProgressValue.total - todoProgressValue.done;

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

  /** Lencana jumlah pada rel ikon; 0 atau tidak diketahui disembunyikan. */
  const countFor = (id: PanelTab): number | undefined => {
    switch (id) {
      case "todos":
        return todoPending;
      case "changes":
        return fileCount;
      case "git":
        return gitCount;
      case "checkpoints":
        return checkpointCount;
      default:
        return undefined;
    }
  };

  /** Terminal baru dari peluncur perintah: pindah ke tab Terminal dan menempel. */
  const onOpenTerminal = (terminalId: string): void => {
    setTerminalToAttach(terminalId);
    select("terminal");
  };

  const onRailKeyDown = (event: KeyboardEvent, index: number): void => {
    if (!RAIL_KEYS.has(event.key)) return;
    event.preventDefault();
    const next = PANEL_RAIL_TABS[nextPanelTabIndex(event.key, index)];
    if (!next) return;
    select(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <aside
      class="jk-panel"
      style={width === undefined ? undefined : { width: `${width}px` }}
      aria-label={PANEL_LABEL}>
      <div class="jk-panel-head">
        <span class="jk-panel-title">{panelTabLabel(tab)}</span>
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
        class="jk-panel-rail"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Bagian panel"
      >
        {PANEL_RAIL_GROUPS.map((group) => (
          <div class="jk-rail-group" role="group" aria-label={group.label} key={group.id}>
            {group.tabs.map((entry) => {
              const index = PANEL_RAIL_TABS.findIndex((item) => item.id === entry.id);
              const count = countFor(entry.id);
              return (
                <button
                  key={entry.id}
                  ref={(element) => {
                    tabRefs.current[entry.id] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`jk-panel-tab-${entry.id}`}
                  class={`jk-rail-btn${tab === entry.id ? " jk-rail-btn-active" : ""}`}
                  aria-selected={tab === entry.id}
                  aria-controls={`jk-panel-panel-${entry.id}`}
                  tabIndex={tab === entry.id ? 0 : -1}
                  title={entry.label}
                  aria-label={entry.label}
                  onClick={() => select(entry.id)}
                  onKeyDown={(event) => onRailKeyDown(event, index)}
                >
                  <Icon name={entry.icon} />
                  {count !== undefined && count > 0 && (
                    <span class="jk-rail-badge">{formatCount(count)}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
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
        ) : tab === "todos" ? (
          <TodosTab todos={todos} />
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
        ) : tab === "wiki" ? (
          <WikiTab api={api} cwd={session?.cwd ?? ""} onQuote={onQuote} />
        ) : tab === "commands" ? (
          <RunnerTab
            api={api}
            cwd={session?.cwd ?? ""}
            onOpenTerminal={onOpenTerminal}
          />
        ) : tab === "terminal" ? (
          <TerminalTab api={api} cwd={session?.cwd ?? ""} attachId={terminalToAttach} />
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
