import { useEffect, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import {
  ApiError,
  type ApiClient,
  type GitCommit,
  type GitStatus,
} from "../lib/api";
import {
  aheadBehindLabel,
  branchLabel,
  canWrite,
  commitSubject,
  groupStatus,
  relativeTime,
  shouldRefreshGit,
  stateLabel,
  totalFiles,
  validateMessage,
  type GitGroup,
  type GitGroupFile,
  type GitMarker,
} from "../lib/git";
import { formatCount } from "../lib/format";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icon";
import { WorktreeBox } from "./WorktreeBox";

export interface GitTabProps {
  api: ApiClient;
  sessionId: string;
  /** Sesi lengkap; dipakai kotak worktree bila sesi punya worktree. */
  session?: SessionInfo;
  open: boolean;
  eventCount: number;
  status: string;
  refreshToken: number;
  /** Nama repo workspace; undefined berarti repo utama (cwd sesi). */
  repo?: string;
  /** Draf pesan commit dimiliki Panel agar bertahan saat pindah tab. */
  draft: string;
  onDraftChange: (value: string) => void;
  /** Klik path berpindah ke tab Perubahan. */
  onOpenChanges: () => void;
  /** Jumlah berkas untuk lencana angka di tab; undefined saat belum diketahui. */
  onCount?: (count: number | undefined) => void;
  /** Dipanggil setelah commit agar tab lain menyegar. */
  onChanged?: () => void;
  /** Dipanggil setelah aksi worktree agar daftar sesi dimuat ulang. */
  onSessionChanged?: () => void;
}

interface ShowState {
  loading: boolean;
  text?: string;
  truncated?: boolean;
  error?: string;
}

const DISABLED_MESSAGE = "Panel git dimatikan.";
const WRITE_DISABLED_MESSAGE = "Penulisan git dimatikan.";
const LOG_LIMIT = 30;
const MAX_BATCH_PATHS = 200;
const COMMIT_NOTE_MS = 6000;

function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "status git tidak dapat dimuat";
}

export function GitTab({
  api,
  sessionId,
  session,
  open,
  eventCount,
  status,
  refreshToken,
  repo,
  draft,
  onDraftChange,
  onOpenChanges,
  onCount,
  onChanged,
  onSessionChanged,
}: GitTabProps) {
  const [data, setData] = useState<GitStatus | undefined>(undefined);
  const [commits, setCommits] = useState<GitCommit[]>([]);  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [disabled, setDisabled] = useState<string | undefined>(undefined);
  const [writeDisabled, setWriteDisabled] = useState(false);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [commitError, setCommitError] = useState<string | undefined>(undefined);
  const [commitNote, setCommitNote] = useState<string | undefined>(undefined);
  const [commitBusy, setCommitBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [shows, setShows] = useState<Record<string, ShowState | undefined>>({});
  const [now, setNow] = useState(() => new Date());

  const requestRef = useRef(0);
  const logRef = useRef(0);
  const showRef = useRef(0);
  const markerRef = useRef<GitMarker | undefined>(undefined);
  const tokenRef = useRef(0);
  const repoRef = useRef(repo);
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitButtonRef = useRef<HTMLButtonElement | null>(null);

  const activeRepo = repo;

  const clearCommitNote = (): void => {
    if (noteTimerRef.current !== undefined) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = undefined;
    setCommitNote(undefined);
  };

  useEffect(() => {
    return () => {
      if (noteTimerRef.current !== undefined) clearTimeout(noteTimerRef.current);
    };
  }, []);

  const loadLog = async (requestRepo: string | undefined): Promise<void> => {
    logRef.current += 1;
    const ticket = logRef.current;
    try {
      const payload = await api.gitLog(sessionId, { repo: requestRepo, limit: LOG_LIMIT });
      if (ticket !== logRef.current) return;
      setCommits(payload.commits);
    } catch {
      if (ticket !== logRef.current) return;
      setCommits([]);
    }
  };

  const loadStatus = async (requestRepo: string | undefined): Promise<boolean> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const payload = await api.gitStatus(sessionId, requestRepo);
      if (ticket !== requestRef.current) return false;
      setData(payload);
      setNow(new Date());
      onCount?.(payload.isRepo ? totalFiles(payload) : undefined);
      return true;
    } catch (caught) {
      if (ticket !== requestRef.current) return false;
      if (caught instanceof ApiError && caught.status === 503) {
        setDisabled(DISABLED_MESSAGE);
        setData(undefined);
        setCommits([]);
        onCount?.(undefined);
        return false;
      }
      setError(errorMessage(caught));
      return false;
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  };

  const load = async (requestRepo: string | undefined): Promise<void> => {
    clearCommitNote();
    const ok = await loadStatus(requestRepo);
    if (ok) await loadLog(requestRepo);
  };

  // Muat saat tab dibuka, saat refresh ditekan, saat repo berganti, dan saat
  // sesi berganti. Perubahan event memakai debounce 600 ms seperti tab lain.
  useEffect(() => {
    if (!open) return;
    const forced = refreshToken !== tokenRef.current;
    const repoChanged = repoRef.current !== repo;
    repoRef.current = repo;
    if (repoChanged) {
      setData(undefined);
      setCommits([]);
      setExpanded(undefined);
      setShows({});
      setDisabled(undefined);
      setWriteDisabled(false);
      setActionError(undefined);
      setCommitError(undefined);
      tokenRef.current = refreshToken;
      markerRef.current = { eventCount, status, refreshToken };
      void load(repo);
      return;
    }
    const marker: GitMarker = { eventCount, status, refreshToken };
    if (!forced && !shouldRefreshGit({ open, eventCount, status, refreshToken }, markerRef.current)) {
      return;
    }
    const run = (): void => {
      tokenRef.current = refreshToken;
      markerRef.current = marker;
      void load(repo);
    };
    if (forced || markerRef.current === undefined) {
      run();
      return;
    }
    const timer = setTimeout(run, 600);
    return () => clearTimeout(timer);
    // load stabil secara perilaku; deps sengaja dibatasi pemicu perubahan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId, status, eventCount, refreshToken, repo]);

  // Kembalikan fokus ke tombol commit setelah ringkasan sukses muncul.
  useEffect(() => {
    if (commitNote !== undefined) commitButtonRef.current?.focus();
  }, [commitNote]);

  const refresh = async (): Promise<void> => {
    await load(activeRepo);
  };

  const onWriteError = (caught: unknown, fallback: string): void => {
    if (caught instanceof ApiError && caught.status === 503) {
      setDisabled(DISABLED_MESSAGE);
      setData(undefined);
      setCommits([]);
      onCount?.(undefined);
      return;
    }
    if (caught instanceof ApiError && caught.status === 403) {
      setWriteDisabled(true);
      setActionError(WRITE_DISABLED_MESSAGE);
      return;
    }
    setActionError(caught instanceof ApiError ? caught.message : fallback);
  };

  const runBatch = async (group: GitGroup, all: boolean): Promise<void> => {
    if (busy !== undefined || commitBusy) return;
    const key = `batch:${group.id}`;
    setBusy(key);
    setActionError(undefined);
    clearCommitNote();
    try {
      const input =
        all || group.id !== "untracked"
          ? { all: true, ...(activeRepo !== undefined ? { repo: activeRepo } : {}) }
          : {
              paths: group.files.slice(0, MAX_BATCH_PATHS).map((file) => file.path),
              ...(activeRepo !== undefined ? { repo: activeRepo } : {}),
            };
      if (group.id === "staged") await api.gitUnstage(sessionId, input);
      else await api.gitStage(sessionId, input);
      await loadStatus(activeRepo);
    } catch (caught) {
      onWriteError(caught, "Aksi git gagal dijalankan.");
    } finally {
      setBusy(undefined);
    }
  };

  const toggleFile = async (group: GitGroup, file: GitGroupFile): Promise<void> => {
    if (busy !== undefined || commitBusy) return;
    const key = `${group.id}:${file.path}`;
    setBusy(key);
    setActionError(undefined);
    clearCommitNote();
    try {
      const input = {
        paths: [file.path],
        ...(activeRepo !== undefined ? { repo: activeRepo } : {}),
      };
      if (group.id === "staged") await api.gitUnstage(sessionId, input);
      else await api.gitStage(sessionId, input);
      await loadStatus(activeRepo);
    } catch (caught) {
      onWriteError(caught, "Aksi git gagal dijalankan.");
    } finally {
      setBusy(undefined);
    }
  };

  const submitCommit = async (): Promise<void> => {
    if (commitBusy || busy !== undefined) return;
    const check = validateMessage(draft);
    if (!check.ok) {
      setCommitError(check.error ?? "Pesan commit tidak valid.");
      return;
    }
    if (data === undefined || data.staged.length === 0) return;
    setCommitBusy(true);
    setCommitError(undefined);
    setActionError(undefined);
    clearCommitNote();
    try {
      const result = await api.gitCommit(sessionId, draft.trim(), activeRepo);
      onDraftChange("");
      setExpanded(undefined);
      setShows({});
      setCommitNote(`Commit ${result.short}: ${commitSubject(result.subject)}`);
      if (noteTimerRef.current !== undefined) clearTimeout(noteTimerRef.current);
      noteTimerRef.current = setTimeout(() => {
        noteTimerRef.current = undefined;
        setCommitNote(undefined);
      }, COMMIT_NOTE_MS);
      await loadStatus(activeRepo);
      await loadLog(activeRepo);
      onChanged?.();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 503) {
        setDisabled(DISABLED_MESSAGE);
        setData(undefined);
        setCommits([]);
        onCount?.(undefined);
      } else if (caught instanceof ApiError && caught.status === 403) {
        setWriteDisabled(true);
      }
      setCommitError(caught instanceof ApiError ? caught.message : "commit tidak dapat dijalankan");
    } finally {
      setCommitBusy(false);
    }
  };

  const toggleShow = async (commit: GitCommit): Promise<void> => {
    if (expanded === commit.hash) {
      setExpanded(undefined);
      return;
    }
    setExpanded(commit.hash);
    const existing = shows[commit.hash];
    if (existing?.text !== undefined && existing.error === undefined) return;
    showRef.current += 1;
    const ticket = showRef.current;
    setShows((current) => ({ ...current, [commit.hash]: { loading: true } }));
    try {
      const payload = await api.gitShow(sessionId, commit.hash, activeRepo);
      if (ticket !== showRef.current) return;
      setShows((current) => ({
        ...current,
        [commit.hash]: { loading: false, text: payload.text, truncated: payload.truncated },
      }));
    } catch (caught) {
      if (ticket !== showRef.current) return;
      setShows((current) => ({
        ...current,
        [commit.hash]: {
          loading: false,
          error: caught instanceof ApiError ? caught.message : "commit tidak dapat dimuat",
        },
      }));
    }
  };

  const permission = canWrite({
    status,
    state: data?.state ?? "normal",
    writeDisabled,
  });
  const groups = data === undefined ? [] : groupStatus(data);
  const stagedCount = data?.staged.length ?? 0;
  const messageCheck = validateMessage(draft);
  const commitEnabled =
    permission.allowed &&
    stagedCount > 0 &&
    messageCheck.ok &&
    !commitBusy &&
    busy === undefined;
  const isRepo = data?.isRepo === true;
  const branch = data === undefined ? undefined : branchLabel(data);
  const aheadBehind = data === undefined ? "" : aheadBehindLabel(data);
  const state = data === undefined ? undefined : stateLabel(data.state);

  return (
    <div class="jk-panel-body">
      {session?.worktree !== undefined && (
        <WorktreeBox api={api} session={session} onChanged={onSessionChanged} />
      )}
      {disabled !== undefined && <p class="jk-panel-note">{disabled}</p>}

      {disabled === undefined && (
        <>
          {loading && data === undefined && <p class="jk-panel-note">Memuat…</p>}

          {error !== undefined && (
            <div class="jk-panel-error">
              <p class="jk-error-line" role="alert">
                {error}
              </p>
              <button type="button" class="jk-link-btn" onClick={() => void refresh()}>
                Coba lagi
              </button>
            </div>
          )}

          {data !== undefined && !isRepo && (
            <p class="jk-panel-note">Folder ini bukan repo git.</p>
          )}

          {data !== undefined && isRepo && (
            <>
              <div class="jk-git-head">
                <span class="jk-git-branch" title={branch}>
                  <Icon name="cube" />
                  <code>{branch}</code>
                </span>
                {aheadBehind !== "" && <span class="jk-git-ab">{aheadBehind}</span>}
                {state !== undefined && <span class="jk-git-state">{state}</span>}
                <button
                  type="button"
                  class="jk-icon-btn jk-git-refresh"
                  aria-label="Muat ulang panel git"
                  disabled={loading}
                  onClick={() => void refresh()}
                >
                  <Icon name="refresh" />
                </button>
              </div>

              {state !== undefined && (
                <p class="jk-panel-note">Sedang ada {state}; selesaikan di terminal.</p>
              )}
              {!permission.allowed && permission.reason !== undefined && (
                <p class="jk-panel-note" role="status">
                  {permission.reason}
                </p>
              )}
              {data.head === undefined && <p class="jk-panel-note">Belum ada commit.</p>}

              {actionError !== undefined && (
                <p class="jk-error-line" role="alert">
                  {actionError}
                </p>
              )}

              {groups.map((group) => (
                <section class="jk-git-section" key={group.id} aria-label={group.title}>
                  <div class="jk-git-section-head">
                    <h3 class="jk-git-section-title">
                      {group.title}
                      {group.count > 0 && (
                        <span class="jk-panel-count">{formatCount(group.count)}</span>
                      )}
                    </h3>
                    {group.id === "staged" && group.count > 0 && (
                      <button
                        type="button"
                        class="jk-link-btn"
                        disabled={!permission.allowed || busy !== undefined || commitBusy}
                        title={permission.reason}
                        aria-label="Unstage semua"
                        onClick={() => void runBatch(group, true)}
                      >
                        {busy === `batch:${group.id}` ? "Memproses…" : "Unstage semua"}
                      </button>
                    )}
                    {group.id === "unstaged" && group.count > 0 && (
                      <button
                        type="button"
                        class="jk-link-btn"
                        disabled={!permission.allowed || busy !== undefined || commitBusy}
                        title={permission.reason}
                        aria-label="Stage semua"
                        onClick={() => void runBatch(group, true)}
                      >
                        {busy === `batch:${group.id}` ? "Memproses…" : "Stage semua"}
                      </button>
                    )}
                    {group.id === "untracked" &&
                      group.count > 0 &&
                      group.count <= MAX_BATCH_PATHS && (
                        <button
                          type="button"
                          class="jk-link-btn"
                          disabled={!permission.allowed || busy !== undefined || commitBusy}
                          title={permission.reason}
                          aria-label="Stage semua tak terlacak"
                          onClick={() => void runBatch(group, false)}
                        >
                          {busy === `batch:${group.id}` ? "Memproses…" : "Stage semua"}
                        </button>
                      )}
                  </div>

                  {group.count === 0 ? (
                    <p class="jk-panel-note">Tidak ada berkas.</p>
                  ) : (
                    <div class="jk-git-list">
                      {group.files.map((file) => {
                        const key = `${group.id}:${file.path}`;
                        const checked = group.id === "staged";
                        return (
                          <div class="jk-git-row" key={key}>
                            <input
                              type="checkbox"
                              class="jk-git-check"
                              checked={checked}
                              disabled={!permission.allowed || busy !== undefined || commitBusy}
                              aria-label={
                                checked ? `Unstage ${file.path}` : `Stage ${file.path}`
                              }
                              title={permission.reason}
                              onChange={() => void toggleFile(group, file)}
                            />
                            <span
                              class={`jk-git-status${file.conflict ? " jk-bad" : ""}`}
                              title={file.label}
                              aria-label={file.label}
                            >
                              {file.short}
                            </span>
                            <button
                              type="button"
                              class="jk-link-btn jk-git-path"
                              title={`Lihat perubahan ${file.path}`}
                              aria-label={`Lihat perubahan ${file.path}`}
                              onClick={onOpenChanges}
                            >
                              {file.path}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              ))}

              <div class="jk-git-commit">
                <label class="jk-visually-hidden" for="jk-git-message">
                  Pesan commit
                </label>
                <textarea
                  id="jk-git-message"
                  class="jk-editor jk-git-message"
                  aria-label="Pesan commit"
                  placeholder="Pesan commit"
                  maxLength={2000}
                  value={draft}
                  disabled={commitBusy}
                  onInput={(event) => {
                    onDraftChange((event.currentTarget as HTMLTextAreaElement).value);
                    setCommitError(undefined);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      if (commitEnabled) void submitCommit();
                    }
                  }}
                />
                <div class="jk-git-commit-meta">
                  <span class="jk-git-counter">
                    {formatCount(draft.length)}/{formatCount(2000)}
                  </span>
                  <button
                    ref={commitButtonRef}
                    type="button"
                    class="jk-button jk-button-primary jk-git-commit-btn"
                    disabled={!commitEnabled}
                    onClick={() => void submitCommit()}
                  >
                    {commitBusy
                      ? "Meng-commit…"
                      : `Commit (${formatCount(stagedCount)} berkas)`}
                  </button>
                </div>
                {commitError !== undefined && (
                  <p class="jk-error-line" role="alert">
                    {commitError}
                  </p>
                )}
                {commitNote !== undefined && (
                  <p class="jk-saved-mark" role="status">
                    {commitNote}
                  </p>
                )}
              </div>

              <section class="jk-git-section" aria-label="Riwayat commit">
                <div class="jk-git-section-head">
                  <h3 class="jk-git-section-title">Riwayat</h3>
                </div>
                {commits.length === 0 ? (
                  <p class="jk-panel-note">Belum ada commit.</p>
                ) : (
                  <div class="jk-git-log">
                    {commits.map((commit) => {
                      const isOpen = expanded === commit.hash;
                      const show = shows[commit.hash];
                      return (
                        <div class="jk-git-commit-row" key={commit.hash}>
                          <button
                            type="button"
                            class="jk-git-log-row"
                            aria-expanded={isOpen}
                            aria-label={`Lihat commit ${commit.short}: ${commit.subject}`}
                            onClick={() => void toggleShow(commit)}
                          >
                            <code class="jk-git-hash">{commit.short}</code>
                            <span class="jk-git-subject">{commit.subject}</span>
                            <span class="jk-git-author">{commit.author}</span>
                            <span class="jk-git-time">{relativeTime(commit.date, now)}</span>
                          </button>
                          {isOpen && (
                            <div class="jk-git-show">
                              {show?.loading === true && <p class="jk-panel-note">Memuat…</p>}
                              {show?.error !== undefined && (
                                <p class="jk-error-line" role="alert">
                                  {show.error}
                                </p>
                              )}
                              {show?.text !== undefined && (
                                <>
                                  <div class="jk-git-show-head">
                                    <CopyButton
                                      text={show.text}
                                      label={`Salin keluaran commit ${commit.short}`}
                                    />
                                  </div>
                                  <pre
                                    class="jk-panel-code jk-git-show-text"
                                    tabIndex={0}
                                    aria-label={`Keluaran commit ${commit.short}`}
                                  >
                                    {show.text}
                                  </pre>
                                  {show.truncated === true && (
                                    <p class="jk-panel-note">Keluaran dipotong.</p>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {data.truncated && (
                <p class="jk-panel-note">
                  Daftar dipotong; hanya sebagian perubahan yang ditampilkan.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
