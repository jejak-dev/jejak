import { IndexerPanel } from "./IndexerPanel";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type WorkspaceItem } from "../lib/api";
import type { WorkspaceDraft } from "../lib/workspace";
import type { ServiceCardDraft } from "./ServiceCardForm";
import { WorkspaceForm } from "./WorkspaceForm";
import { WorkspaceRow } from "./WorkspaceRow";

export interface WorkspacePageProps {
  api: ApiClient;
  /** Folder kerja yang dikenal sesi + cwd; untuk pilihan path repo. */
  projects: string[];
}

interface Problem {
  file: string;
  reason: string;
}

const DISABLED_HINT = "Workspace dimatikan (JEJAK_WORKSPACES=0).";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "workspace tidak dapat dimuat";
}

function isDisabled(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 503;
}

export function WorkspacePage({ api, projects }: WorkspacePageProps) {
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [disabled, setDisabled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [openRepo, setOpenRepo] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [editingCard, setEditingCard] = useState<string | undefined>(undefined);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [failures, setFailures] = useState<Record<string, string | undefined>>({});

  const requestRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingFocusRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setLoadError(undefined);
    try {
      const payload = await api.listWorkspaces();
      if (ticket !== requestRef.current) return;
      setItems(payload.items);
      setOpenIds((current) => {
        const ids = new Set(payload.items.map((entry) => entry.id));
        return new Set([...current].filter((id) => ids.has(id)));
      });
      setProblems(payload.problems);
      setDisabled(false);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setDisabled(isDisabled(caught));
      setLoadError(errorMessage(caught));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Kembalikan fokus setelah daftar dimuat ulang karena aksi.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    headingRef.current?.focus();
  }, [items]);

  const afterAction = useCallback(async (): Promise<void> => {
    pendingFocusRef.current = true;
    setEditingId(undefined);
    setEditingCard(undefined);
    setConfirmDeleteId(undefined);
    await load();
  }, [load]);

  const runAction = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    if (busyId !== undefined) return;
    setBusyId(id);
    setFailures((current) => ({ ...current, [id]: undefined }));
    try {
      await action();
      await afterAction();
    } catch (caught) {
      setFailures((current) => ({ ...current, [id]: errorMessage(caught) }));
      setConfirmDeleteId(undefined);
    } finally {
      setBusyId(undefined);
    }
  };

  const submitAdd = async (draft: WorkspaceDraft): Promise<void> => {
    if (addBusy) return;
    setAddBusy(true);
    setAddError(undefined);
    try {
      await api.createWorkspace({
        name: draft.name,
        repos: draft.repos.map((repo) => ({ name: repo.name, path: repo.path })),
      });
      setAdding(false);
      pendingFocusRef.current = true;
      await load();
    } catch (caught) {
      setAddError(errorMessage(caught));
    } finally {
      setAddBusy(false);
    }
  };

  const submitEdit = async (id: string, draft: WorkspaceDraft): Promise<void> => {
    await runAction(id, () =>
      api.updateWorkspace(id, {
        name: draft.name,
        repos: draft.repos.map((repo) => ({ name: repo.name, path: repo.path })),
      }),
    );
  };

  const submitCard = async (
    id: string,
    repoName: string,
    draft: ServiceCardDraft,
  ): Promise<void> => {
    setBusyId(id);
    setFailures((current) => ({ ...current, [id]: undefined }));
    try {
      await api.setWorkspaceCard(id, repoName, draft);
      setEditingCard(undefined);
      pendingFocusRef.current = true;
      await load();
    } catch (caught) {
      setFailures((current) => ({ ...current, [id]: errorMessage(caught) }));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <section class="jk-workspace" aria-labelledby="jk-workspace-title">
      <header class="jk-settings-head">
        <h2 id="jk-workspace-title" ref={headingRef} tabIndex={-1} class="jk-settings-title">
          Workspace
        </h2>
        <p class="jk-privacy-note">
          Kelompokkan beberapa repo dan catat kartu service-nya. Dipakai agent untuk memahami
          hubungan antar repo.
        </p>
      </header>

      <div class="jk-workspace-head">
        <button
          type="button"
          class="jk-button jk-workspace-add"
          aria-expanded={adding}
          disabled={disabled}
          onClick={() => {
            setAdding((value) => !value);
            setAddError(undefined);
            setEditingId(undefined);
          }}
        >
          Tambah
        </button>
      </div>

      {adding && !disabled && (
        <div class="jk-workspace-form-wrap">
          <WorkspaceForm
            projects={projects}
            busy={addBusy}
            serverError={addError}
            onSubmit={(draft) => void submitAdd(draft)}
            onCancel={() => {
              setAdding(false);
              setAddError(undefined);
            }}
          />
        </div>
      )}

      {problems.length > 0 && (
        <details class="jk-workspace-problems">
          <summary class="jk-workspace-warn">
            {problems.length} berkas workspace dilewati karena rusak.
          </summary>
          <ul class="jk-workspace-problem-list">
            {problems.map((problem) => (
              <li key={problem.file}>
                <code>{problem.file}</code>
              </li>
            ))}
          </ul>
        </details>
      )}

      {loading && <p class="jk-note">Memuat…</p>}

      {disabled ? (
        <p class="jk-note">{DISABLED_HINT}</p>
      ) : (
        loadError !== undefined && (
          <div class="jk-panel-error">
            <p class="jk-error-line" role="alert">
              {loadError}
            </p>
            <button type="button" class="jk-link-btn" onClick={() => void load()}>
              Coba lagi
            </button>
          </div>
        )
      )}

      {!loading && !disabled && loadError === undefined && (
        <div class="jk-workspace-list">
          {items.length === 0 ? (
            <p class="jk-note">Belum ada workspace. Tambahkan untuk mengelompokkan repo.</p>
          ) : (
            items.map((workspace) => {
              const prefix = `${workspace.id}\0`;
              const repoFrom = (key: string | undefined): string | undefined =>
                key !== undefined && key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
              return (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                projects={projects}
                open={openIds.has(workspace.id)}
                editing={editingId === workspace.id}
                confirmingDelete={confirmDeleteId === workspace.id}
                busy={busyId === workspace.id}
                failure={failures[workspace.id]}
                openRepo={repoFrom(openRepo)}
                editingRepo={repoFrom(editingCard)}
                cardFailure={failures[workspace.id]}
                onToggleOpen={(isOpen) => {
                  setOpenIds((current) => {
                    const next = new Set(current);
                    if (isOpen) next.add(workspace.id);
                    else next.delete(workspace.id);
                    return next;
                  });
                }}
                onToggleRepo={(name) =>
                  setOpenRepo(name === undefined ? undefined : `${workspace.id}\0${name}`)
                }
                onStartEdit={() => {
                  setConfirmDeleteId(undefined);
                  setEditingCard(undefined);
                  setOpenIds((current) => new Set(current).add(workspace.id));
                  setEditingId(workspace.id);
                }}
                onCancelEdit={() => setEditingId(undefined)}
                onSubmitEdit={(draft) => void submitEdit(workspace.id, draft)}
                onAskDelete={() => setConfirmDeleteId(workspace.id)}
                onCancelConfirm={() => setConfirmDeleteId(undefined)}
                onConfirmDelete={() =>
                  void runAction(workspace.id, () => api.deleteWorkspace(workspace.id))
                }
                onStartCard={(name) => {
                  setEditingId(undefined);
                  setOpenRepo(`${workspace.id}\0${name}`);
                  setEditingCard(`${workspace.id}\0${name}`);
                }}
                onCancelCard={() => setEditingCard(undefined)}
                onSubmitCard={(name, draft) => void submitCard(workspace.id, name, draft)}
              />
              );
            })
          )}
        </div>
      )}

      <IndexerPanel api={api} />
    </section>
  );
}
