import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { type ApiClient, type SdkCheckResult, type SdkCliCheck, type SdkClaude, type SdkStatus } from "../lib/api";
import {
  CLAUDE_MISSING_HINT,
  CLI_CONSENT_TEXT,
  CLI_TERMS_URL,
  SDK_CONSENT_TEXT,
  SDK_TERMS_URL,
  canRollback,
  cliConsentFacts,
  cliProgressText,
  cliStatusLine,
  claudeStatusFacts,
  claudeStatusLine,
  confirmationFacts,
  describeClaudeError,
  describeCliError,
  describeSdkError,
  formatSize,
  sdkInstallIntent,
  sdkStatusFacts,
  sdkStatusLine,
} from "../lib/sdk";
import { ConfirmDialog } from "./ConfirmDialog";

export interface SdkSettingsProps {
  api: ApiClient;
}

const NOTE =
  "SDK Anthropic dibutuhkan agar agent sungguhan berjalan. SDK tidak dibundel dengan Jejak (lisensi Anthropic) dan dipasang atas persetujuan Anda.";

export function SdkSettings({ api }: SdkSettingsProps) {
  const [status, setStatus] = useState<SdkStatus | undefined>(undefined);
  const [candidate, setCandidate] = useState<SdkCheckResult | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [approving, setApproving] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [claudePath, setClaudePath] = useState("");
  const [savingClaude, setSavingClaude] = useState(false);
  const [claudeMessage, setClaudeMessage] = useState<string | undefined>(undefined);
  const [claudeError, setClaudeError] = useState<string | undefined>(undefined);
  const [cliApproving, setCliApproving] = useState(false);
  const [cliCandidate, setCliCandidate] = useState<SdkCliCheck | undefined>(undefined);
  const [cliInstalling, setCliInstalling] = useState(false);
  const [cliRemoving, setCliRemoving] = useState(false);
  const [cliMessage, setCliMessage] = useState<string | undefined>(undefined);
  const [cliError, setCliError] = useState<string | undefined>(undefined);

  const requestRef = useRef(0);
  const installButtonRef = useRef<HTMLButtonElement>(null);
  const rollbackButtonRef = useRef<HTMLButtonElement>(null);
  const cliButtonRef = useRef<HTMLButtonElement>(null);
  // Jalur yang terakhir datang dari server; dipakai agar ketikan pengguna tak tertimpa.
  const configuredRef = useRef<string | undefined>(undefined);

  const load = useCallback(
    async (silent = false): Promise<void> => {
      requestRef.current += 1;
      const ticket = requestRef.current;
      if (!silent) setLoading(true);
      setLoadError(undefined);
      try {
        const next = await api.getSdk();
        if (ticket !== requestRef.current) return;
        setStatus(next);
        const configured = next.claude.configuredPath ?? "";
        if (configuredRef.current !== configured) {
          configuredRef.current = configured;
          setClaudePath(configured);
        }
      } catch (caught) {
        if (ticket !== requestRef.current) return;
        setLoadError(describeSdkError(caught));
      } finally {
        if (ticket === requestRef.current && !silent) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Selama pemasangan CLI berjalan, status disegarkan tiap detik supaya
  // kemajuan unduhan terlihat. Polling berhenti saat selesai atau unmount.
  useEffect(() => {
    if (!cliInstalling) return;
    const timer = setInterval(() => {
      void load(true);
    }, 1000);
    return () => clearInterval(timer);
  }, [cliInstalling, load]);

  const busy = status?.busy === true || installing || rollingBack;
  const statusFacts = status === undefined ? [] : sdkStatusFacts(status);
  const facts = candidate === undefined ? [] : confirmationFacts(candidate);
  const claudeFacts = status === undefined ? [] : claudeStatusFacts(status.claude);
  const cliBusy = cliInstalling || cliRemoving;
  const cliFacts = cliCandidate === undefined ? [] : cliConsentFacts(cliCandidate);

  const onCheck = (): void => {
    if (checking || busy) return;
    setChecking(true);
    setError(undefined);
    setMessage(undefined);
    void (async () => {
      try {
        const result = await api.checkSdk();
        setCandidate(result);
        setUpdateAvailable(result.updateAvailable);
        setMessage(
          result.updateAvailable
            ? `Di registry ada versi ${result.candidate}; versi ${result.installedVersion ?? "-"} terpasang.`
            : `Di registry versi ${result.candidate}.`,
        );
      } catch (caught) {
        setError(describeSdkError(caught));
      } finally {
        setChecking(false);
      }
    })();
  };

  /** Klik Pasang: periksa versi dulu supaya kandidat yang ditampilkan pasti yang disetujui. */
  const onRequestInstall = (): void => {
    if (checking || busy) return;
    setApproving(true);
    setCandidate(undefined);
    setChecking(true);
    setError(undefined);
    setMessage(undefined);
    void (async () => {
      try {
        const result = await api.checkSdk();
        setCandidate(result);
        setUpdateAvailable(result.updateAvailable);
      } catch (caught) {
        setApproving(false);
        setError(describeSdkError(caught));
      } finally {
        setChecking(false);
      }
    })();
  };

  const onApprove = (): void => {
    const intent = sdkInstallIntent(candidate, true);
    if (intent.kind !== "pasang") return;
    setInstalling(true);
    setError(undefined);
    setMessage(undefined);
    void (async () => {
      try {
        const result = await api.installSdk(intent.version);
        const version = result.installed?.version ?? intent.version;
        setApproving(false);
        setCandidate(undefined);
        setUpdateAvailable(false);
        setMessage(
          `Terpasang ${version}. Sesi baru memakai versi ini; sesi yang sedang berjalan tetap memakai versi lama.`,
        );
        await load(true);
      } catch (caught) {
        setError(describeSdkError(caught));
      } finally {
        setInstalling(false);
      }
    })();
  };

  const onCancelInstall = (): void => {
    setApproving(false);
    setCandidate(undefined);
    installButtonRef.current?.focus();
  };

  const onRequestRollback = (): void => {
    if (busy) return;
    setConfirmRollback(true);
    setError(undefined);
    setMessage(undefined);
  };

  const onRollback = (): void => {
    setRollingBack(true);
    setError(undefined);
    setMessage(undefined);
    void (async () => {
      try {
        const result = await api.rollbackSdk();
        const version = result.installed?.version ?? "-";
        setConfirmRollback(false);
        setUpdateAvailable(false);
        setMessage(
          `Dikembalikan ke versi ${version}. Sesi baru memakai versi ini; sesi yang sedang berjalan tetap memakai versi lama.`,
        );
        await load(true);
      } catch (caught) {
        setError(describeSdkError(caught));
      } finally {
        setRollingBack(false);
      }
    })();
  };

  const onCancelRollback = (): void => {
    setConfirmRollback(false);
    rollbackButtonRef.current?.focus();
  };

  /** Status CLI `claude` baru langsung dipasang ke state tanpa memuat ulang. */
  const applyClaude = (next: SdkClaude): void => {
    setStatus((prev) => (prev === undefined ? prev : { ...prev, claude: next }));
  };

  const onSaveClaudePath = (): void => {
    if (savingClaude) return;
    const trimmed = claudePath.trim();
    setSavingClaude(true);
    setClaudeError(undefined);
    setClaudeMessage(undefined);
    void (async () => {
      try {
        const next = await api.setClaudePath(trimmed === "" ? null : trimmed);
        applyClaude(next);
        setClaudeMessage("Jalur claude disimpan.");
        await load(true);
      } catch (caught) {
        setClaudeError(describeClaudeError(caught));
      } finally {
        setSavingClaude(false);
      }
    })();
  };

  const onClearClaudePath = (): void => {
    if (savingClaude) return;
    setSavingClaude(true);
    setClaudeError(undefined);
    setClaudeMessage(undefined);
    void (async () => {
      try {
        const next = await api.setClaudePath(null);
        applyClaude(next);
        setClaudeMessage("Pengaturan jalur claude dihapus.");
        await load(true);
      } catch (caught) {
        setClaudeError(describeClaudeError(caught));
      } finally {
        setSavingClaude(false);
      }
    })();
  };

  /** Klik Pasang CLI: periksa paket pendamping dulu sebelum meminta persetujuan. */
  const onRequestCliInstall = (): void => {
    if (cliBusy || status?.installed === null) return;
    setCliApproving(true);
    setCliCandidate(undefined);
    setCliError(undefined);
    setCliMessage(undefined);
    void (async () => {
      try {
        const result = await api.checkSdkCli();
        setCliCandidate(result);
      } catch (caught) {
        setCliApproving(false);
        setCliError(describeCliError(caught));
      }
    })();
  };

  const onApproveCli = (): void => {
    if (cliBusy) return;
    setCliInstalling(true);
    setCliError(undefined);
    setCliMessage(undefined);
    void (async () => {
      try {
        const result = await api.installSdkCli();
        const version = result.cli.installed?.version ?? "-";
        setCliApproving(false);
        setCliCandidate(undefined);
        setCliMessage(`CLI bawaan terpasang: ${version}.`);
        await load(true);
      } catch (caught) {
        setCliError(describeCliError(caught));
      } finally {
        setCliInstalling(false);
      }
    })();
  };

  const onCancelCli = (): void => {
    setCliApproving(false);
    setCliCandidate(undefined);
    cliButtonRef.current?.focus();
  };

  const onRemoveCli = (): void => {
    if (cliBusy) return;
    setCliRemoving(true);
    setCliError(undefined);
    setCliMessage(undefined);
    void (async () => {
      try {
        await api.removeSdkCli();
        setCliMessage("CLI bawaan dihapus.");
        await load(true);
      } catch (caught) {
        setCliError(describeCliError(caught));
      } finally {
        setCliRemoving(false);
      }
    })();
  };

  return (
    <section class="jk-sdk" aria-labelledby="jk-sdk-title">
      <h2 class="jk-sdk-title" id="jk-sdk-title">
        Claude Agent SDK
      </h2>
      <p class="jk-help">{NOTE}</p>

      {loading && <p class="jk-note">Memuat status SDK…</p>}

      {!loading && loadError !== undefined && (
        <>
          <p class="jk-error-line" role="alert">
            {loadError}
          </p>
          <div class="jk-form-actions">
            <button
              type="button"
              class="jk-button jk-button-secondary"
              onClick={() => void load()}
            >
              Coba lagi
            </button>
          </div>
        </>
      )}

      {!loading && loadError === undefined && status !== undefined && (
        <>
          <p class="jk-note">{sdkStatusLine(status)}</p>

          {statusFacts.length > 0 && (
            <ul class="jk-sdk-facts">
              {statusFacts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          )}

          {status.busy && (
            <p class="jk-secret-warning" role="status">
              Pemasangan sedang berjalan di server. Tunggu sebentar sebelum mencoba lagi.
            </p>
          )}

          <div class="jk-form-actions">
            <button
              ref={installButtonRef}
              type="button"
              class="jk-button jk-button-primary"
              disabled={busy || checking}
              onClick={onRequestInstall}
            >
              {installing
                ? "Mengunduh dan memverifikasi…"
                : updateAvailable
                  ? "Perbarui"
                  : "Pasang"}
            </button>
            <button
              type="button"
              class="jk-button jk-button-secondary"
              disabled={busy || checking}
              onClick={onCheck}
            >
              {checking ? "Memeriksa…" : "Periksa"}
            </button>
            {canRollback(status) && (
              <button
                ref={rollbackButtonRef}
                type="button"
                class="jk-button jk-button-secondary"
                disabled={busy}
                onClick={onRequestRollback}
              >
                Kembalikan versi sebelumnya
              </button>
            )}
          </div>

          <div class="jk-sdk-claude">
            <p class="jk-label">Claude Code (CLI)</p>
            <p class="jk-note">{claudeStatusLine(status.claude)}</p>
            {!status.claude.found && <p class="jk-help">{CLAUDE_MISSING_HINT}</p>}
            {claudeFacts.length > 0 && (
              <ul class="jk-sdk-facts">
                {claudeFacts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            )}
            <label class="jk-label" for="jk-sdk-claude-path">
              Jalur CLI claude (absolut)
            </label>
            <input
              id="jk-sdk-claude-path"
              class="jk-input jk-input-code"
              type="text"
              value={claudePath}
              placeholder="/usr/local/bin/claude"
              onInput={(event) => setClaudePath(event.currentTarget.value)}
            />
            <div class="jk-form-actions">
              <button
                type="button"
                class="jk-button jk-button-secondary"
                disabled={savingClaude}
                onClick={onSaveClaudePath}
              >
                Simpan jalur
              </button>
              {status.claude.configuredPath !== null && (
                <button
                  type="button"
                  class="jk-button jk-button-secondary"
                  disabled={savingClaude}
                  onClick={onClearClaudePath}
                >
                  Hapus pengaturan
                </button>
              )}
              <button
                type="button"
                class="jk-button jk-button-secondary"
                disabled={savingClaude}
                onClick={() => void load(true)}
              >
                Periksa lagi
              </button>
            </div>
            {claudeMessage !== undefined && (
              <p class="jk-note" role="status" aria-live="polite">
                {claudeMessage}
              </p>
            )}
            {claudeError !== undefined && (
              <p class="jk-error-line" role="alert">
                {claudeError}
              </p>
            )}

            <div class="jk-sdk-cli">
              <p class="jk-label">CLI bawaan SDK</p>
              <p class="jk-note">{cliStatusLine(status.cli)}</p>
              {status.installed === null && (
                <p class="jk-help">
                  Pasang SDK dulu di atas; CLI bawaan mengikuti versi SDK yang terpasang.
                </p>
              )}
              {!status.cli.supported && (
                <p class="jk-help">Platform ini tidak punya paket pendamping CLI.</p>
              )}
              {status.cli.installed !== null && (
                <p class="jk-note">
                  Versi {status.cli.installed.version}; ukuran terpasang{" "}
                  {formatSize(status.cli.installed.size)}.
                </p>
              )}
              {status.cli.progress !== null && (
                <p class="jk-note" role="status" aria-live="polite">
                  {cliProgressText(status.cli.progress)}
                </p>
              )}
              <div class="jk-form-actions">
                <button
                  ref={cliButtonRef}
                  type="button"
                  class="jk-button jk-button-primary"
                  disabled={
                    cliBusy ||
                    status.installed === null ||
                    !status.cli.supported
                  }
                  onClick={onRequestCliInstall}
                >
                  {cliInstalling ? "Mengunduh…" : "Pasang CLI bawaan SDK"}
                </button>
                {status.cli.installed !== null && (
                  <button
                    type="button"
                    class="jk-button jk-button-secondary"
                    disabled={cliBusy}
                    onClick={onRemoveCli}
                  >
                    {cliRemoving ? "Menghapus…" : "Hapus CLI bawaan"}
                  </button>
                )}
              </div>
              {cliMessage !== undefined && (
                <p class="jk-note" role="status" aria-live="polite">
                  {cliMessage}
                </p>
              )}
              {cliError !== undefined && (
                <p class="jk-error-line" role="alert">
                  {cliError}
                </p>
              )}
            </div>
          </div>

          {message !== undefined && (
            <p class="jk-note" role="status" aria-live="polite">
              {message}
            </p>
          )}

          {error !== undefined && (
            <p class="jk-error-line" role="alert">
              {error}
            </p>
          )}
        </>
      )}

      <ConfirmDialog
        open={approving}
        title="Pasang SDK Anthropic?"
        message={
          candidate === undefined ? (
            "Memeriksa versi yang tersedia di registry…"
          ) : (
            <>
              <ul class="jk-sdk-facts">
                {facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
              <p class="jk-help">{SDK_CONSENT_TEXT}</p>
              <p class="jk-help">
                Ketentuan Anthropic:{" "}
                <a href={SDK_TERMS_URL} target="_blank" rel="noopener noreferrer">
                  anthropic.com/legal/commercial-terms
                </a>
              </p>
            </>
          )
        }
        confirmLabel={candidate === undefined ? "Pasang" : `Pasang versi ${candidate.candidate}`}
        cancelLabel="Batal"
        busyLabel="Mengunduh…"
        busy={installing}
        confirmDisabled={candidate === undefined}
        onConfirm={onApprove}
        onCancel={onCancelInstall}
      />

      <ConfirmDialog
        open={cliApproving}
        title="Pasang CLI bawaan SDK?"
        message={
          cliCandidate === undefined ? (
            "Memeriksa paket pendamping platform…"
          ) : (
            <>
              <ul class="jk-sdk-facts">
                {cliFacts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
              <p class="jk-help">{CLI_CONSENT_TEXT}</p>
              <p class="jk-help">
                Ketentuan Anthropic:{" "}
                <a href={CLI_TERMS_URL} target="_blank" rel="noopener noreferrer">
                  code.claude.com/docs/en/legal-and-compliance
                </a>
              </p>
            </>
          )
        }
        confirmLabel="Pasang CLI bawaan"
        cancelLabel="Batal"
        busyLabel="Mengunduh…"
        busy={cliInstalling}
        confirmDisabled={cliCandidate === undefined}
        onConfirm={onApproveCli}
        onCancel={onCancelCli}
      />

      <ConfirmDialog
        open={confirmRollback && status !== undefined && status.previous !== null}
        title="Kembalikan versi sebelumnya?"
        message={
          status === undefined
            ? undefined
            : `Kembalikan SDK ke versi ${status.previous}? Sesi baru memakai versi itu; sesi yang sedang berjalan tetap memakai versi sekarang.`
        }
        confirmLabel="Ya, kembalikan"
        cancelLabel="Batal"
        busyLabel="Mengembalikan…"
        tone="danger"
        busy={rollingBack}
        onConfirm={onRollback}
        onCancel={onCancelRollback}
      />
    </section>
  );
}
