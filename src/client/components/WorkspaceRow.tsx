import { useEffect, useRef } from "preact/hooks";
import type { ServiceCardItem, WorkspaceItem } from "../lib/api";
import { cardSummary, kindLabel, type WorkspaceDraft } from "../lib/workspace";
import { Icon } from "./Icon";
import { ServiceCardForm, type ServiceCardDraft } from "./ServiceCardForm";
import { WorkspaceForm } from "./WorkspaceForm";

export interface WorkspaceRowProps {
  workspace: WorkspaceItem;
  projects: string[];
  open: boolean;
  editing: boolean;
  confirmingDelete: boolean;
  busy: boolean;
  failure?: string;
  /** Nama repo yang dibuka untuk melihat kartu. */
  openRepo?: string;
  /** Nama repo yang kartunya sedang diubah. */
  editingRepo?: string;
  cardFailure?: string;
  onToggleOpen: (open: boolean) => void;
  onToggleRepo: (name: string | undefined) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (draft: WorkspaceDraft) => void;
  onAskDelete: () => void;
  onCancelConfirm: () => void;
  onConfirmDelete: () => void;
  onStartCard: (name: string) => void;
  onCancelCard: () => void;
  onSubmitCard: (name: string, draft: ServiceCardDraft) => void;
}

function cardLines(label: string, items: readonly string[]) {
  if (items.length === 0) return null;
  return (
    <p class="jk-workspace-card-line">
      <span class="jk-workspace-card-label">{label}</span>
      {items.join(", ")}
    </p>
  );
}

export function WorkspaceRow({
  workspace,
  projects,
  open,
  editing,
  confirmingDelete,
  busy,
  failure,
  openRepo,
  editingRepo,
  cardFailure,
  onToggleOpen,
  onToggleRepo,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onAskDelete,
  onCancelConfirm,
  onConfirmDelete,
  onStartCard,
  onCancelCard,
  onSubmitCard,
}: WorkspaceRowProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirmingDelete) cancelRef.current?.focus();
  }, [confirmingDelete]);

  useEffect(() => {
    if (!confirmingDelete) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onCancelConfirm();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, confirmingDelete, onCancelConfirm]);

  const repoCount = workspace.repos.length;

  return (
    <details
      class="jk-workspace-row"
      data-id={workspace.id}
      open={open || editing}
      onToggle={(event) => onToggleOpen(event.currentTarget.open)}
    >
      <summary
        onClick={(event) => {
          if (editing) event.preventDefault();
        }}
      >
        <span class="jk-chev" aria-hidden="true">
          <Icon name="chevron" />
        </span>
        <span class="jk-workspace-name">{workspace.name}</span>
        <span class="jk-workspace-meta">{repoCount} repo</span>
      </summary>

      <div class="jk-workspace-row-body">
        {editing ? (
          <WorkspaceForm
            initial={{
              name: workspace.name,
              repos: workspace.repos.map((repo) => ({ name: repo.name, path: repo.path })),
            }}
            projects={projects}
            busy={busy}
            serverError={failure}
            onSubmit={onSubmitEdit}
            onCancel={onCancelEdit}
          />
        ) : (
          <>
            {repoCount === 0 ? (
              <p class="jk-help">Workspace ini belum punya repo.</p>
            ) : (
              <div class="jk-workspace-repos">
                {workspace.repos.map((repo, index) => {
                  const isOpen = openRepo === repo.name;
                  const card: ServiceCardItem = repo.card;
                  return (
                    <details
                      class="jk-workspace-repo"
                      key={repo.name}
                      open={isOpen || editingRepo === repo.name}
                      onToggle={(event) => onToggleRepo(event.currentTarget.open ? repo.name : undefined)}
                    >
                      <summary
                        onClick={(event) => {
                          if (editingRepo === repo.name) event.preventDefault();
                        }}
                      >
                        <span class="jk-chev" aria-hidden="true">
                          <Icon name="chevron" />
                        </span>
                        <span class="jk-workspace-repo-title">{repo.name}</span>
                        {index === 0 && <span class="jk-workspace-primary">utama</span>}
                        {repo.missing && <span class="jk-workspace-missing">folder hilang</span>}
                        <span class="jk-workspace-repo-summary">{cardSummary(card)}</span>
                      </summary>
                      <div class="jk-workspace-repo-body">
                        <p class="jk-workspace-path">{repo.path}</p>
                        {editingRepo === repo.name ? (
                          <ServiceCardForm
                            card={card}
                            busy={busy}
                            serverError={cardFailure}
                            onSubmit={(draft) => onSubmitCard(repo.name, draft)}
                            onCancel={onCancelCard}
                          />
                        ) : (
                          <>
                            <p class="jk-workspace-card-meta">
                              {kindLabel(card.kind)}
                              {card.updatedAt === null ? "" : " · sudah diisi"}
                            </p>
                            {card.description.trim() === "" ? (
                              <p class="jk-help">Belum ada deskripsi.</p>
                            ) : (
                              <p class="jk-workspace-description">{card.description}</p>
                            )}
                            {cardLines("Tabel", card.tables)}
                            {cardLines("Queue", card.queues)}
                            {cardLines("Memanggil", card.calls)}
                            <div class="jk-workspace-actions">
                              <button
                                type="button"
                                class="jk-link-btn"
                                disabled={busy}
                                aria-label={`Ubah kartu ${repo.name} di ${workspace.name}`}
                                onClick={() => onStartCard(repo.name)}
                              >
                                Ubah kartu
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}

            {failure !== undefined && (
              <p class="jk-error-line" role="alert">
                {failure}
              </p>
            )}

            <div class="jk-workspace-actions">
              {confirmingDelete ? (
                <div class="jk-panel-confirm">
                  <p>Hapus workspace? Folder repo tidak ikut terhapus.</p>
                  <div class="jk-panel-confirm-actions">
                    <button
                      type="button"
                      class="jk-button jk-button-caution"
                      disabled={busy}
                      aria-label={`Konfirmasi hapus workspace ${workspace.name}`}
                      onClick={onConfirmDelete}
                    >
                      {busy ? "Menghapus…" : "Hapus"}
                    </button>
                    <button
                      ref={cancelRef}
                      type="button"
                      class="jk-button"
                      disabled={busy}
                      aria-label={`Batal menghapus workspace ${workspace.name}`}
                      onClick={onCancelConfirm}
                    >
                      Batal
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    class="jk-link-btn"
                    disabled={busy}
                    aria-label={`Ubah workspace ${workspace.name}`}
                    onClick={onStartEdit}
                  >
                    Ubah
                  </button>
                  <button
                    type="button"
                    class="jk-link-btn jk-workspace-danger"
                    disabled={busy}
                    aria-label={`Hapus workspace ${workspace.name}`}
                    onClick={onAskDelete}
                  >
                    Hapus
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
