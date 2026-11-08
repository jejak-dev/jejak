import { useState } from "preact/hooks";
import {
  REPO_NAME_PATTERN,
  repoNameFromPath,
  validateWorkspaceDraft,
  type WorkspaceDraft,
} from "../lib/workspace";

export interface WorkspaceFormProps {
  initial?: WorkspaceDraft;
  projects: string[];
  busy: boolean;
  serverError?: string;
  onSubmit: (draft: WorkspaceDraft) => void;
  onCancel: () => void;
}

interface RepoRow {
  name: string;
  path: string;
  /** Nama masih ikut otomatis dari path sampai pengguna mengetik sendiri. */
  autoName: boolean;
}

let formSeq = 0;

function initialDraft(initial: WorkspaceDraft | undefined): WorkspaceDraft {
  if (initial !== undefined) {
    return { name: initial.name, repos: initial.repos.map((repo) => ({ ...repo })) };
  }
  return { name: "", repos: [] };
}

export function WorkspaceForm({
  initial,
  projects,
  busy,
  serverError,
  onSubmit,
  onCancel,
}: WorkspaceFormProps) {
  const [draft, setDraft] = useState<WorkspaceDraft>(() => initialDraft(initial));
  const [autoNames, setAutoNames] = useState<boolean[]>(() => (initial?.repos ?? []).map(() => false));
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [listId] = useState(() => {
    formSeq += 1;
    return `jk-workspace-projects-${formSeq}`;
  });

  const setRepo = (index: number, value: Partial<RepoRow>): void => {
    setDraft((current) => ({
      ...current,
      repos: current.repos.map((repo, position) =>
        position === index ? { ...repo, ...value } : repo,
      ),
    }));
  };

  const onPathInput = (index: number, path: string): void => {
    const auto = autoNames[index] !== false;
    setRepo(index, auto ? { path, name: repoNameFromPath(path) } : { path });
  };

  const onNameInput = (index: number, name: string): void => {
    setAutoNames((current) => current.map((value, position) => position === index ? false : value));
    setRepo(index, { name });
  };

  const addRepo = (): void => {
    setDraft((current) => ({ ...current, repos: [...current.repos, { name: "", path: "" }] }));
    setAutoNames((current) => [...current, true]);
  };

  const removeRepo = (index: number): void => {
    setDraft((current) => ({
      ...current,
      repos: current.repos.filter((_repo, position) => position !== index),
    }));
    setAutoNames((current) => current.filter((_value, position) => position !== index));
  };

  const submit = (event: Event): void => {
    event.preventDefault();
    const message = validateWorkspaceDraft(draft);
    setLocalError(message);
    if (message !== undefined) return;
    onSubmit({
      name: draft.name.trim(),
      repos: draft.repos.map((repo) => ({ name: repo.name.trim(), path: repo.path.trim() })),
    });
  };

  const error = localError ?? serverError;

  return (
    <form class="jk-workspace-form" onSubmit={submit} aria-busy={busy}>
      <div class="jk-field">
        <label class="jk-label" for={`${listId}-name`}>
          Nama workspace
        </label>
        <input
          id={`${listId}-name`}
          class="jk-input"
          type="text"
          value={draft.name}
          maxLength={80}
          autoComplete="off"
          onInput={(event) =>
            setDraft((current) => ({
              ...current,
              name: (event.currentTarget as HTMLInputElement).value,
            }))
          }
        />
      </div>

      <datalist id={listId}>
        {projects.map((project) => (
          <option key={project} value={project} />
        ))}
      </datalist>

      <div class="jk-field">
        <span class="jk-label">Repo</span>
        {draft.repos.length === 0 && (
          <p class="jk-help">Belum ada repo. Tambahkan minimal satu.</p>
        )}
        {draft.repos.map((repo, index) => (
          <div class="jk-workspace-repo-row" key={index}>
            <input
              class="jk-input jk-workspace-repo-name"
              type="text"
              aria-label={`Nama repo ${index + 1}`}
              placeholder="nama repo"
              value={repo.name}
              maxLength={40}
              autoComplete="off"
              aria-invalid={repo.name !== "" && !REPO_NAME_PATTERN.test(repo.name)}
              onInput={(event) =>
                onNameInput(index, (event.currentTarget as HTMLInputElement).value)
              }
            />
            <input
              class="jk-input jk-workspace-repo-path"
              type="text"
              aria-label={`Path repo ${index + 1}`}
              placeholder="/path/ke/folder"
              value={repo.path}
              list={listId}
              autoComplete="off"
              onInput={(event) =>
                onPathInput(index, (event.currentTarget as HTMLInputElement).value)
              }
            />
            <button
              type="button"
              class="jk-link-btn"
              aria-label={`Hapus baris repo ${index + 1}`}
              disabled={busy}
              onClick={() => removeRepo(index)}
            >
              Hapus
            </button>
          </div>
        ))}
        <button type="button" class="jk-link-btn" disabled={busy} onClick={addRepo}>
          Tambah repo
        </button>
      </div>

      {error !== undefined && (
        <p class="jk-error-line" role="alert">
          {error}
        </p>
      )}

      <div class="jk-form-actions">
        <button type="submit" class="jk-button jk-button-primary" disabled={busy}>
          {busy ? "Menyimpan…" : "Simpan"}
        </button>
        <button type="button" class="jk-button" disabled={busy} onClick={onCancel}>
          Batal
        </button>
      </div>
    </form>
  );
}
