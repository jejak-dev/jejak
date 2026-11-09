import { useEffect, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import type { WorktreeInspect } from "../../server/git/worktree-service";
import { ApiError, type ApiClient, type WorktreeView } from "../lib/api";
import { formatCount } from "../lib/format";
import { mergeCommands, removeConfirmText } from "../lib/worktree";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icon";

export interface WorktreeBoxProps {
  api: ApiClient;
  session: SessionInfo;
  /** Dipanggil setelah hapus/pulihkan agar daftar sesi dimuat ulang. */
  onChanged?: () => void;
}

const DISABLED_MESSAGE = "Worktree dimatikan.";

function statusLabel(worktree: WorktreeView["worktree"]): { label: string; tone: "" | "warn" | "bad" } {
  if (worktree.removed === true) return { label: "dihapus", tone: "bad" };
  if (worktree.missing === true) return { label: "folder hilang", tone: "warn" };
  return { label: "aktif", tone: "" };
}

export function WorktreeBox({ api, session, onChanged }: WorktreeBoxProps) {
  const sessionId = session.id;
  const worktree = session.worktree;
  const [view, setView] = useState<WorktreeView | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [disabled, setDisabled] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState<{ dirtyFiles: number; commitsAhead: number } | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);

  const requestRef = useRef(0);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const load = async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const payload = await api.getWorktree(sessionId);
      if (ticket !== requestRef.current) return;
      setView(payload);
      setDisabled(undefined);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      if (caught instanceof ApiError && caught.status === 503) {
        setDisabled(DISABLED_MESSAGE);
        setView(undefined);
        return;
      }
      setError(caught instanceof ApiError ? caught.message : "worktree tidak dapat dimuat");
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  };

  // Tanpa polling: muat saat kotak dibuka (session berganti) dan setelah aksi.
  useEffect(() => {
    if (worktree === undefined) return;
    setView(undefined);
    setConfirming(false);
    setConflict(undefined);
    void load();
    // load stabil secara perilaku; deps sengaja dibatasi identitas sesi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  if (worktree === undefined) return null;

  const inspect: WorktreeInspect | undefined = view?.inspect;
  const status = statusLabel(view?.worktree ?? worktree);
  const running = session.status === "berjalan";
  const removed = (view?.worktree ?? worktree).removed === true;
  const missing = (view?.worktree ?? worktree).missing === true;
  const deleteReason = running
    ? "Sesi sedang berjalan; tunggu selesai."
    : removed
      ? "Worktree sudah dihapus."
      : inspect === undefined
        ? "Menunggu status worktree…"
        : undefined;
  const canDelete = !busy && deleteReason === undefined;

  const refreshAfterAction = async (): Promise<void> => {
    await load();
    onChanged?.();
  };

  const remove = async (force: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setConflict(undefined);
    try {
      await api.removeWorktree(sessionId, force ? { force: true } : undefined);
      setConfirming(false);
      setConflict(undefined);
      await refreshAfterAction();
    } catch (caught) {
      if (!force && caught instanceof ApiError && caught.status === 409) {
        const dirtyFiles = caught.details?.dirtyFiles;
        const commitsAhead = caught.details?.commitsAhead;
        if (dirtyFiles !== undefined && commitsAhead !== undefined) {
          setConflict({ dirtyFiles, commitsAhead });
          setConfirming(false);
          return;
        }
      }
      setError(caught instanceof ApiError ? caught.message : "worktree gagal dihapus");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.restoreWorktree(sessionId);
      await refreshAfterAction();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "worktree gagal dipulihkan");
    } finally {
      setBusy(false);
    }
  };

  const branch = (view?.worktree ?? worktree).branch;
  const path = (view?.worktree ?? worktree).path;
  const base = (view?.worktree ?? worktree).baseCommit.slice(0, 7);
  const commands = mergeCommands({
    repoRoot: (view?.worktree ?? worktree).repoRoot,
    branch,
    baseCommit: (view?.worktree ?? worktree).baseCommit,
  }).join("\n");

  return (
    <section class="jk-worktree-box" aria-label="Worktree sesi">
      <div class="jk-worktree-head">
        <Icon name="branch" />
        <code class="jk-worktree-branch" title={branch}>
          {branch}
        </code>
        <span class={`jk-worktree-status${status.tone === "" ? "" : ` jk-worktree-${status.tone}`}`}>
          {status.label}
        </span>
      </div>

      <p class="jk-panel-note jk-worktree-meta">
        dari <code>{base}</code> · <span class="jk-mono" title={path}>{path}</span>
      </p>

      {disabled !== undefined ? (
        <p class="jk-panel-note">{disabled}</p>
      ) : (
        <>
          {loading && view === undefined && <p class="jk-panel-note">Memuat…</p>}

          {view !== undefined && (
            <p class="jk-panel-note">
              {formatCount(inspect?.dirtyFiles ?? 0)} berkas berubah ·{" "}
              {formatCount(inspect?.commitsAhead ?? 0)} commit di depan
              {inspect?.branchExists === false && " · cabang tidak ditemukan"}
            </p>
          )}

          {error !== undefined && (
            <p class="jk-error-line" role="alert">
              {error}
            </p>
          )}

          <div class="jk-worktree-cmd">
            <CopyButton text={commands} label="Salin perintah merge" />
            <p class="jk-panel-note">
              Penggabungan dilakukan sendiri di terminal; cabang jejak/… tetap ada.
            </p>
          </div>

          {conflict !== undefined ? (
            <div class="jk-panel-confirm">
              <p>
                Worktree masih punya {formatCount(conflict.dirtyFiles)} berkas berubah dan{" "}
                {formatCount(conflict.commitsAhead)} commit belum digabung. Hapus paksa akan
                menghilangkan perubahan yang belum di-commit.
              </p>
              <div class="jk-panel-confirm-actions">
                <button
                  type="button"
                  class="jk-button jk-button-caution"
                  disabled={busy}
                  onClick={() => void remove(true)}
                >
                  {busy ? "Menghapus…" : "Hapus paksa"}
                </button>
                <button
                  type="button"
                  class="jk-button"
                  disabled={busy}
                  onClick={() => setConflict(undefined)}
                >
                  Batal
                </button>
              </div>
            </div>
          ) : confirming ? (
            <div class="jk-panel-confirm">
              <p>{inspect === undefined ? "Hapus folder worktree?" : removeConfirmText(inspect)}</p>
              <div class="jk-panel-confirm-actions">
                <button
                  type="button"
                  class="jk-button jk-button-caution"
                  disabled={busy}
                  onClick={() => void remove(false)}
                >
                  {busy ? "Menghapus…" : "Ya, hapus"}
                </button>
                <button
                  ref={cancelRef}
                  type="button"
                  class="jk-button"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  Batal
                </button>
              </div>
            </div>
          ) : (
            <div class="jk-worktree-actions">
              <button
                type="button"
                class="jk-link-btn jk-worktree-danger"
                disabled={!canDelete}
                title={deleteReason}
                onClick={() => setConfirming(true)}
              >
                Hapus worktree
              </button>
              {(missing || removed) && (
                <button
                  type="button"
                  class="jk-link-btn"
                  disabled={busy}
                  onClick={() => void restore()}
                >
                  {busy ? "Memulihkan…" : "Pulihkan worktree"}
                </button>
              )}
              <button
                type="button"
                class="jk-link-btn"
                disabled={loading}
                onClick={() => void load()}
              >
                {loading ? "Memuat…" : "Muat ulang"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
