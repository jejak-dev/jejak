import { useCallback, useEffect, useState } from "preact/hooks";
import { ApiError, type ApiClient, type RunnerCommand } from "../lib/api";
import {
  confirmText,
  groupCommands,
  RUNNER_MAX_CUSTOM,
  runErrorMessage,
  validateCommandForm,
} from "../lib/runner";
import { Icon } from "./Icon";

export interface RunnerTabProps {
  api: ApiClient;
  /** Folder kerja sesi; perintah diambil dari folder ini. */
  cwd: string;
  /** Dipanggil setelah perintah dijalankan; membuka tab Terminal. */
  onOpenTerminal: (terminalId: string) => void;
}

export interface RunnerFormState {
  open: boolean;
  mode: "tambah" | "ubah";
  /** Id perintah kustom yang diubah (mode "ubah"). */
  id?: string;
  label: string;
  command: string;
  group: string;
  error?: string;
  saving: boolean;
}

export interface RunnerState {
  commands: readonly RunnerCommand[];
  loading: boolean;
  /** Galat memuat daftar. */
  error?: string;
  /** Pesan dari aksi terakhir (galat menjalankan, menambah, dan sejenisnya). */
  note?: string;
  /** Id perintah yang menunggu konfirmasi jalankan. */
  confirmId?: string;
  /** Id perintah yang menunggu konfirmasi hapus. */
  deletingId?: string;
  form: RunnerFormState;
}

export interface RunnerFormPatch {
  label?: string;
  command?: string;
  group?: string;
}

export interface RunnerActions {
  onRetry: () => void;
  onRun: (item: RunnerCommand) => void;
  onConfirmRun: (item: RunnerCommand) => void;
  onCancelConfirm: () => void;
  onEdit: (item: RunnerCommand) => void;
  onDelete: (item: RunnerCommand) => void;
  onConfirmDelete: (item: RunnerCommand) => void;
  onCancelDelete: () => void;
  onOpenForm: () => void;
  onFormChange: (patch: RunnerFormPatch) => void;
  onSubmitForm: () => void;
  onCancelForm: () => void;
}

export interface RunnerViewProps {
  state: RunnerState;
  actions: RunnerActions;
}

const EMPTY_MESSAGE =
  "Belum ada perintah. Tambahkan perintah kustom atau tambahkan scripts di package.json.";
const NO_FOLDER_MESSAGE = "Folder sesi belum tersedia.";

const EMPTY_FORM: RunnerFormState = {
  open: false,
  mode: "tambah",
  label: "",
  command: "",
  group: "",
  saving: false,
};

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : "Permintaan gagal.";
}

/** Tooltip baris: script package menampilkan isi script, kustom perintahnya. */
function tooltipOf(item: RunnerCommand): string {
  if (item.source === "package") return item.detail ?? item.command;
  return item.command;
}

/**
 * Tampilan tab Commands tanpa state internal; dipakai juga oleh tes (VNode
 * tanpa DOM). Perintah yang belum dikonfirmasi menampilkan konfirmasi inline
 * berisi isi persis perintah yang akan berjalan.
 */
export function RunnerView({ state, actions }: RunnerViewProps) {
  const groups = groupCommands(state.commands);
  const customCount = state.commands.filter((item) => item.source === "custom").length;
  const canAdd = customCount < RUNNER_MAX_CUSTOM;

  return (
    <div class="jk-panel-body jk-runner">
      {state.error !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {state.error}
          </p>
          <button type="button" class="jk-button jk-button-secondary" onClick={actions.onRetry}>
            Coba lagi
          </button>
        </div>
      )}

      {state.loading && (
        <p class="jk-panel-note" role="status">
          Memuat perintah…
        </p>
      )}

      {!state.loading && state.error === undefined && groups.length === 0 && (
        <p class="jk-panel-note">{EMPTY_MESSAGE}</p>
      )}

      {state.note !== undefined && (
        <p class="jk-note" role="alert">
          {state.note}
        </p>
      )}

      {groups.map((group) => (
        <section class="jk-runner-group" key={group.title}>
          <h3 class="jk-runner-group-title">{group.title}</h3>
          <ul class="jk-runner-list">
            {group.items.map((item) => (
              <li class="jk-runner-item" key={item.id}>
                <span class="jk-runner-label" title={tooltipOf(item)}>
                  {item.label}
                </span>
                <button
                  type="button"
                  class="jk-icon-btn jk-runner-run"
                  aria-label={`Jalankan ${item.label}`}
                  title={tooltipOf(item)}
                  onClick={() => actions.onRun(item)}
                >
                  <Icon name="play" />
                </button>
                {item.source === "custom" && (
                  <>
                    <button
                      type="button"
                      class="jk-icon-btn"
                      aria-label={`Ubah ${item.label}`}
                      title="Ubah perintah"
                      onClick={() => actions.onEdit(item)}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      type="button"
                      class="jk-icon-btn"
                      aria-label={`Hapus ${item.label}`}
                      title="Hapus perintah"
                      onClick={() => actions.onDelete(item)}
                    >
                      <Icon name="close" />
                    </button>
                  </>
                )}

                {state.confirmId === item.id && (
                  <div class="jk-runner-confirm" role="group" aria-label={`Konfirmasi ${item.label}`}>
                    <pre class="jk-runner-confirm-text">{confirmText(item)}</pre>
                    <div class="jk-runner-confirm-actions">
                      <button
                        type="button"
                        class="jk-button jk-button-primary"
                        onClick={() => actions.onConfirmRun(item)}
                      >
                        Jalankan
                      </button>
                      <button
                        type="button"
                        class="jk-button jk-button-secondary"
                        onClick={actions.onCancelConfirm}
                      >
                        Batal
                      </button>
                    </div>
                  </div>
                )}

                {state.deletingId === item.id && (
                  <div
                    class="jk-runner-confirm"
                    role="group"
                    aria-label={`Konfirmasi hapus ${item.label}`}
                  >
                    <p class="jk-note">Hapus perintah "{item.label}"?</p>
                    <div class="jk-runner-confirm-actions">
                      <button
                        type="button"
                        class="jk-button jk-button-danger"
                        onClick={() => actions.onConfirmDelete(item)}
                      >
                        Hapus
                      </button>
                      <button
                        type="button"
                        class="jk-button jk-button-secondary"
                        onClick={actions.onCancelDelete}
                      >
                        Batal
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {state.form.open && (
        <form
          class="jk-runner-form"
          onSubmit={(event) => {
            event.preventDefault();
            actions.onSubmitForm();
          }}
        >
          <label class="jk-runner-field">
            <span>Label</span>
            <input
              class="jk-input"
              type="text"
              value={state.form.label}
              placeholder="Contoh: Jalankan tes"
              aria-invalid={state.form.error !== undefined}
              onInput={(event) =>
                actions.onFormChange({
                  label: (event.currentTarget as HTMLInputElement).value,
                })
              }
            />
          </label>
          <label class="jk-runner-field">
            <span>Perintah</span>
            <input
              class="jk-input jk-input-code"
              type="text"
              value={state.form.command}
              placeholder="bun test"
              aria-invalid={state.form.error !== undefined}
              onInput={(event) =>
                actions.onFormChange({
                  command: (event.currentTarget as HTMLInputElement).value,
                })
              }
            />
          </label>
          <label class="jk-runner-field">
            <span>Grup (opsional)</span>
            <input
              class="jk-input"
              type="text"
              value={state.form.group}
              placeholder="Kustom"
              onInput={(event) =>
                actions.onFormChange({
                  group: (event.currentTarget as HTMLInputElement).value,
                })
              }
            />
          </label>
          {state.form.error !== undefined && (
            <p class="jk-field-error" role="alert">
              {state.form.error}
            </p>
          )}
          <div class="jk-runner-form-actions">
            <button type="submit" class="jk-button jk-button-primary" disabled={state.form.saving}>
              {state.form.saving ? "Menyimpan…" : state.form.mode === "ubah" ? "Simpan" : "Tambah"}
            </button>
            <button
              type="button"
              class="jk-button jk-button-secondary"
              disabled={state.form.saving}
              onClick={actions.onCancelForm}
            >
              Batal
            </button>
          </div>
        </form>
      )}

      {!state.form.open && canAdd && (
        <button
          type="button"
          class="jk-button jk-button-secondary jk-runner-add"
          onClick={actions.onOpenForm}
        >
          Tambah perintah
        </button>
      )}
    </div>
  );
}

/** Tab Commands: daftar perintah proyek, konfirmasi inline, dan form kecil. */
export function RunnerTab({ api, cwd, onOpenTerminal }: RunnerTabProps) {
  const [state, setState] = useState<RunnerState>({
    commands: [],
    loading: true,
    form: { ...EMPTY_FORM },
  });

  const load = useCallback(async (): Promise<void> => {
    if (cwd === "") {
      setState((current) => ({
        ...current,
        commands: [],
        loading: false,
        note: NO_FOLDER_MESSAGE,
      }));
      return;
    }
    setState((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const result = await api.listRunner(cwd);
      setState((current) => ({ ...current, commands: result.commands, loading: false }));
    } catch (caught) {
      setState((current) => ({
        ...current,
        loading: false,
        error: errorMessage(caught),
      }));
    }
  }, [api, cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const runCommand = useCallback(
    async (item: RunnerCommand, confirm?: boolean): Promise<void> => {
      setState((current) => ({ ...current, note: undefined }));
      try {
        const result = await api.runRunnerCommand(cwd, item.id, confirm);
        onOpenTerminal(result.terminalId);
        setState((current) => ({ ...current, confirmId: undefined }));
        await load();
      } catch (caught) {
        const status = caught instanceof ApiError ? caught.status : 0;
        const message = caught instanceof ApiError ? caught.message : undefined;
        setState((current) => ({
          ...current,
          note: runErrorMessage(status, message),
        }));
      }
    },
    [api, cwd, load, onOpenTerminal],
  );

  const submitForm = useCallback(async (): Promise<void> => {
    const form = state.form;
    const checked = validateCommandForm({
      label: form.label,
      command: form.command,
      group: form.group,
    });
    if (!checked.ok) {
      setState((current) => ({ ...current, form: { ...current.form, error: checked.error } }));
      return;
    }
    setState((current) => ({ ...current, form: { ...current.form, saving: true, error: undefined } }));
    try {
      if (form.mode === "ubah" && form.id !== undefined) {
        await api.updateRunnerCommand(cwd, form.id, {
          label: checked.value.label,
          command: checked.value.command,
          // Teks kosong berarti grup dilepas.
          group: form.group.trim(),
        });
      } else {
        await api.addRunnerCommand(cwd, {
          label: checked.value.label,
          command: checked.value.command,
          ...(checked.value.group === undefined ? {} : { group: checked.value.group }),
        });
      }
      setState((current) => ({ ...current, form: { ...EMPTY_FORM } }));
      await load();
    } catch (caught) {
      setState((current) => ({
        ...current,
        form: { ...current.form, saving: false, error: errorMessage(caught) },
      }));
    }
  }, [api, cwd, load, state.form]);

  const deleteCommand = useCallback(
    async (item: RunnerCommand): Promise<void> => {
      setState((current) => ({ ...current, note: undefined }));
      try {
        await api.deleteRunnerCommand(cwd, item.id);
        setState((current) => ({ ...current, deletingId: undefined }));
        await load();
      } catch (caught) {
        const status = caught instanceof ApiError ? caught.status : 0;
        const message = caught instanceof ApiError ? caught.message : undefined;
        setState((current) => ({
          ...current,
          deletingId: undefined,
          note: runErrorMessage(status, message),
        }));
      }
    },
    [api, cwd, load],
  );

  const actions: RunnerActions = {
    onRetry: () => void load(),
    onRun: (item) => {
      // Perintah yang belum pernah dikonfirmasi meminta persetujuan dulu.
      if (item.confirmed) void runCommand(item, undefined);
      else setState((current) => ({ ...current, confirmId: item.id }));
    },
    onConfirmRun: (item) => void runCommand(item, true),
    onCancelConfirm: () => setState((current) => ({ ...current, confirmId: undefined })),
    onEdit: (item) =>
      setState((current) => ({
        ...current,
        confirmId: undefined,
        deletingId: undefined,
        form: {
          open: true,
          mode: "ubah",
          id: item.id,
          label: item.label,
          command: item.command,
          group: item.group ?? "",
          saving: false,
        },
      })),
    onDelete: (item) =>
      setState((current) => ({
        ...current,
        confirmId: undefined,
        deletingId: item.id,
      })),
    onConfirmDelete: (item) => void deleteCommand(item),
    onCancelDelete: () => setState((current) => ({ ...current, deletingId: undefined })),
    onOpenForm: () =>
      setState((current) => ({
        ...current,
        form: { ...EMPTY_FORM, open: true },
      })),
    onFormChange: (patch) =>
      setState((current) => ({
        ...current,
        form: {
          ...current.form,
          ...(patch.label === undefined ? {} : { label: patch.label }),
          ...(patch.command === undefined ? {} : { command: patch.command }),
          ...(patch.group === undefined ? {} : { group: patch.group }),
          error: undefined,
        },
      })),
    onSubmitForm: () => void submitForm(),
    onCancelForm: () => setState((current) => ({ ...current, form: { ...EMPTY_FORM } })),
  };

  return <RunnerView state={state} actions={actions} />;
}
