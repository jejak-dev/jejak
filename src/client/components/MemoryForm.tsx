import { useState } from "preact/hooks";
import type { MemoryLayer } from "../lib/api";
import { MEMORY_BODY_MAX, MEMORY_TITLE_MAX, validateDraft, type MemoryDraft } from "../lib/memory";
import { Select } from "./Select";

export interface MemoryFormProps {
  /** Isian awal; saat ini undefined berarti form tambah baru. */
  initial?: MemoryDraft;
  projects: string[];
  /** Lapis dikunci saat mengubah memory yang sudah ada. */
  lockedLayer?: boolean;
  busy: boolean;
  /** Galat dari server (mis. penolakan rahasia); isian tidak dihapus. */
  serverError?: string;
  onSubmit: (draft: MemoryDraft) => void;
  onCancel: () => void;
}

function initialDraft(initial: MemoryDraft | undefined, projects: string[]): MemoryDraft {
  if (initial !== undefined) return initial;
  return { layer: "profile", projectKey: projects[0] ?? "", title: "", body: "" };
}

export function MemoryForm({
  initial,
  projects,
  lockedLayer = false,
  busy,
  serverError,
  onSubmit,
  onCancel,
}: MemoryFormProps) {
  const [draft, setDraft] = useState<MemoryDraft>(() => initialDraft(initial, projects));
  const [localError, setLocalError] = useState<string | undefined>(undefined);

  const patch = (value: Partial<MemoryDraft>): void => {
    setDraft((current) => ({ ...current, ...value }));
  };

  const submit = (event: Event): void => {
    event.preventDefault();
    const message = validateDraft(draft);
    setLocalError(message);
    if (message !== undefined) return;
    onSubmit({
      layer: draft.layer,
      projectKey: draft.layer === "project" ? draft.projectKey.trim() : "",
      title: draft.title.trim(),
      body: draft.body.trim(),
    });
  };

  const error = localError ?? serverError;

  return (
    <form class="jk-memory-form" onSubmit={submit} aria-busy={busy}>
      <div class="jk-field">
        <span class="jk-label">Lapis</span>
        <div class="jk-radio-group">
          {(["profile", "project"] as MemoryLayer[]).map((layer) => (
            <label class="jk-radio" key={layer}>
              <input
                type="radio"
                name="jk-memory-layer"
                value={layer}
                checked={draft.layer === layer}
                disabled={lockedLayer}
                onChange={() => patch({ layer })}
              />
              <span>{layer === "profile" ? "Profil" : "Proyek"}</span>
            </label>
          ))}
        </div>
      </div>

      {draft.layer === "project" && (
        <div class="jk-field">
          <label class="jk-label" for="jk-memory-project">
            Folder proyek
          </label>
          <Select
            id="jk-memory-project"
            value={draft.projectKey}
            disabled={lockedLayer}
            placeholder="Belum ada folder dikenal"
            options={
              projects.length === 0
                ? [{ value: "", label: "Belum ada folder dikenal" }]
                : projects.map((project) => ({ value: project, label: project }))
            }
            onChange={(value) => patch({ projectKey: value })}
          />
        </div>
      )}

      <div class="jk-field">
        <label class="jk-label" for="jk-memory-field-title">
          Judul
        </label>
        <input
          id="jk-memory-field-title"
          class="jk-input"
          type="text"
          value={draft.title}
          maxLength={MEMORY_TITLE_MAX}
          autoComplete="off"
          onInput={(event) => patch({ title: (event.currentTarget as HTMLInputElement).value })}
        />
      </div>

      <div class="jk-field">
        <label class="jk-label" for="jk-memory-body">
          Isi
        </label>
        <textarea
          id="jk-memory-body"
          class="jk-textarea"
          rows={4}
          value={draft.body}
          maxLength={MEMORY_BODY_MAX}
          onInput={(event) => patch({ body: (event.currentTarget as HTMLTextAreaElement).value })}
        />
        <p class="jk-help jk-memory-count">
          {draft.body.length}/{MEMORY_BODY_MAX}
        </p>
      </div>

      {error !== undefined && (
        <p class="jk-error-line" role="alert">
          {error}
        </p>
      )}

      <div class="jk-form-actions jk-memory-form-actions">
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
