import { useCallback, useEffect, useState } from "preact/hooks";
import {
  ConfirmDialogView,
  useConfirmDialogBindings,
  type ConfirmDialogBindings,
} from "./ConfirmDialog";
import type { ApiClient } from "../lib/api";
import {
  FEATURE_DESCRIPTIONS,
  FEATURE_ENV,
  FEATURE_LABELS,
  FEATURE_NAMES,
  FEATURE_RISKS,
  featureErrorMessage,
  type FeatureName,
  type FeatureStatus,
} from "../lib/features";

export interface FeatureSettingsViewProps {
  /** Status fitur terakhir dari server. */
  status: FeatureStatus | undefined;
  /** Sedang memuat status dari server. */
  loading: boolean;
  /** Galat terakhir (ditampilkan sebaris). */
  error: string | undefined;
  /** Fitur yang menunggu konfirmasi menyalakan. */
  confirm: FeatureName | undefined;
  /** Saklar ditekan: nilai baru yang diminta. */
  onToggle: (name: FeatureName, next: boolean) => void;
  /** Konfirmasi menyalakan disetujui. */
  onConfirm: () => void;
  /** Konfirmasi dibatalkan. */
  onCancel: () => void;
  /** Binding fokus dan keyboard untuk modal konfirmasi. */
  dialog?: ConfirmDialogBindings;
}

/** Tampilan kartu Fitur tanpa hook; dipakai uji render tanpa DOM. */
export function FeatureSettingsView(props: FeatureSettingsViewProps) {
  const confirm = props.confirm;
  const tone = confirm === "terminal" ? "danger" : "default";

  return (
    <section class="jk-feature-settings" aria-labelledby="jk-feature-title">
      <h2 class="jk-feature-title" id="jk-feature-title">
        Fitur
      </h2>
      <p class="jk-help">
        Saklar berlaku untuk Jejak yang sedang berjalan. Mematikan fitur menutup sesi atau
        proses yang sedang berjalan. Perubahan dicatat di Log audit.
      </p>

      {props.loading && <p class="jk-note">Memuat fitur…</p>}

      {props.error !== undefined && (
        <p class="jk-error-line" role="alert">
          {props.error}
        </p>
      )}

      {props.status !== undefined && (
        <ul class="jk-feature-list">
          {FEATURE_NAMES.map((name) => {
            const state = props.status?.[name];
            if (state === undefined) return null;
            return (
              <li class="jk-feature-row" key={name}>
                <div class="jk-feature-text">
                  <span class="jk-feature-name">{FEATURE_LABELS[name]}</span>
                  <p class="jk-note">{FEATURE_DESCRIPTIONS[name]}</p>
                  {state.locked && (
                    <p class="jk-note">
                      Dikunci oleh variabel lingkungan {FEATURE_ENV[name]}. Ubah nilainya di luar
                      Jejak, lalu jalankan ulang.
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  class={`jk-switch${state.enabled ? " jk-switch-on" : ""}`}
                  aria-checked={state.enabled ? "true" : "false"}
                  aria-label={`${state.enabled ? "Matikan" : "Nyalakan"} ${FEATURE_LABELS[name].toLowerCase()}`}
                  disabled={state.locked}
                  onClick={() => props.onToggle(name, !state.enabled)}
                />
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialogView
        open={confirm !== undefined}
        title={confirm === undefined ? "" : `Nyalakan ${FEATURE_LABELS[confirm].toLowerCase()}?`}
        message={confirm === undefined ? undefined : FEATURE_RISKS[confirm]}
        confirmLabel="Nyalakan"
        cancelLabel="Batal"
        confirmAriaLabel={
          confirm === undefined ? "Nyalakan" : `Nyalakan ${FEATURE_LABELS[confirm].toLowerCase()}`
        }
        cancelAriaLabel="Batal nyalakan"
        tone={tone}
        onConfirm={props.onConfirm}
        onCancel={props.onCancel}
        {...(props.dialog ?? {})}
      />
    </section>
  );
}

/** Kartu Fitur di halaman Pengaturan: saklar terminal dan browser. */
export function FeatureSettings({ api }: { api: ApiClient }) {
  const [status, setStatus] = useState<FeatureStatus | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<FeatureName | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setStatus(await api.getFeatures());
      setError(undefined);
    } catch (caught) {
      setError(featureErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (name: FeatureName, next: boolean): Promise<void> => {
      try {
        setStatus(await api.putFeatures({ [name]: next }));
        setError(undefined);
      } catch (caught) {
        setError(featureErrorMessage(caught));
      }
    },
    [api],
  );

  // Mematikan langsung; menyalakan perlu konfirmasi karena memberi akses.
  const onToggle = (name: FeatureName, next: boolean): void => {
    setError(undefined);
    if (next) {
      setConfirm(name);
      return;
    }
    void apply(name, false);
  };

  const onConfirm = (): void => {
    const name = confirm;
    if (name === undefined) return;
    setConfirm(undefined);
    void apply(name, true);
  };

  const onCancel = (): void => {
    setConfirm(undefined);
  };

  const dialog = useConfirmDialogBindings({
    open: confirm !== undefined,
    busy: false,
    tone: confirm === "terminal" ? "danger" : "default",
    onCancel,
  });

  return (
    <FeatureSettingsView
      status={status}
      loading={loading}
      error={error}
      confirm={confirm}
      onToggle={onToggle}
      onConfirm={onConfirm}
      onCancel={onCancel}
      dialog={dialog}
    />
  );
}
