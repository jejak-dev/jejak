import { useEffect, useRef } from "preact/hooks";
import type { MemoryItem } from "../lib/api";
import {
  acceptAriaLabel,
  acceptLabel,
  canAccept,
  canArchive,
  canEdit,
  canReject,
  confidenceLabel,
  isRevision,
  layerLabel,
  memoryDateLabel,
  originLabel,
  projectLabel,
  revisionBodyChanged,
  revisionTitleChanged,
  staleLabel,
  type MemoryDraft,
} from "../lib/memory";
import { Icon } from "./Icon";
import { MemoryForm } from "./MemoryForm";

export interface MemoryRowProps {
  item: MemoryItem;
  projects: string[];
  open: boolean;
  editing: boolean;
  confirmingReject: boolean;
  confirmingDelete: boolean;
  busy: boolean;
  failure?: string;
  onToggleOpen: (open: boolean) => void;
  onSubmitEdit: (draft: MemoryDraft) => void;
  onCancelEdit: () => void;
  onAskReject: () => void;
  onAskDelete: () => void;
  onCancelConfirm: () => void;
  onConfirmReject: () => void;
  onConfirmDelete: () => void;
  onArchive: () => void;
  onAccept: () => void;
  onStartEdit: () => void;
}

/** Sifat baris tanpa hook; dipakai uji render tanpa DOM. */
export interface MemoryRowViewProps extends MemoryRowProps {
  cancelRef: { current: HTMLButtonElement | null };
}

export function MemoryRow(props: MemoryRowProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirming = props.confirmingReject || props.confirmingDelete;

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (!confirming) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || props.busy) return;
      event.preventDefault();
      props.onCancelConfirm();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props.busy, confirming, props.onCancelConfirm]);

  return <MemoryRowView {...props} cancelRef={cancelRef} />;
}

export function MemoryRowView(props: MemoryRowViewProps) {
  const {
    item,
    projects,
    open,
    editing,
    confirmingReject,
    confirmingDelete,
    busy,
    failure,
    cancelRef,
  } = props;

  const stale = staleLabel(item.staleReason);
  const dateLabel = memoryDateLabel(item.updatedAt);
  const revision = isRevision(item);
  const target = item.revises ?? null;
  const titleChanged = revisionTitleChanged(item, target);
  const bodyChanged = revisionBodyChanged(item, target);

  return (
    <details
      class="jk-memory-row"
      data-id={item.id}
      open={open || editing}
      onToggle={(event) => props.onToggleOpen(event.currentTarget.open)}
    >
      <summary
        onClick={(event) => {
          // Saat mengubah, baris tidak boleh tertutup karena form masih terbuka.
          if (editing) event.preventDefault();
        }}
      >
        <span class="jk-chev" aria-hidden="true">
          <Icon name="chevron" />
        </span>
        <span class="jk-memory-title">{item.title}</span>
        {revision && (
          <span class="jk-memory-flag jk-memory-flag-revisi" title="Usulan revisi memory lain">
            Revisi
          </span>
        )}
        {stale !== undefined && (
          <span class="jk-memory-flag" title={stale}>
            mungkin basi
          </span>
        )}
        <span class="jk-memory-scope">
          {layerLabel(item.layer)} · {projectLabel(item.projectKey)}
        </span>
      </summary>

      <div class="jk-memory-row-body">
        {editing ? (
          <MemoryForm
            initial={{
              layer: item.layer,
              projectKey: item.projectKey ?? "",
              title: item.title,
              body: item.body,
            }}
            projects={projects}
            lockedLayer
            busy={busy}
            serverError={failure}
            onSubmit={props.onSubmitEdit}
            onCancel={props.onCancelEdit}
          />
        ) : (
          <>
            {stale !== undefined && (
              <p class="jk-memory-stale">{stale}</p>
            )}
            {revision && target === null && (
              <p class="jk-memory-missing">
                Memory yang direvisi sudah tidak ada. Tolak usulan ini.
              </p>
            )}
            {revision && target !== null ? (
              <div class="jk-memory-revision">
                <div class="jk-memory-revision-col">
                  <span class="jk-memory-revision-label">Sebelum</span>
                  <span class="jk-memory-revision-title">{target.title}</span>
                  <p class="jk-memory-revision-body">{target.body}</p>
                </div>
                <div class="jk-memory-revision-col">
                  <span class="jk-memory-revision-label">Sesudah</span>
                  <span class="jk-memory-revision-title">
                    {item.title}
                    {titleChanged && (
                      <span class="jk-memory-revision-mark">berubah</span>
                    )}
                  </span>
                  <p class="jk-memory-revision-body">{item.body}</p>
                  {bodyChanged && (
                    <span class="jk-memory-revision-mark">isi berubah</span>
                  )}
                </div>
              </div>
            ) : (
              <p class="jk-memory-body">{item.body}</p>
            )}
            <p class="jk-memory-meta">
              {confidenceLabel(item.confidence)} · {originLabel(item.origin)}
              {dateLabel === "" ? "" : ` · ${dateLabel}`}
            </p>
            {failure !== undefined && (
              <p class="jk-error-line" role="alert">
                {failure}
              </p>
            )}
            <div class="jk-memory-actions">
              {confirmingReject ? (
                <div class="jk-panel-confirm">
                  <p>Tolak usulan ini? Usulan hilang dari daftar usulan.</p>
                  <div class="jk-panel-confirm-actions">
                    <button
                      type="button"
                      class="jk-button jk-button-caution"
                      disabled={busy}
                      aria-label={`Konfirmasi tolak usulan ${item.title}`}
                      onClick={props.onConfirmReject}
                    >
                      {busy ? "Menolak…" : "Tolak"}
                    </button>
                    <button
                      ref={cancelRef}
                      type="button"
                      class="jk-button"
                      disabled={busy}
                      aria-label={`Batal menolak usulan ${item.title}`}
                      onClick={props.onCancelConfirm}
                    >
                      Batal
                    </button>
                  </div>
                </div>
              ) : confirmingDelete ? (
                <div class="jk-panel-confirm">
                  <p>Hapus permanen? Tidak bisa diurungkan.</p>
                  <div class="jk-panel-confirm-actions">
                    <button
                      type="button"
                      class="jk-button jk-button-caution"
                      disabled={busy}
                      aria-label={`Konfirmasi hapus permanen ${item.title}`}
                      onClick={props.onConfirmDelete}
                    >
                      {busy ? "Menghapus…" : "Hapus"}
                    </button>
                    <button
                      ref={cancelRef}
                      type="button"
                      class="jk-button"
                      disabled={busy}
                      aria-label={`Batal menghapus ${item.title}`}
                      onClick={props.onCancelConfirm}
                    >
                      Batal
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {canAccept(item.status) && (
                    <button
                      type="button"
                      class="jk-link-btn"
                      disabled={busy || (revision && target === null)}
                      aria-label={acceptAriaLabel(item)}
                      onClick={props.onAccept}
                    >
                      {acceptLabel(item)}
                    </button>
                  )}
                  {canEdit(item.status) && (
                    <button
                      type="button"
                      class="jk-link-btn"
                      disabled={busy}
                      aria-label={`Ubah memory ${item.title}`}
                      onClick={props.onStartEdit}
                    >
                      Ubah
                    </button>
                  )}
                  {canReject(item.status) && (
                    <button
                      type="button"
                      class="jk-link-btn jk-memory-danger"
                      disabled={busy}
                      aria-label={`Tolak usulan ${item.title}`}
                      onClick={props.onAskReject}
                    >
                      Tolak
                    </button>
                  )}
                  {canArchive(item.status) && (
                    <button
                      type="button"
                      class="jk-link-btn"
                      disabled={busy}
                      aria-label={`Arsipkan memory ${item.title}`}
                      onClick={props.onArchive}
                    >
                      Arsipkan
                    </button>
                  )}
                  {item.status === "active" && (
                    <button
                      type="button"
                      class="jk-link-btn jk-memory-danger"
                      disabled={busy}
                      aria-label={`Hapus permanen memory ${item.title}`}
                      onClick={props.onAskDelete}
                    >
                      Hapus
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
