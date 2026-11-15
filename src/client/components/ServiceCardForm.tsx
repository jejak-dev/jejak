import { useState } from "preact/hooks";
import type { ServiceCardItem, ServiceKind } from "../lib/api";
import {
  CARD_DESCRIPTION_MAX,
  KIND_OPTIONS,
  linesToList,
  listToLines,
  validateCardDraft,
  type CardDraft,
} from "../lib/workspace";
import { Select } from "./Select";

export interface ServiceCardDraft {
  description: string;
  kind: ServiceKind;
  tables: string[];
  queues: string[];
  calls: string[];
}

export interface ServiceCardFormProps {
  card: ServiceCardItem;
  busy: boolean;
  serverError?: string;
  onSubmit: (draft: ServiceCardDraft) => void;
  onCancel: () => void;
}

let cardSeq = 0;

export function ServiceCardForm({
  card,
  busy,
  serverError,
  onSubmit,
  onCancel,
}: ServiceCardFormProps) {
  const [draft, setDraft] = useState<CardDraft & { kind: ServiceKind }>(() => ({
    description: card.description,
    kind: card.kind,
    tables: listToLines(card.tables),
    queues: listToLines(card.queues),
    calls: listToLines(card.calls),
  }));
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [id] = useState(() => {
    cardSeq += 1;
    return `jk-service-card-${cardSeq}`;
  });

  const patch = (value: Partial<CardDraft & { kind: ServiceKind }>): void => {
    setDraft((current) => ({ ...current, ...value }));
  };

  const submit = (event: Event): void => {
    event.preventDefault();
    const message = validateCardDraft(draft);
    setLocalError(message);
    if (message !== undefined) return;
    onSubmit({
      description: draft.description.trim(),
      kind: draft.kind,
      tables: linesToList(draft.tables),
      queues: linesToList(draft.queues),
      calls: linesToList(draft.calls),
    });
  };

  const error = localError ?? serverError;

  return (
    <form class="jk-service-card-form" onSubmit={submit} aria-busy={busy}>
      <div class="jk-field">
        <label class="jk-label" for={`${id}-description`}>
          Deskripsi
        </label>
        <textarea
          id={`${id}-description`}
          class="jk-textarea"
          rows={3}
          value={draft.description}
          maxLength={CARD_DESCRIPTION_MAX}
          onInput={(event) =>
            patch({ description: (event.currentTarget as HTMLTextAreaElement).value })
          }
        />
        <p class="jk-help jk-workspace-count">
          {draft.description.length}/{CARD_DESCRIPTION_MAX}
        </p>
      </div>

      <div class="jk-field">
        <label class="jk-label" for={`${id}-kind`}>
          Jenis
        </label>
        <Select
          id={`${id}-kind`}
          value={draft.kind}
          options={KIND_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
          onChange={(value) => patch({ kind: value as ServiceKind })}
        />
      </div>

      {(
        [
          ["tables", "Tabel", "satu per baris"],
          ["queues", "Queue", "satu per baris"],
          ["calls", "Memanggil", "nama service lain, satu per baris"],
        ] as const
      ).map(([field, label, hint]) => (
        <div class="jk-field" key={field}>
          <label class="jk-label" for={`${id}-${field}`}>
            {label}
          </label>
          <textarea
            id={`${id}-${field}`}
            class="jk-textarea"
            rows={3}
            value={draft[field]}
            placeholder={hint}
            onInput={(event) =>
              patch({ [field]: (event.currentTarget as HTMLTextAreaElement).value })
            }
          />
          <p class="jk-help jk-workspace-count">
            {linesToList(draft[field]).length} entri
          </p>
        </div>
      ))}

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
