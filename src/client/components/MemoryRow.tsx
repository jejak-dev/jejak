import { useEffect, useRef } from "preact/hooks";
import type { MemoryItem } from "../lib/api";
import {
  canAccept,
  canArchive,
  canEdit,
  canReject,
  confidenceLabel,
  layerLabel,
  memoryDateLabel,
  originLabel,
  projectLabel,
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

export function MemoryRow({
  item,
  projects,
  open,
  editing,
  confirmingReject,
  confirmingDelete,
  busy,
  failure,
  onToggleOpen,
  onSubmitEdit,
  onCancelEdit,
  onAskReject,
  onAskDelete,
  onCancelConfirm,
  onConfirmReject,
  onConfirmDelete,
  onArchive,
  onAccept,
  onStartEdit,
}: MemoryRowProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirming = confirmingReject || confirmingDelete;

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (!confirming) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onCancelConfirm();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, confirming, onCancelConfirm]);

  const stale = staleLabel(item.staleReason);
  const dateLabel = memoryDateLabel(item.updatedAt);

  return (
    <details
      class="jk-memory-row"
      data-id={item.id}
      open={open || editing}
      onToggle={(event) => onToggleOpen(event.currentTarget.open)}
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
            onSubmit={onSubmitEdit}
            onCancel={onCancelEdit}
          />
        ) : (
          <>
            {stale !== undefined && (
              <p class="jk-memory-stale">{stale}</p>
            )}
            <p class="jk-memory-body">{item.body}</p>
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
                      onClick={onConfirmReject}
                    >
                      {busy ? "Menolak…" : "Tolak"}
                    </button>
                    <button
                      ref={cancelRef}
                      type="button"
                      class="jk-button"
                      disabled={busy}
                      aria-label={`Batal menolak usulan ${item.title}`}
                      onClick={onCancelConfirm}
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
                      onClick={onConfirmDelete}
                    >
                      {busy ? "Menghapus…" : "Hapus"}
                    </button>
                    <button
                      ref={cancelRef}
                      type="button"
                      class="jk-button"
                      disabled={busy}
                      aria-label={`Batal menghapus ${item.title}`}
                      onClick={onCancelConfirm}
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
                      disabled={busy}
                      aria-label={`Terima usulan ${item.title}`}
                      onClick={onAccept}
                    >
                      Terima
                    </button>
                  )}
                  {canEdit(item.status) && (
                    <button
                      type="button"
                      class="jk-link-btn"
                      disabled={busy}
                      aria-label={`Ubah memory ${item.title}`}
                      onClick={onStartEdit}
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
                      onClick={onAskReject}
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
                      onClick={onArchive}
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
                      onClick={onAskDelete}
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
