import { useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ApiClient,
  type CheckpointItem,
  type CheckpointList,
  type CheckpointPreview,
} from "../lib/api";
import {
  actionLabel,
  actionMark,
  canRewind,
  checkpointTitle,
  formatCheckpointTime,
  kindLabel,
  previewSummary,
  rewindBlockedReason,
  rewindSummary,
  validateLabel,
} from "../lib/checkpoints";
import { formatCount } from "../lib/format";

export interface CheckpointsTabProps {
  api: ApiClient;
  sessionId: string;
  open: boolean;
  eventCount: number;
  status: string;
  refreshToken: number;
  /** Catatan satu baris di atas daftar bila sesi ber-workspace; undefined tanpa workspace. */
  repoNote?: string;
  /** Jumlah titik untuk lencana angka di tab; undefined saat belum diketahui. */
  onCount?: (count: number | undefined) => void;
  /** Dipanggil setelah folder kerja berubah agar tab lain menyegar. */
  onChanged?: () => void;
}

interface PreviewState {
  loading: boolean;
  data?: CheckpointPreview;
  error?: string;
}

interface RewindInfo {
  id: string;
  summary: string;
}

const DISABLED_MESSAGE = "Checkpoint dimatikan (JEJAK_CHECKPOINTS=0).";
const EMPTY_MESSAGE = "Belum ada titik. Titik dibuat otomatis di awal setiap giliran.";

function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "titik checkpoint tidak dapat dimuat";
}

function previewError(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "efek titik tidak dapat dimuat";
}

function actionTone(action: "restore" | "recreate" | "remove"): string {
  if (action === "restore") return "jk-ok";
  if (action === "remove") return "jk-bad";
  return "jk-panel-cp-mark-muted";
}

interface CheckpointRowProps {
  item: CheckpointItem;
  expanded: boolean;
  preview: PreviewState | undefined;
  now: Date;
  sessionStatus: string;
  confirming: boolean;
  busy: boolean;
  rewindInfo: RewindInfo | undefined;
  onToggle: (id: string) => void;
  onPreview: (id: string) => void;
  onAskRewind: (id: string) => void;
  onCancelRewind: () => void;
  onConfirmRewind: (id: string) => void;
  rowRef: (id: string, element: HTMLButtonElement | null) => void;
  rewindRef: (id: string, element: HTMLButtonElement | null) => void;
  statusRef: (element: HTMLParagraphElement | null) => void;
}

function CheckpointRow({
  item,
  expanded,
  preview,
  now,
  sessionStatus,
  confirming,
  busy,
  rewindInfo,
  onToggle,
  onPreview,
  onAskRewind,
  onCancelRewind,
  onConfirmRewind,
  rowRef,
  rewindRef,
  statusRef,
}: CheckpointRowProps) {
  const title = checkpointTitle(item);
  const blocked = rewindBlockedReason(sessionStatus);
  const rewindable = canRewind(sessionStatus);

  return (
    <div class="jk-panel-cp">
      <button
        type="button"
        ref={(element) => rowRef(item.id, element)}
        class="jk-panel-cp-row"
        aria-expanded={expanded}
        aria-controls={`jk-panel-cp-body-${item.id}`}
        onClick={() => onToggle(item.id)}
      >
        <span class="jk-panel-cp-title">{title}</span>
        <span class="jk-panel-cp-meta">
          {kindLabel(item.kind)} · {formatCheckpointTime(item.createdAt, now)}
        </span>
        <span class="jk-panel-cp-files">
          {formatCount(item.files)} berkas
        </span>
      </button>

      {expanded && (
        <div class="jk-panel-cp-body" id={`jk-panel-cp-body-${item.id}`}>
          <div class="jk-panel-cp-actions">
            <button
              type="button"
              class="jk-link-btn"
              aria-label={`Lihat efek titik ${title}`}
              disabled={preview?.loading === true}
              onClick={() => onPreview(item.id)}
            >
              Lihat efek
            </button>
          </div>

          {preview?.loading === true && <p class="jk-panel-note">Memuat…</p>}

          {preview?.error !== undefined && (
            <p class="jk-error-line" role="alert">
              {preview.error}
            </p>
          )}

          {preview?.data !== undefined && (
            <>
              <p class="jk-panel-note">{previewSummary(preview.data)}</p>
              {preview.data.changes.length > 0 && (
                <ul class="jk-panel-cp-changes">
                  {preview.data.changes.map((change) => (
                    <li class="jk-panel-cp-change" key={change.path}>
                      <span
                        class={`jk-panel-cp-mark ${actionTone(change.action)}`}
                        title={actionLabel(change.action)}
                        aria-label={actionLabel(change.action)}
                      >
                        {actionMark(change.action)}
                      </span>
                      <span class="jk-panel-cp-path" title={change.path}>
                        {change.path}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {preview.data.truncated && (
                <p class="jk-panel-note">Daftar dipotong; hanya sebagian efek yang ditampilkan.</p>
              )}
            </>
          )}

          {rewindInfo !== undefined && rewindInfo.id === item.id && (
            <p ref={statusRef} tabIndex={-1} class="jk-panel-note" role="status">
              {rewindInfo.summary} Titik pengaman dibuat.
            </p>
          )}

          {confirming ? (
            <div class="jk-panel-confirm">
              <p>
                Folder kerja akan dikembalikan ke titik ini. Keadaan sekarang disimpan dulu sebagai
                titik pengaman.
              </p>
              <div class="jk-panel-confirm-actions">
                <button
                  type="button"
                  class="jk-button jk-button-caution"
                  disabled={busy || !rewindable}
                  aria-label={`Konfirmasi kembalikan folder ke titik ${title}`}
                  onClick={() => onConfirmRewind(item.id)}
                >
                  {busy ? "Mengembalikan…" : "Kembalikan"}
                </button>
                <button
                  type="button"
                  class="jk-button"
                  disabled={busy}
                  aria-label={`Batal mengembalikan folder ke titik ${title}`}
                  onClick={onCancelRewind}
                >
                  Batal
                </button>
              </div>
            </div>
          ) : (
            <>
              {blocked !== undefined && <p class="jk-panel-note">{blocked}</p>}
              <button
                type="button"
                ref={(element) => rewindRef(item.id, element)}
                class="jk-link-btn jk-panel-cp-rewind"
                disabled={blocked !== undefined}
                title={blocked}
                aria-label={`Kembalikan folder ke titik ${title}`}
                onClick={() => onAskRewind(item.id)}
              >
                Kembalikan ke titik ini
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function CheckpointsTab({
  api,
  sessionId,
  open,
  eventCount,
  status,
  refreshToken,
  repoNote,
  onCount,
  onChanged,
}: CheckpointsTabProps) {
  const [list, setList] = useState<CheckpointList | undefined>(undefined);
  const [disabled, setDisabled] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);
  const [previews, setPreviews] = useState<Record<string, PreviewState | undefined>>({});
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [rewindInfo, setRewindInfo] = useState<RewindInfo | undefined>(undefined);

  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const requestRef = useRef(0);
  const previewRef = useRef(0);
  const markerRef = useRef<{ status: string; eventCount: number } | undefined>(undefined);
  const tokenRef = useRef(0);
  const saveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const labelInputRef = useRef<HTMLInputElement | null>(null);
  const rewindTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const pendingRewindFocusRef = useRef<string | undefined>(undefined);
  const pendingSaveFocusRef = useRef(false);

  const load = async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const payload = await api.getCheckpoints(sessionId);
      if (ticket !== requestRef.current) return;
      if (!payload.enabled) {
        setDisabled(payload.reason ?? DISABLED_MESSAGE);
        setList(undefined);
        onCount?.(undefined);
        return;
      }
      setDisabled(undefined);
      setList(payload);
      setNow(new Date());
      onCount?.(payload.items.length);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      if (caught instanceof ApiError && caught.status === 503) {
        setDisabled(DISABLED_MESSAGE);
        setList(undefined);
        onCount?.(undefined);
        return;
      }
      setError(errorMessage(caught));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  };

  // Muat saat tab dibuka, saat refresh ditekan, dan saat sesi berubah (debounce 600 ms).
  useEffect(() => {
    if (!open) return;
    const forced = refreshToken !== tokenRef.current;
    if (!forced && markerRef.current !== undefined) {
      if (markerRef.current.status === status && markerRef.current.eventCount === eventCount) {
        return;
      }
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

  // Fokus kembali ke tombol "Simpan titik" setelah isian ditutup.
  useEffect(() => {
    if (pendingSaveFocusRef.current && !formOpen) {
      pendingSaveFocusRef.current = false;
      saveTriggerRef.current?.focus();
    }
  }, [formOpen]);

  // Fokus ke isian label saat formulir dibuka.
  useEffect(() => {
    if (formOpen) labelInputRef.current?.focus();
  }, [formOpen]);

  // Fokus kembali ke pemicu setelah konfirmasi rewind ditutup.
  useEffect(() => {
    const id = pendingRewindFocusRef.current;
    if (id === undefined) return;
    pendingRewindFocusRef.current = undefined;
    rewindTriggerRefs.current[id]?.focus();
  }, [confirmId]);

  // Fokus ke ringkasan setelah rewind selesai.
  useEffect(() => {
    if (rewindInfo !== undefined) statusRef.current?.focus();
  }, [rewindInfo]);

  const registerRow = (id: string, element: HTMLButtonElement | null): void => {
    if (element === null) delete rowRefs.current[id];
    else rowRefs.current[id] = element;
  };

  const toggleExpanded = (id: string): void => {
    setExpandedId((current) => (current === id ? undefined : id));
    setConfirmId((current) => (current === id ? undefined : current));
  };

  const loadPreview = async (id: string): Promise<void> => {
    previewRef.current += 1;
    const ticket = previewRef.current;
    setPreviews((current) => ({ ...current, [id]: { loading: true } }));
    try {
      const data = await api.previewCheckpoint(sessionId, id);
      if (ticket !== previewRef.current) return;
      setPreviews((current) => ({ ...current, [id]: { loading: false, data } }));
    } catch (caught) {
      if (ticket !== previewRef.current) return;
      setPreviews((current) => ({ ...current, [id]: { loading: false, error: previewError(caught) } }));
    }
  };

  const openForm = (): void => {
    setFormError(undefined);
    setFormOpen(true);
  };

  const closeForm = (): void => {
    if (saving) return;
    pendingSaveFocusRef.current = true;
    setFormOpen(false);
    setLabel("");
    setFormError(undefined);
  };

  const submitForm = async (): Promise<void> => {
    if (saving) return;
    const problem = validateLabel(label);
    if (problem !== undefined) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      const text = label.trim();
      await api.createCheckpoint(sessionId, text === "" ? undefined : text);
      setLabel("");
      pendingSaveFocusRef.current = true;
      setFormOpen(false);
      await load();
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : "titik tidak dapat disimpan");
    } finally {
      setSaving(false);
    }
  };

  const askRewind = (id: string): void => {
    setConfirmId(id);
    setRewindInfo(undefined);
  };

  const cancelRewind = (): void => {
    if (confirmId !== undefined) pendingRewindFocusRef.current = confirmId;
    setConfirmId(undefined);
  };

  const submitRewind = async (id: string): Promise<void> => {
    if (busyId !== undefined) return;
    setBusyId(id);
    try {
      const result = await api.rewindCheckpoint(sessionId, id);
      setConfirmId(undefined);
      setPreviews((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setRewindInfo({ id, summary: rewindSummary(result) });
      await load();
      onChanged?.();
    } catch (caught) {
      setConfirmId(undefined);
      setPreviews((current) => ({
        ...current,
        [id]: { loading: false, error: errorMessage(caught) },
      }));
      pendingRewindFocusRef.current = id;
    } finally {
      setBusyId(undefined);
    }
  };

  const rewindTrigger = (id: string, element: HTMLButtonElement | null): void => {
    if (element === null) delete rewindTriggerRefs.current[id];
    else rewindTriggerRefs.current[id] = element;
  };

  return (
    <div class="jk-panel-body">
      {repoNote !== undefined && <p class="jk-panel-note">{repoNote}</p>}

      {disabled !== undefined && <p class="jk-panel-note">{disabled}</p>}

      {disabled === undefined && (
        <>
          {formOpen ? (
            <div class="jk-panel-cp-form">
              <label class="jk-visually-hidden" for="jk-panel-cp-label">
                Label titik
              </label>
              <input
                ref={labelInputRef}
                id="jk-panel-cp-label"
                class="jk-input"
                type="text"
                placeholder="Titik manual"
                value={label}
                aria-invalid={formError !== undefined}
                aria-describedby={formError !== undefined ? "jk-panel-cp-form-error" : undefined}
                onInput={(event) => setLabel((event.currentTarget as HTMLInputElement).value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitForm();
                  } else if (event.key === "Escape" && !saving) {
                    event.preventDefault();
                    closeForm();
                  }
                }}
              />
              <button
                type="button"
                class="jk-button"
                disabled={saving}
                onClick={() => void submitForm()}
              >
                {saving ? "Menyimpan…" : "Simpan"}
              </button>
              <button type="button" class="jk-button" disabled={saving} onClick={closeForm}>
                Batal
              </button>
              {formError !== undefined && (
                <p id="jk-panel-cp-form-error" class="jk-error-line" role="alert">
                  {formError}
                </p>
              )}
            </div>
          ) : (
            <div class="jk-panel-cp-actions">
              <button
                ref={saveTriggerRef}
                type="button"
                class="jk-link-btn"
                onClick={openForm}
              >
                Simpan titik
              </button>
            </div>
          )}

          {loading && list === undefined && <p class="jk-panel-note">Memuat…</p>}

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

          {list !== undefined && list.items.length === 0 && (
            <p class="jk-panel-note">{EMPTY_MESSAGE}</p>
          )}

          {list !== undefined && list.items.length > 0 && (
            <div class="jk-panel-list">
              {list.items.map((item) => (
                <CheckpointRow
                  key={item.id}
                  item={item}
                  expanded={expandedId === item.id}
                  preview={previews[item.id]}
                  now={now}
                  sessionStatus={status}
                  confirming={confirmId === item.id}
                  busy={busyId === item.id}
                  rewindInfo={rewindInfo}
                  onToggle={toggleExpanded}
                  onPreview={(id) => void loadPreview(id)}
                  onAskRewind={askRewind}
                  onCancelRewind={cancelRewind}
                  onConfirmRewind={(id) => void submitRewind(id)}
                  rowRef={registerRow}
                  rewindRef={rewindTrigger}
                  statusRef={(element) => {
                    statusRef.current = element;
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
