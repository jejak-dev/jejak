import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type Changes, type ChangedFile } from "../lib/api";
import {
  canReject,
  diffRows,
  nextOpenPaths,
  pushUndoLine,
  rejectBlockedReason,
  rejectConfirmContent,
  rejectTargetKey,
  removeUndoLine,
  shouldRefreshChanges,
  statusLabel,
  totalStats,
  updateUndoLine,
  type ChangesMarker,
  type RejectTarget,
  type UndoLine,
} from "../lib/files";
import { formatCount } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";

export interface ChangesTabProps {
  api: ApiClient;
  sessionId: string;
  open: boolean;
  eventCount: number;
  status: string;
  refreshToken: number;
  /** Nama repo workspace; undefined berarti repo utama (cwd sesi). */
  repo?: string;
  /** Jumlah berkas untuk lencana angka di tab; undefined saat belum diketahui. */
  onFileCount?: (count: number | undefined) => void;
}

interface RejectFailure {
  message: string;
  stale: boolean;
}

function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "perubahan tidak dapat dimuat";
}

function failureOf(caught: unknown, fallback: string): RejectFailure {
  if (caught instanceof ApiError) {
    return { message: caught.message, stale: caught.status === 409 };
  }
  return { message: fallback, stale: false };
}

interface RejectErrorLineProps {
  failure: RejectFailure;
  path: string;
  onRefresh: () => void;
}

function RejectErrorLine({ failure, path, onRefresh }: RejectErrorLineProps) {
  return (
    <div class="jk-panel-reject-error">
      <p class="jk-perm-error" role="alert">
        {failure.message}
      </p>
      {failure.stale && (
        <button
          type="button"
          class="jk-link-btn"
          aria-label={`Muat ulang perubahan setelah gagal menolak ${path}`}
          onClick={onRefresh}
        >
          Muat ulang perubahan
        </button>
      )}
    </div>
  );
}

interface FileRowProps {
  file: ChangedFile;
  sessionStatus: string;
  open: boolean;
  onToggleOpen: (path: string, open: boolean) => void;
  busyKey: string | undefined;
  failures: Record<string, RejectFailure | undefined>;
  onAsk: (target: RejectTarget) => void;
  onRefresh: () => void;
}

function FileRow({
  file,
  sessionStatus,
  open,
  onToggleOpen,
  busyKey,
  failures,
  onAsk,
  onRefresh,
}: FileRowProps) {
  const slash = file.path.lastIndexOf("/");
  const dir = slash > 0 ? file.path.slice(0, slash) : "";
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const unchanged = !file.binary && file.hunks.length === 0;
  const rejectable = canReject(file);
  const blocked = rejectable ? rejectBlockedReason({ sessionStatus, file }) : undefined;
  const rejectDisabled = blocked !== undefined || busyKey !== undefined;
  const fileKey = file.path;
  const fileTarget: RejectTarget = { path: file.path, scope: "file" };
  const fileFailure = failures[fileKey];

  return (
    <details
      class="jk-panel-file"
      data-path={file.path}
      open={open}
      onToggle={(event) => onToggleOpen(file.path, event.currentTarget.open)}
    >
      <summary>
        <span class="jk-chev">
          <Icon name="chevron" />
        </span>
        <span class="jk-panel-status" title={statusLabel(file.status)} aria-label={statusLabel(file.status)}>
          {file.status}
        </span>
        <span class="jk-panel-path">
          {dir !== "" && <span class="jk-panel-dir">{dir}/</span>}
          <span class="jk-panel-name">{name}</span>
        </span>
        <span class="jk-panel-stats">
          <span class="jk-ok">+{formatCount(file.additions)}</span>{" "}
          <span class="jk-bad">−{formatCount(file.deletions)}</span>
        </span>
      </summary>
      <div class="jk-panel-file-body">
        {file.binary ? (
          <p class="jk-panel-note">Berkas biner</p>
        ) : unchanged ? (
          <p class="jk-panel-note">Tidak ada perubahan yang bisa ditampilkan</p>
        ) : (
          <>
            {rejectable && (
              <>
                {blocked !== undefined && <p class="jk-panel-note">{blocked}</p>}
                <button
                  type="button"
                  class="jk-link-btn jk-panel-reject jk-panel-reject-all"
                  disabled={rejectDisabled}
                  title={blocked}
                  aria-label={`Tolak seluruh berkas ${file.path}`}
                  onClick={() => onAsk(fileTarget)}
                >
                  Tolak seluruh berkas
                </button>
                {fileFailure !== undefined && (
                  <RejectErrorLine failure={fileFailure} path={file.path} onRefresh={onRefresh} />
                )}
              </>
            )}
            {file.hunks.map((hunk, hunkIndex) => {
              const target: RejectTarget = { path: file.path, scope: "hunk", hunkId: hunk.id };
              const key = rejectTargetKey(target) ?? "";
              const failure = failures[key];
              return (
                <div class="jk-panel-hunk" key={hunk.id}>
                  <div class="jk-panel-hunk-head">
                    <span class="jk-panel-hunk-header">{hunk.header}</span>
                    {rejectable && (
                      <button
                        type="button"
                        class="jk-link-btn jk-panel-reject"
                        disabled={rejectDisabled}
                        title={blocked}
                        aria-label={`Tolak hunk ${hunkIndex + 1} di ${file.path}`}
                        onClick={() => onAsk(target)}
                      >
                        Tolak
                      </button>
                    )}
                  </div>
                  {failure !== undefined && (
                    <RejectErrorLine failure={failure} path={file.path} onRefresh={onRefresh} />
                  )}
                  <div class="jk-panel-diff" tabIndex={0} role="region" aria-label={`Perubahan ${file.path}`}>
                    {diffRows(hunk).map((row, rowIndex) => (
                      <div class={`jk-panel-dline${row.t === "ctx" ? "" : ` jk-perm-${row.t === "add" ? "add" : "del"}`}`} key={rowIndex}>
                        <i>{row.oldNo ?? ""}</i>
                        <i>{row.newNo ?? ""}</i>
                        <span>{row.text === "" ? " " : row.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </details>
  );
}

export function ChangesTab({
  api,
  sessionId,
  open,
  eventCount,
  status,
  refreshToken,
  repo,
  onFileCount,
}: ChangesTabProps) {
  const [data, setData] = useState<Changes | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [openPaths, setOpenPaths] = useState<Set<string>>(() => new Set());
  const [confirmTarget, setConfirmTarget] = useState<RejectTarget | undefined>(undefined);
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined);
  const [failures, setFailures] = useState<Record<string, RejectFailure | undefined>>({});
  const [undoLines, setUndoLines] = useState<UndoLine[]>([]);
  const [undoBusy, setUndoBusy] = useState<string | undefined>(undefined);

  const requestRef = useRef(0);
  const markerRef = useRef<ChangesMarker | undefined>(undefined);
  const tokenRef = useRef(0);
  /** Repo milik daftar yang sedang ditampilkan; tolak/urungkan memakai nilai ini. */
  const dataRepoRef = useRef<string | undefined>(undefined);
  const repoRef = useRef(repo);
  const summaryRef = useRef<HTMLParagraphElement | null>(null);
  const emptyRef = useRef<HTMLParagraphElement | null>(null);
  const undoRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const pendingFocusRef = useRef<{ undoId?: string } | undefined>(undefined);

  const load = async (requestRepo: string | undefined = repo): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setError(undefined);
    setFailures({});
    try {
      const payload = await api.getChanges(sessionId, requestRepo);
      if (ticket !== requestRef.current) return;
      dataRepoRef.current = requestRepo;
      setData(payload);
      onFileCount?.(payload.isRepo ? payload.files.length : undefined);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setError(errorMessage(caught));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  };

  // Muat saat tab dibuka, saat refresh ditekan, dan saat sesi berubah (debounce 600 ms).
  // Repo berganti: kosongkan konfirmasi tolak/urungkan dan muat ulang segera.
  useEffect(() => {
    if (!open) return;
    const forced = refreshToken !== tokenRef.current;
    const repoChanged = repoRef.current !== repo;
    repoRef.current = repo;
    if (repoChanged) {
      setConfirmTarget(undefined);
      setUndoLines([]);
      setOpenPaths(new Set());
      setData(undefined);
      tokenRef.current = refreshToken;
      markerRef.current = { status, eventCount };
      void load();
      return;
    }
    if (
      !forced &&
      !shouldRefreshChanges({ open, tab: "changes", status, eventCount }, markerRef.current)
    ) {
      return;
    }
    const run = (): void => {
      tokenRef.current = refreshToken;
      markerRef.current = { status, eventCount };
      void load();
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

  // Kembalikan fokus setelah muat ulang: ke baris urung baru atau ke ringkasan.
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending === undefined) return;
    pendingFocusRef.current = undefined;
    if (pending.undoId !== undefined) {
      undoRefs.current[pending.undoId]?.focus();
      return;
    }
    (summaryRef.current ?? emptyRef.current)?.focus();
  }, [data, undoLines]);

  const setFileOpen = (path: string, isOpen: boolean): void => {
    setOpenPaths((paths) => nextOpenPaths(paths, path, isOpen));
  };

  const cancelReject = (): void => {
    setConfirmTarget(undefined);
  };

  const submitReject = async (target: RejectTarget): Promise<void> => {
    if (busyKey !== undefined) return;
    const file = data?.files.find((item) => item.path === target.path);
    const key = rejectTargetKey(target);
    if (file === undefined || key === undefined) return;
    if (target.scope === "hunk" && target.hunkId === undefined) return;

    setBusyKey(key);
    const activeRepo = dataRepoRef.current;
    try {
      const result = await api.rejectChange(sessionId, {
        path: target.path,
        scope: target.scope,
        ...(target.hunkId !== undefined ? { hunkId: target.hunkId } : {}),
        diffId: file.diffId,
        ...(activeRepo !== undefined ? { repo: activeRepo } : {}),
      });
      setConfirmTarget(undefined);
      if (repoRef.current === activeRepo) {
        setUndoLines((lines) => pushUndoLine(lines, { undoId: result.undoId, path: result.path }));
        pendingFocusRef.current = { undoId: result.undoId };
        await load(activeRepo);
      }
    } catch (caught) {
      setConfirmTarget(undefined);
      const failure = failureOf(caught, "Gagal menolak perubahan.");
      setFailures((current) => ({ ...current, [key]: failure }));
    } finally {
      setBusyKey(undefined);
    }
  };

  const submitUndo = async (line: UndoLine): Promise<void> => {
    if (undoBusy !== undefined) return;
    const activeRepo = dataRepoRef.current;
    setUndoBusy(line.undoId);
    try {
      await api.undoChange(sessionId, line.undoId, activeRepo);
      setUndoLines((lines) => removeUndoLine(lines, line.undoId));
      pendingFocusRef.current = {};
      if (repoRef.current === activeRepo) await load(activeRepo);
    } catch (caught) {
      const failure = failureOf(caught, "Gagal mengurungkan perubahan.");
      setUndoLines((lines) => updateUndoLine(lines, line.undoId, { error: failure.message }));
    } finally {
      setUndoBusy(undefined);
    }
  };

  const closeUndoLine = (undoId: string): void => {
    setUndoLines((lines) => removeUndoLine(lines, undoId));
    pendingFocusRef.current = {};
  };

  const stats = data === undefined ? undefined : totalStats(data.files);
  /** Isi modal konfirmasi tolak untuk target yang sedang dikonfirmasi. */
  const confirmContent = rejectConfirmContent(confirmTarget, data?.files ?? []);

  const undoBlock =
    undoLines.length === 0 ? null : (
      <ul class="jk-panel-undo-list">
        {undoLines.map((line) => (
          <li
            key={line.undoId}
            ref={(element) => {
              if (element === null) delete undoRefs.current[line.undoId];
              else undoRefs.current[line.undoId] = element;
            }}
            class="jk-panel-undo"
            tabIndex={-1}
            role="status"
            aria-label={`Penolakan ${line.path}`}
          >
            <span>
              Perubahan di <code>{line.path}</code> ditolak.
            </span>
            {line.error !== undefined ? (
              <>
                <span class="jk-perm-error" role="alert">
                  {line.error}
                </span>
                <button
                  type="button"
                  class="jk-link-btn"
                  aria-label={`Tutup pemberitahuan penolakan ${line.path}`}
                  onClick={() => closeUndoLine(line.undoId)}
                >
                  Tutup
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  class="jk-link-btn"
                  disabled={undoBusy !== undefined}
                  aria-label={`Urungkan penolakan ${line.path}`}
                  onClick={() => void submitUndo(line)}
                >
                  {undoBusy === line.undoId ? "Mengurungkan…" : "Urungkan"}
                </button>
                <button
                  type="button"
                  class="jk-link-btn"
                  disabled={undoBusy !== undefined}
                  aria-label={`Tutup pemberitahuan penolakan ${line.path}`}
                  onClick={() => closeUndoLine(line.undoId)}
                >
                  Tutup
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <div class="jk-panel-body">
      {loading && data === undefined && <p class="jk-panel-note">Memuat…</p>}

      {error !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {error}
          </p>
          <button type="button" class="jk-link-btn" onClick={() => void load()}>
            Coba lagi
          </button>
        </div>
      )}

      {data !== undefined && !data.isRepo && (
        <p class="jk-panel-note">Folder ini bukan repo git, jadi perubahan tidak bisa ditampilkan.</p>
      )}

      {data !== undefined && data.isRepo && (
        <>
          {data.files.length === 0 ? (
            <>
              <p ref={emptyRef} tabIndex={-1} class="jk-panel-note">
                Belum ada perubahan di folder kerja.
              </p>
              {undoBlock}
            </>
          ) : (
            <>
              <p ref={summaryRef} tabIndex={-1} class="jk-panel-summary">
                {formatCount(data.files.length)} berkas
                {stats !== undefined && (
                  <>
                    {" · "}
                    <span class="jk-ok">+{formatCount(stats.additions)}</span>{" "}
                    <span class="jk-bad">−{formatCount(stats.deletions)}</span>
                  </>
                )}
              </p>
              {undoBlock}
              <div class="jk-panel-list">
                {data.files.map((file) => (
                  <FileRow
                    file={file}
                    key={file.path}
                    sessionStatus={status}
                    open={openPaths.has(file.path)}
                    onToggleOpen={setFileOpen}
                    busyKey={busyKey}
                    failures={failures}
                    onAsk={setConfirmTarget}
                    onRefresh={() => void load()}
                  />
                ))}
              </div>
              {data.truncated && (
                <p class="jk-panel-note">Daftar dipotong; hanya sebagian perubahan yang ditampilkan.</p>
              )}
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmTarget !== undefined}
        title={confirmContent?.title ?? "Tolak perubahan?"}
        message={confirmContent?.message}
        confirmLabel={confirmContent?.confirmLabel ?? "Tolak"}
        busyLabel="Menolak…"
        tone="danger"
        busy={busyKey !== undefined}
        confirmAriaLabel={confirmContent?.confirmAriaLabel}
        cancelAriaLabel={confirmContent?.cancelAriaLabel}
        onConfirm={() => {
          if (confirmTarget !== undefined) void submitReject(confirmTarget);
        }}
        onCancel={cancelReject}
      />
    </div>
  );
}
