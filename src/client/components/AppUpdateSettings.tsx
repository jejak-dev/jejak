import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import {
  ConfirmDialogView,
  useConfirmDialogBindings,
  type ConfirmDialogBindings,
} from "./ConfirmDialog";
import {
  createUpdaterClient,
  desktopBridge,
  desktopErrorMessage,
  downloadPercent,
  lastCheckText,
  restartWarning,
  updaterStatusLine,
  type DesktopBridge,
  type DesktopInfo,
  type UpdaterClient,
  type UpdaterSettings,
  type UpdaterState,
  type UpdaterStatus,
} from "../lib/desktop";
import { Select } from "./Select";

export interface AppUpdateSettingsProps {
  sessions: SessionInfo[];
}

const HELP =
  "Pembaruan Jejak diambil dari kanal yang dipilih di bawah. Jejak tidak pernah memasang atau memulai ulang pembaruan tanpa klik Anda.";

const CHANNEL_HELP =
  "Kanal beta berisi versi pra-rilis yang belum tentu stabil; kanal stabil hanya versi rilis penuh.";

/** Kondisi status yang membuat tombol Periksa tidak bisa dipakai. */
function isBusyState(state: UpdaterState): boolean {
  return state === "checking" || state === "downloading" || state === "installing";
}

/** Bagian tampilan yang tidak memakai hook; mudah diperiksa dalam tes. */
export interface AppUpdateViewProps {
  info: DesktopInfo | undefined;
  settings: UpdaterSettings | undefined;
  status: UpdaterStatus | undefined;
  error: string | undefined;
  message: string | undefined;
  busy: boolean;
  confirmRestart: boolean;
  warning: string | undefined;
  now: number;
  onCheck: () => void;
  onInstall: () => void;
  onRestart: () => void;
  onConfirmRestart: () => void;
  onCancelRestart: () => void;
  onToggleAutoCheck: (checked: boolean) => void;
  onChannel: (channel: "stable" | "beta") => void;
  /** Jebakan fokus dan Escape milik modal konfirmasi. */
  dialog?: ConfirmDialogBindings;
}

export function AppUpdateView(props: AppUpdateViewProps) {
  const { info, settings, status, error, message, busy, confirmRestart, warning, now } = props;
  const state: UpdaterState = status?.state ?? "idle";
  const percent = status === undefined ? undefined : downloadPercent(status);
  const fast = isBusyState(state);
  const lastCheck = status?.lastCheck;

  return (
    <section class="jk-update" aria-labelledby="jk-update-title">
      <h2 class="jk-update-title" id="jk-update-title">
        Pembaruan aplikasi
      </h2>
      <p class="jk-help">{HELP}</p>

      {info !== undefined && <p class="jk-note">Versi Jejak {info.version}.</p>}

      <p class="jk-note" role="status" aria-live="polite">
        {status === undefined ? "Memuat status pembaruan…" : updaterStatusLine(status)}
      </p>

      {lastCheck !== undefined && (
        <p class="jk-note">Pemeriksaan terakhir: {lastCheckText(lastCheck, now)}.</p>
      )}

      <div class="jk-form-actions">
        <button
          type="button"
          class="jk-button jk-button-secondary"
          disabled={busy || fast}
          onClick={props.onCheck}
        >
          {state === "checking" ? "Memeriksa…" : "Periksa sekarang"}
        </button>
      </div>

      {state === "available" && (
        <div class="jk-update-box">
          <p class="jk-label">
            {status?.version === undefined ? "Pembaruan tersedia" : `Pembaruan ${status.version}`}
          </p>
          {status?.date !== undefined && <p class="jk-note">Dirilis {status.date.slice(0, 10)}.</p>}
          {status?.notes !== undefined && <pre class="jk-update-notes">{status.notes}</pre>}
          <div class="jk-form-actions">
            <button
              type="button"
              class="jk-button jk-button-primary"
              disabled={busy}
              onClick={props.onInstall}
            >
              {busy ? "Memasang…" : "Perbarui"}
            </button>
          </div>
        </div>
      )}

      {state === "downloading" && (
        <div class="jk-update-box">
          <div
            class="jk-update-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-label="Unduhan pembaruan"
          >
            <div class="jk-update-progress-bar" style={{ width: `${percent ?? 0}%` }} />
          </div>
          <p class="jk-note">
            {percent === undefined ? "Mengunduh…" : `Mengunduh ${percent}%`}
          </p>
        </div>
      )}

      {state === "installing" && <p class="jk-note">Pemasangan sedang berjalan…</p>}

      {state === "ready" && (
        <div class="jk-update-box">
          {warning !== undefined && (
            <p class="jk-secret-warning" role="alert">
              {warning}
            </p>
          )}
          <div class="jk-form-actions">
            <button
              type="button"
              class="jk-button jk-button-primary"
              disabled={busy}
              onClick={props.onRestart}
            >
              Mulai ulang sekarang
            </button>
          </div>
        </div>
      )}

      {state === "error" && (
        <div class="jk-update-box">
          <p class="jk-error-line" role="alert">
            {status?.error ?? "Pembaruan gagal."}
          </p>
          <div class="jk-form-actions">
            <button
              type="button"
              class="jk-button jk-button-secondary"
              disabled={busy}
              onClick={props.onCheck}
            >
              Coba lagi
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

      <div class="jk-update-settings">
        <label class="jk-radio">
          <input
            type="checkbox"
            checked={settings?.autoCheck ?? false}
            disabled={settings === undefined}
            onChange={(event) => props.onToggleAutoCheck(event.currentTarget.checked)}
          />
          <span>Periksa otomatis</span>
        </label>

        <label class="jk-label" for="jk-update-channel">
          Kanal pembaruan
        </label>
        <Select
          id="jk-update-channel"
          value={settings?.channel ?? "stable"}
          disabled={settings === undefined}
          options={[
            { value: "stable", label: "Stabil" },
            { value: "beta", label: "Beta" },
          ]}
          onChange={(value) => props.onChannel(value === "beta" ? "beta" : "stable")}
        />
        <p class="jk-help">{CHANNEL_HELP}</p>
      </div>

      <ConfirmDialogView
        open={confirmRestart}
        title="Mulai ulang sekarang?"
        message={warning}
        confirmLabel="Tetap mulai ulang"
        cancelLabel="Batal"
        busy={busy}
        idPrefix="jk-confirm-restart"
        onConfirm={props.onConfirmRestart}
        onCancel={props.onCancelRestart}
        {...(props.dialog ?? {})}
      />
    </section>
  );
}

/**
 * Kartu pembaruan aplikasi. Hanya dirender di dalam cangkang desktop; di
 * peramban biasa komponen ini mengembalikan `null` tanpa Effects apa pun.
 */
export function AppUpdateSettings({ sessions }: AppUpdateSettingsProps) {
  const bridge = desktopBridge();
  if (bridge === undefined) return null;
  return <AppUpdateCard bridge={bridge} sessions={sessions} />;
}

function AppUpdateCard({ bridge, sessions }: { bridge: DesktopBridge; sessions: SessionInfo[] }) {
  const client = useMemo<UpdaterClient>(() => createUpdaterClient(bridge), [bridge]);
  const [info, setInfo] = useState<DesktopInfo | undefined>(undefined);
  const [settings, setSettings] = useState<UpdaterSettings | undefined>(undefined);
  const [status, setStatus] = useState<UpdaterStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  // Penanda tiket supaya balasan lama tak menimpa balasan baru.
  const requestRef = useRef(0);

  const loadStatus = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    try {
      const next = await client.status();
      if (ticket !== requestRef.current) return;
      setStatus(next);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setError(desktopErrorMessage(caught));
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextInfo, nextSettings] = await Promise.all([
          client.info(),
          client.getSettings(),
        ]);
        if (cancelled) return;
        setInfo(nextInfo);
        setSettings(nextSettings);
      } catch (caught) {
        if (cancelled) return;
        setError(desktopErrorMessage(caught));
      }
    })();
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [client, loadStatus]);

  // Polling status: cepat saat pembaruan berjalan, lambat saat menganggur.
  const state: UpdaterState = status?.state ?? "idle";
  const fast = isBusyState(state);
  useEffect(() => {
    const timer = setInterval(() => {
      void loadStatus();
    }, fast ? 1000 : 30000);
    return () => clearInterval(timer);
  }, [fast, loadStatus]);

  const warning = restartWarning(sessions);

  const onCheck = (): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    void (async () => {
      try {
        const next = await client.check();
        setStatus(next);
        setMessage(
          next.state === "available"
            ? `Pembaruan ${next.version ?? ""} tersedia.`
            : next.state === "idle"
              ? "Jejak sudah versi terbaru."
              : updaterStatusLine(next),
        );
      } catch (caught) {
        setError(desktopErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    })();
  };

  const onInstall = (): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    void (async () => {
      try {
        await client.install();
        await loadStatus();
      } catch (caught) {
        setError(desktopErrorMessage(caught));
      } finally {
        setBusy(false);
      }
    })();
  };

  const restartNow = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await client.restart();
    } catch (caught) {
      setError(desktopErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const onRestart = (): void => {
    if (busy) return;
    // Bila ada yang berjalan, minta konfirmasi dulu.
    if (warning !== undefined) {
      setConfirmRestart(true);
      return;
    }
    void restartNow();
  };

  const onConfirmRestart = (): void => {
    setConfirmRestart(false);
    void restartNow();
  };

  const onCancelRestart = (): void => {
    setConfirmRestart(false);
  };

  const saveSettings = async (next: UpdaterSettings): Promise<void> => {
    const previous = settings;
    setSettings(next);
    setError(undefined);
    try {
      const saved = await client.setSettings(next);
      setSettings(saved);
    } catch (caught) {
      if (previous !== undefined) setSettings(previous);
      setError(desktopErrorMessage(caught));
    }
  };

  const onToggleAutoCheck = (checked: boolean): void => {
    if (settings === undefined) return;
    void saveSettings({ autoCheck: checked, channel: settings.channel });
  };

  const onChannel = (channel: "stable" | "beta"): void => {
    if (settings === undefined) return;
    void saveSettings({ autoCheck: settings.autoCheck, channel });
  };

  // Fokus awal, jebakan fokus, dan Escape milik modal konfirmasi restart.
  const dialog = useConfirmDialogBindings({
    open: confirmRestart,
    busy,
    tone: "default",
    onCancel: onCancelRestart,
  });

  return (
    <AppUpdateView
      info={info}
      settings={settings}
      status={status}
      error={error}
      message={message}
      busy={busy}
      confirmRestart={confirmRestart}
      warning={warning}
      now={Math.floor(Date.now() / 1000)}
      onCheck={onCheck}
      onInstall={onInstall}
      onRestart={onRestart}
      onConfirmRestart={onConfirmRestart}
      onCancelRestart={onCancelRestart}
      onToggleAutoCheck={onToggleAutoCheck}
      onChannel={onChannel}
      dialog={dialog}
    />
  );
}
