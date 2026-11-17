import { h, type ComponentChild } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type { ApiClient } from "../lib/api";
import {
  PASSWORD_DESKTOP_ONLY_NOTE,
  isAuthDisabledError,
  passwordStatusText,
  validatePasswordForm,
  type PasswordStatus,
} from "../lib/password-form";
import {
  ConfirmDialogView,
  useConfirmDialogBindings,
  type ConfirmDialogBindings,
} from "./ConfirmDialog";
import { NetworkSettings } from "./NetworkSettings";
import { TunnelSettings } from "./TunnelSettings";

export interface AccessSettingsViewProps {
  /** Status sandi terakhir dari server. */
  status: PasswordStatus | undefined;
  /** Sedang memuat status dari server. */
  loading: boolean;
  /** Galat terakhir (ditampilkan sebaris). */
  error: string | undefined;
  /** Kabar berhasil terakhir. */
  notice: string | undefined;
  /** Isi kolom sandi lama. */
  current: string;
  /** Isi kolom sandi baru. */
  password: string;
  /** Isi kolom ulangan sandi. */
  repeat: string;
  /** Isi kolom sandi lama pada modal hapus. */
  deletePassword: string;
  /** Permintaan sedang berjalan. */
  busy: boolean;
  /** Modal hapus sandi terbuka. */
  confirmOpen: boolean;
  /** Galat pada modal hapus sandi. */
  dialogError: string | undefined;
  /** Kolom sandi lama berubah. */
  onCurrent: (value: string) => void;
  /** Kolom sandi baru berubah. */
  onPassword: (value: string) => void;
  /** Kolom ulangan sandi berubah. */
  onRepeat: (value: string) => void;
  /** Kolom sandi lama pada modal berubah. */
  onDeletePassword: (value: string) => void;
  /** Formulir dikirim. */
  onSubmit: (event: Event) => void;
  /** Tombol "Hapus sandi" ditekan. */
  onRequestDelete: () => void;
  /** Hapus sandi disetujui. */
  onConfirmDelete: () => void;
  /** Hapus sandi dibatalkan. */
  onCancelDelete: () => void;
  /** Binding fokus dan keyboard untuk modal konfirmasi. */
  dialog?: ConfirmDialogBindings;
  /** True bila server berjalan tanpa sandi; formulir sandi disembunyikan. */
  authDisabled?: boolean;
  /** Isi bagian akses jaringan (disisipkan setelah formulir sandi). */
  network?: ComponentChild;
  /** Isi bagian tunnel Cloudflare (disisipkan setelah akses jaringan). */
  tunnel?: ComponentChild;
}

/** Tampilan kartu Akses & sandi tanpa hook; dipakai uji render tanpa DOM. */
export function AccessSettingsView(props: AccessSettingsViewProps) {
  const replacing = props.status?.configured === true;
  const authDisabled = props.authDisabled === true;
  // Galat mentah "autentikasi tidak aktif" diganti catatan netral.
  const showError = props.error !== undefined && !authDisabled;

  return (
    <section class="jk-access-settings" aria-labelledby="jk-access-title">
      <h2 class="jk-access-title" id="jk-access-title">
        Akses &amp; sandi
      </h2>
      <p class="jk-help">
        Sandi dipakai untuk masuk dari peramban atau perangkat lain. Aplikasi desktop ini tetap
        masuk otomatis.
      </p>

      <section class="jk-access-block" aria-labelledby="jk-access-password-title">
        <h3 class="jk-access-block-title" id="jk-access-password-title">
          Sandi
        </h3>

        {!authDisabled && <p class="jk-access-status">{passwordStatusText(props.status)}</p>}

        {props.loading && !showError && !authDisabled && (
          <p class="jk-note">Memuat status sandi…</p>
        )}

        {authDisabled && <p class="jk-note">{PASSWORD_DESKTOP_ONLY_NOTE}</p>}

        {showError && (
          <p class="jk-error-line" role="alert">
            {props.error}
          </p>
        )}

        {props.notice !== undefined && (
          <p class="jk-note" role="status">
            {props.notice}
          </p>
        )}

        {!authDisabled && (
          <form class="jk-access-form" onSubmit={props.onSubmit}>
            {replacing && (
              <div class="jk-field">
                <label class="jk-label" for="jk-access-current">
                  Sandi lama
                </label>
                <input
                  id="jk-access-current"
                  class="jk-input"
                  type="password"
                  autoComplete="off"
                  value={props.current}
                  onInput={(event) =>
                    props.onCurrent((event.currentTarget as HTMLInputElement).value)
                  }
                />
              </div>
            )}

            <div class="jk-field">
              <label class="jk-label" for="jk-access-password">
                {replacing ? "Sandi baru" : "Sandi"}
              </label>
              <input
                id="jk-access-password"
                class="jk-input"
                type="password"
                autoComplete="new-password"
                value={props.password}
                onInput={(event) =>
                  props.onPassword((event.currentTarget as HTMLInputElement).value)
                }
              />
            </div>

            <div class="jk-field">
              <label class="jk-label" for="jk-access-repeat">
                Ulangi sandi
              </label>
              <input
                id="jk-access-repeat"
                class="jk-input"
                type="password"
                autoComplete="new-password"
                value={props.repeat}
                onInput={(event) =>
                  props.onRepeat((event.currentTarget as HTMLInputElement).value)
                }
              />
            </div>

            <div class="jk-access-actions">
              <button type="submit" class="jk-button jk-button-primary" disabled={props.busy}>
                {replacing ? "Ganti sandi" : "Buat sandi"}
              </button>
              {replacing && (
                <button
                  type="button"
                  class="jk-button jk-button-danger"
                  disabled={props.busy}
                  onClick={props.onRequestDelete}
                >
                  Hapus sandi
                </button>
              )}
            </div>
          </form>
        )}
      </section>

      {props.network}
      {props.tunnel}

      <ConfirmDialogView
        open={props.confirmOpen}
        title="Hapus sandi?"
        message={
          <div class="jk-field">
            <p class="jk-note">
              Sesi yang sedang aktif tetap berlaku sampai kedaluwarsa. Setelah sandi dihapus,
              masuk dari peramban tak lagi bisa memakai sandi ini.
            </p>
            <label class="jk-label" for="jk-access-delete-current">
              Sandi lama
            </label>
            <input
              id="jk-access-delete-current"
              class="jk-input"
              type="password"
              autoComplete="off"
              value={props.deletePassword}
              onInput={(event) =>
                props.onDeletePassword((event.currentTarget as HTMLInputElement).value)
              }
            />
          </div>
        }
        confirmLabel="Hapus sandi"
        cancelLabel="Batal"
        confirmAriaLabel="Hapus sandi"
        cancelAriaLabel="Batal hapus sandi"
        tone="danger"
        busy={props.busy}
        error={props.dialogError}
        onConfirm={props.onConfirmDelete}
        onCancel={props.onCancelDelete}
        {...(props.dialog ?? {})}
      />
    </section>
  );
}

export interface AccessSettingsProps {
  api: ApiClient;
  /** Dipanggil setelah sandi berubah supaya status autentikasi disegarkan. */
  onAuthChanged?: () => void;
}

/**
 * Slot bagian jaringan di kartu Akses & sandi.
 *
 * Kunci pemicu ikut disertakan: begitu status sandi berubah (sandi dibuat,
 * diganti, atau dihapus) kunci berubah dan kartu jaringan langsung memuat
 * status terbaru dari server.
 */
export function accessNetworkSlot(
  api: ApiClient,
  refreshKey: number,
  authDisabled = false,
): ComponentChild {
  return h(NetworkSettings, { api, refreshKey, authDisabled });
}

/** Slot bagian tunnel Cloudflare di kartu Akses & sandi. */
export function accessTunnelSlot(api: ApiClient, authDisabled = false): ComponentChild {
  return h(TunnelSettings, { api, authDisabled });
}

/** Pesan galat singkat dari galat API atau galat biasa. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "Permintaan gagal.";
}

/** Kartu Akses & sandi di halaman Pengaturan: buat, ganti, dan hapus sandi. */
export function AccessSettings({ api, onAuthChanged }: AccessSettingsProps) {
  const [status, setStatus] = useState<PasswordStatus | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | undefined>(undefined);
  const [deletePassword, setDeletePassword] = useState("");
  // True bila server berjalan tanpa autentikasi (404 "autentikasi tidak aktif").
  const [authDisabled, setAuthDisabled] = useState(false);
  // Kunci pemicu status jaringan; naik setiap kali sandi berubah.
  const [networkRefreshKey, setNetworkRefreshKey] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setStatus(await api.getPasswordStatus());
      setError(undefined);
      setAuthDisabled(false);
    } catch (caught) {
      if (isAuthDisabledError(caught)) {
        // Server tanpa sandi: bukan galat pengguna, tampilkan catatan netral.
        setAuthDisabled(true);
        setStatus(undefined);
        setError(undefined);
      } else {
        setError(messageOf(caught));
      }
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const replacing = status?.configured === true;

  const onSubmit = useCallback(
    async (event: Event): Promise<void> => {
      event.preventDefault();
      const result = validatePasswordForm({ current, password, repeat }, { replacing });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBusy(true);
      setError(undefined);
      setNotice(undefined);
      try {
        await api.setPassword({
          password: result.password,
          ...(result.current === undefined ? {} : { current: result.current }),
        });
        setCurrent("");
        setPassword("");
        setRepeat("");
        setNotice(replacing ? "Sandi diganti." : "Sandi dibuat.");
        await load();
        setNetworkRefreshKey((value) => value + 1);
        onAuthChanged?.();
      } catch (caught) {
        setError(messageOf(caught));
      } finally {
        setBusy(false);
      }
    },
    [api, current, load, onAuthChanged, password, repeat, replacing],
  );

  const onConfirmDelete = useCallback(async (): Promise<void> => {
    if (deletePassword === "") {
      setDialogError("Sandi lama belum diisi.");
      return;
    }
    setBusy(true);
    setDialogError(undefined);
    try {
      await api.clearPassword(deletePassword);
      setConfirmOpen(false);
      setDeletePassword("");
      setCurrent("");
      setPassword("");
      setRepeat("");
      setNotice("Sandi dihapus.");
      await load();
      setNetworkRefreshKey((value) => value + 1);
      onAuthChanged?.();
    } catch (caught) {
      setDialogError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }, [api, deletePassword, load, onAuthChanged]);

  const onCancelDelete = useCallback((): void => {
    if (busy) return;
    setConfirmOpen(false);
    setDialogError(undefined);
  }, [busy]);

  const onRequestDelete = useCallback((): void => {
    setDialogError(undefined);
    setConfirmOpen(true);
  }, []);

  const dialog = useConfirmDialogBindings({
    open: confirmOpen,
    busy,
    tone: "danger",
    initialFocusSelector: "#jk-access-delete-current",
    onCancel: onCancelDelete,
  });

  return (
    <AccessSettingsView
      status={status}
      loading={loading}
      error={error}
      notice={notice}
      current={current}
      password={password}
      repeat={repeat}
      deletePassword={deletePassword}
      busy={busy}
      confirmOpen={confirmOpen}
      dialogError={dialogError}
      onCurrent={setCurrent}
      onPassword={setPassword}
      onRepeat={setRepeat}
      onDeletePassword={setDeletePassword}
      onSubmit={(event) => void onSubmit(event)}
      onRequestDelete={onRequestDelete}
      onConfirmDelete={() => void onConfirmDelete()}
      onCancelDelete={onCancelDelete}
      dialog={dialog}
      authDisabled={authDisabled}
      network={accessNetworkSlot(api, networkRefreshKey, authDisabled)}
      tunnel={accessTunnelSlot(api, authDisabled)}
    />
  );
}
