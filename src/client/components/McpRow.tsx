import type { McpServerItem, McpTestOutcome } from "../lib/api";
import { describeTest, summarizeServer, type McpFormValues } from "../lib/mcp";
import { ConfirmDialog } from "./ConfirmDialog";
import { McpForm } from "./McpForm";

export interface McpRowProps {
  mcp: McpServerItem;
  editing: boolean;
  confirmingDelete: boolean;
  busy: boolean;
  testing: boolean;
  test?: McpTestOutcome;
  failure?: string;
  onToggleEnabled: (enabled: boolean) => void;
  onTest: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (form: McpFormValues) => void;
  onAskDelete: () => void;
  onCancelConfirm: () => void;
  onConfirmDelete: () => void;
}

export function McpRow({
  mcp,
  editing,
  confirmingDelete,
  busy,
  testing,
  test,
  failure,
  onToggleEnabled,
  onTest,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onAskDelete,
  onCancelConfirm,
  onConfirmDelete,
}: McpRowProps) {
  const names = mcp.transport === "stdio" ? mcp.envKeys : mcp.headerNames;
  const namesLabel = mcp.transport === "stdio" ? "env" : "header";

  return (
    <>
      <div class="jk-mcp-row" data-id={mcp.id}>
        <div class="jk-mcp-row-head">
          <span class="jk-mcp-name">{mcp.name}</span>
          <span class="jk-mcp-transport">{mcp.transport}</span>
          <span class="jk-mcp-summary" title={summarizeServer(mcp)}>
            {summarizeServer(mcp)}
          </span>
          <button
            type="button"
            class={`jk-link-btn jk-mcp-switch${mcp.enabled ? " jk-mcp-switch-on" : ""}`}
            disabled={busy}
            aria-label={`${mcp.enabled ? "Nonaktifkan" : "Aktifkan"} server ${mcp.name}`}
            aria-pressed={mcp.enabled}
            onClick={() => onToggleEnabled(!mcp.enabled)}
          >
            {mcp.enabled ? "Aktif" : "Nonaktif"}
          </button>
        </div>

        {editing ? (
          <McpForm
            initial={mcp}
            busy={busy}
            serverError={failure}
            onSubmit={onSubmitEdit}
            onCancel={onCancelEdit}
          />
        ) : (
          <div class="jk-mcp-row-body">
            {names.length > 0 && (
              <p class="jk-mcp-key-line">
                <span class="jk-mcp-key-label">{namesLabel}</span>
                {names.join(", ")}
              </p>
            )}

            {test !== undefined && (
              <p
                class={`jk-mcp-test${test.ok ? "" : " jk-mcp-test-bad"}`}
                role={test.ok ? undefined : "alert"}
              >
                {describeTest(test)}
              </p>
            )}
            {test !== undefined && test.ok && test.tools !== undefined && test.tools.length > 0 && (
              <ul class="jk-mcp-tools" aria-label={`Tool dari ${mcp.name}`}>
                {test.tools.map((tool) => (
                  <li key={tool.name} title={tool.description}>
                    {tool.name}
                  </li>
                ))}
              </ul>
            )}

            {failure !== undefined && (
              <p class="jk-error-line" role="alert">
                {failure}
              </p>
            )}

            <div class="jk-mcp-actions">
              <button
                type="button"
                class="jk-link-btn"
                disabled={busy || testing}
                aria-label={`Tes server ${mcp.name}`}
                onClick={onTest}
              >
                {testing ? "Menguji…" : "Tes"}
              </button>
              <button
                type="button"
                class="jk-link-btn"
                disabled={busy}
                aria-label={`Ubah server ${mcp.name}`}
                onClick={onStartEdit}
              >
                Ubah
              </button>
              <button
                type="button"
                class="jk-link-btn jk-mcp-danger"
                disabled={busy}
                aria-label={`Hapus server ${mcp.name}`}
                onClick={onAskDelete}
              >
                Hapus
              </button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title="Hapus server?"
        message={`Server ${mcp.name} akan dihapus dari daftar.`}
        confirmLabel="Ya"
        busyLabel="Menghapus…"
        tone="danger"
        busy={busy}
        confirmAriaLabel={`Konfirmasi hapus server ${mcp.name}`}
        cancelAriaLabel={`Batal menghapus server ${mcp.name}`}
        onConfirm={onConfirmDelete}
        onCancel={onCancelConfirm}
      />
    </>
  );
}
