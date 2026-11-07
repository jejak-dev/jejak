import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type Changes, type ChangedFile } from "../lib/api";
import { diffRows, shouldRefreshChanges, statusLabel, totalStats, type ChangesMarker } from "../lib/files";
import { formatCount } from "../lib/format";
import { Icon } from "./Icon";

export interface ChangesTabProps {
  api: ApiClient;
  sessionId: string;
  open: boolean;
  eventCount: number;
  status: string;
  refreshToken: number;
  /** Jumlah berkas untuk lencana angka di tab; undefined saat belum diketahui. */
  onFileCount?: (count: number | undefined) => void;
}

function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "perubahan tidak dapat dimuat";
}

function FileRow({ file }: { file: ChangedFile }) {
  const slash = file.path.lastIndexOf("/");
  const dir = slash > 0 ? file.path.slice(0, slash) : "";
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const unchanged = !file.binary && file.hunks.length === 0;

  return (
    <details class="jk-panel-file" data-path={file.path}>
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
          file.hunks.map((hunk, hunkIndex) => (
            <div class="jk-panel-hunk" key={hunkIndex}>
              <p class="jk-panel-hunk-head">{hunk.header}</p>
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
          ))
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
  onFileCount,
}: ChangesTabProps) {
  const [data, setData] = useState<Changes | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const markerRef = useRef<ChangesMarker | undefined>(undefined);
  const tokenRef = useRef(0);

  const load = async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const payload = await api.getChanges(sessionId);
      if (ticket !== requestRef.current) return;
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
  useEffect(() => {
    if (!open) return;
    const forced = refreshToken !== tokenRef.current;
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
  }, [open, sessionId, status, eventCount, refreshToken]);

  const stats = data === undefined ? undefined : totalStats(data.files);

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
            <p class="jk-panel-note">Belum ada perubahan di folder kerja.</p>
          ) : (
            <>
              <p class="jk-panel-summary">
                {formatCount(data.files.length)} berkas
                {stats !== undefined && (
                  <>
                    {" · "}
                    <span class="jk-ok">+{formatCount(stats.additions)}</span>{" "}
                    <span class="jk-bad">−{formatCount(stats.deletions)}</span>
                  </>
                )}
              </p>
              <div class="jk-panel-list">
                {data.files.map((file) => (
                  <FileRow file={file} key={file.path} />
                ))}
              </div>
              {data.truncated && (
                <p class="jk-panel-note">Daftar dipotong; hanya sebagian perubahan yang ditampilkan.</p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
