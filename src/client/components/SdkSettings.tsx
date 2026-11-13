import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { type ApiClient, type SdkCheckResult, type SdkStatus } from "../lib/api";
import {
  SDK_CONSENT_TEXT,
  SDK_TERMS_URL,
  canRollback,
  confirmationFacts,
  describeSdkError,
  sdkInstallIntent,
  sdkStatusFacts,
  sdkStatusLine,
} from "../lib/sdk";

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

  const requestRef = useRef(0);
  const installButtonRef = useRef<HTMLButtonElement>(null);
  const rollbackButtonRef = useRef<HTMLButtonElement>(null);

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

  const busy = status?.busy === true || installing || rollingBack;
  const statusFacts = status === undefined ? [] : sdkStatusFacts(status);
  const facts = candidate === undefined ? [] : confirmationFacts(candidate);

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

          {approving && (
            <div class="jk-sdk-consent">
              <p class="jk-label">Persetujuan pemasangan</p>
              {candidate === undefined ? (
                <p class="jk-note">Memeriksa versi yang tersedia di registry…</p>
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
                  <div class="jk-form-actions">
                    <button
                      type="button"
                      class="jk-button jk-button-primary"
                      disabled={installing}
                      onClick={onApprove}
                    >
                      Pasang versi {candidate.candidate}
                    </button>
                    <button
                      type="button"
                      class="jk-button jk-button-secondary"
                      disabled={installing}
                      onClick={onCancelInstall}
                    >
                      Batal
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {confirmRollback && status.previous !== null && (
            <div class="jk-sdk-consent">
              <p class="jk-help">
                Kembalikan SDK ke versi {status.previous}? Sesi baru memakai versi itu; sesi yang
                sedang berjalan tetap memakai versi sekarang.
              </p>
              <div class="jk-form-actions">
                <button
                  type="button"
                  class="jk-button jk-button-primary"
                  disabled={rollingBack}
                  onClick={onRollback}
                >
                  {rollingBack ? "Mengembalikan…" : "Ya, kembalikan"}
                </button>
                <button
                  type="button"
                  class="jk-button jk-button-secondary"
                  disabled={rollingBack}
                  onClick={onCancelRollback}
                >
                  Batal
                </button>
              </div>
            </div>
          )}

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
    </section>
  );
}
