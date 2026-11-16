import { useCallback, useEffect, useState } from "preact/hooks";
import type { VNode } from "preact";
import {
  ConfirmDialogView,
  useConfirmDialogBindings,
  type ConfirmDialogBindings,
} from "./ConfirmDialog";
import type { ApiClient } from "../lib/api";
import {
  claudeSyncSummaryLine,
  type ClaudeMemorySyncRun,
  type ClaudeMemorySyncState,
} from "../lib/claude-memory";

/** Penjelasan singkat yang dipakai modal konfirmasi. */
export const CLAUDE_SYNC_EXPLANATION = [
  "Memory proyek aktif akan ditulis sebagai berkas di folder memory Claude Code proyek itu, di ~/.claude/projects/….",
  "Claude Code dan Claude Desktop membaca berkas itu.",
  "Hanya berkas jejak_* yang disentuh; berkas lain di folder itu tak diubah.",
  "Memori yang memuat rahasia ditolak dan tak ditulis.",
];

export interface ClaudeMemorySyncViewProps {
  /** Status saklar terakhir dari server. */
  state: ClaudeMemorySyncState | undefined;
  /** Sedang memuat status dari server. */
  loading: boolean;
  /** Sedang menjalankan sinkron manual. */
  busy: boolean;
  /** Galat terakhir (ditampilkan sebaris). */
  error: string | undefined;
  /** Hasil sinkron manual terakhir. */
  run: ClaudeMemorySyncRun | undefined;
  /** Modal konfirmasi sedang terbuka. */
  confirmOpen: boolean;
  /** Saklar ditekan: nilai baru yang diminta. */
  onToggle: (next: boolean) => void;
  /** Konfirmasi menyalakan disetujui. */
  onConfirm: () => void;
  /** Konfirmasi dibatalkan. */
  onCancel: () => void;
  /** Sinkron manual diminta. */
  onRun: () => void;
  /** Binding fokus dan keyboard untuk modal konfirmasi. */
  dialog?: ConfirmDialogBindings;
}

/** Tampilan saklar sinkron tanpa hook; dipakai uji render tanpa DOM. */
export function ClaudeMemorySyncView(props: ClaudeMemorySyncViewProps): VNode {
  const state = props.state;
  const enabled = state?.enabled === true;
  const locked = state?.locked === true;

  return (
    <section class="jk-claude-sync" aria-labelledby="jk-claude-sync-title">
      <header class="jk-claude-head">
        <h3 class="jk-subsection-title" id="jk-claude-sync-title">
          Sinkronkan ke Claude Code
        </h3>
      </header>

      <div class="jk-claude-sync-row">
        <div class="jk-claude-sync-text">
          <p class="jk-note">
            Memory proyek aktif ditulis sebagai berkas di folder memory Claude Code proyek itu,
            lalu dibaca Claude Code dan Claude Desktop.
          </p>
          {locked && (
            <p class="jk-note">
              Dikunci oleh variabel lingkungan JEJAK_CLAUDE_SYNC. Ubah nilainya di luar Jejak,
              lalu jalankan ulang.
            </p>
          )}
          {state !== undefined && !locked && !enabled && (
            <p class="jk-note">
              Mematikan saklar tak menghapus berkas yang sudah ditulis; hapus manual bila perlu.
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          class={`jk-switch${enabled ? " jk-switch-on" : ""}`}
          aria-checked={enabled ? "true" : "false"}
          aria-label="Sinkronkan ke Claude Code"
          disabled={props.loading || locked}
          onClick={() => props.onToggle(!enabled)}
        />
      </div>

      {enabled && (
        <div class="jk-claude-sync-row">
          <button
            type="button"
            class="jk-button"
            disabled={props.busy}
            onClick={props.onRun}
          >
            {props.busy ? "Menyinkronkan…" : "Sinkronkan sekarang"}
          </button>
        </div>
      )}

      {props.run !== undefined && (
        <div class="jk-claude-sync-result">
          <p class="jk-note" role="status">
            {claudeSyncSummaryLine(props.run)}
          </p>
          {props.run.konflik.length > 0 && (
            <details class="jk-memory-problems">
              <summary class="jk-note">
                {props.run.konflik.length} berkas bentrok, tak ditimpa
              </summary>
              <ul class="jk-memory-problem-list">
                {props.run.konflik.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {props.error !== undefined && (
        <p class="jk-error-line" role="alert">
          {props.error}
        </p>
      )}

      <ConfirmDialogView
        open={props.confirmOpen}
        title="Nyalakan sinkron ke Claude Code?"
        message={
          <ul class="jk-claude-sync-list">
            {CLAUDE_SYNC_EXPLANATION.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        }
        confirmLabel="Nyalakan"
        cancelLabel="Batal"
        confirmAriaLabel="Nyalakan sinkron ke Claude Code"
        cancelAriaLabel="Batal nyalakan sinkron"
        onConfirm={props.onConfirm}
        onCancel={props.onCancel}
        {...(props.dialog ?? {})}
      />
    </section>
  );
}

function errorMessage(caught: unknown): string {
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "Permintaan gagal.";
}

/** Saklar sinkron memory ke Claude Code di halaman Memory. */
export function ClaudeMemorySync({ api }: { api: ApiClient }): VNode {
  const [state, setState] = useState<ClaudeMemorySyncState | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [run, setRun] = useState<ClaudeMemorySyncRun | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setState(await api.getClaudeMemorySync());
      setError(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (enabled: boolean): Promise<void> => {
      setBusy(true);
      try {
        setState(await api.setClaudeMemorySync(enabled));
        setError(undefined);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  // Mematikan langsung; menyalakan perlu konfirmasi karena menulis ke folder
  // Claude Code milik pengguna.
  const onToggle = (next: boolean): void => {
    setError(undefined);
    if (next) {
      setConfirmOpen(true);
      return;
    }
    void apply(false);
  };

  const onConfirm = (): void => {
    setConfirmOpen(false);
    void apply(true);
  };

  const onCancel = (): void => {
    setConfirmOpen(false);
  };

  const onRun = (): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void api
      .runClaudeMemorySync()
      .then((result) => {
        setRun(result);
      })
      .catch((caught: unknown) => {
        setError(errorMessage(caught));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const dialog = useConfirmDialogBindings({
    open: confirmOpen,
    busy: false,
    tone: "default",
    onCancel,
  });

  return (
    <ClaudeMemorySyncView
      state={state}
      loading={loading}
      busy={busy}
      error={error}
      run={run}
      confirmOpen={confirmOpen}
      onToggle={onToggle}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onRun={onRun}
      dialog={dialog}
    />
  );
}
