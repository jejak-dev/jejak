import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ApiClient } from "../lib/api";
import { DEFAULT_NETWORK_PORT } from "../lib/network-form";
import {
  CLOUDFLARED_INSTALL_COMMAND,
  TUNNEL_FORBIDDEN_MESSAGE,
  TUNNEL_POLL_MS,
  shouldPollTunnel,
  tunnelBadge,
  tunnelBadgeTone,
  tunnelErrorKind,
  tunnelErrorMessage,
  tunnelToggleReason,
  validatePublicHost,
  type TunnelStatus,
} from "../lib/tunnel-form";
import { useMobile } from "../lib/mobile";
import {
  ConfirmDialogView,
  useConfirmDialogBindings,
  type ConfirmDialogBindings,
} from "./ConfirmDialog";
import { StatusBadge } from "./StatusBadge";

export interface TunnelSettingsViewProps {
  /** Status tunnel terakhir dari server. */
  status: TunnelStatus | undefined;
  /** True bila akses dari jaringan sudah menyala. */
  networkEnabled: boolean;
  /** Port listener jaringan; dipakai pada langkah panduan. */
  networkPort: number;
  /** Permintaan sedang berjalan. */
  busy: boolean;
  /** Galat terakhir (ditampilkan sebaris). */
  error: string | undefined;
  /** True bila perubahan hanya boleh dari komputer server (403) atau layar ponsel. */
  readOnly: boolean;
  /** Isi kolom hostname publik. */
  publicHost: string;
  /** Isi kolom token; selalu dikosongkan setelah dikirim. */
  token: string;
  /** Kolom hostname berubah. */
  onPublicHost: (value: string) => void;
  /** Kolom token berubah. */
  onToken: (value: string) => void;
  /** Tombol "Aktifkan" / "Matikan" ditekan. */
  onToggle: () => void;
  /** Tombol "Hapus token" ditekan. */
  onDeleteToken: () => void;
  /** Modal konfirmasi hapus token terbuka. */
  confirmOpen: boolean;
  /** Hapus token disetujui. */
  onConfirmDelete: () => void;
  /** Hapus token dibatalkan. */
  onCancelDelete: () => void;
  /** Binding fokus dan keyboard untuk modal konfirmasi. */
  dialog?: ConfirmDialogBindings;
  /** True bila server berjalan tanpa sandi sehingga tunnel tak bisa dinyalakan. */
  authDisabled?: boolean;
}

/** Tampilan bagian tunnel tanpa hook; dipakai uji render tanpa DOM. */
export function TunnelSettingsView(props: TunnelSettingsViewProps) {
  const status = props.status;
  const aktif = status?.enabled === true;
  const alasan = tunnelToggleReason({
    networkEnabled: props.networkEnabled,
    installed: status?.installed === true,
    publicHost: props.publicHost,
    hasToken: status?.hasToken === true,
    token: props.token,
    authDisabled: props.authDisabled === true,
  });
  const galat = props.error ?? status?.error;

  return (
    <section class="jk-access-block" aria-labelledby="jk-tunnel-title">
      <div class="jk-access-block-head">
        <h3 class="jk-access-block-title" id="jk-tunnel-title">
          Akses dari mana saja (Cloudflare)
        </h3>
        <StatusBadge label={tunnelBadge(status)} tone={tunnelBadgeTone(status)} />
      </div>

      <p class="jk-note">
        Tunnel Cloudflare membuka Jejak ke internet lewat hostname milikmu, tanpa membuka port
        di jaringan.
      </p>
      <ol class="jk-note">
        <li>Buat tunnel di dashboard Cloudflare.</li>
        <li>
          Arahkan hostname ke <code>http://localhost:{props.networkPort}</code>.
        </li>
        <li>Tempel token tunnel di sini.</li>
      </ol>

      {status?.url !== undefined && (
        <div class="jk-network-url">
          <a class="jk-network-url-text" href={status.url} target="_blank" rel="noreferrer">
            {status.url}
          </a>
        </div>
      )}

      {galat !== undefined && (
        <p class="jk-error-line" role="alert">
          {galat}
        </p>
      )}

      {status?.lastLine !== undefined && <p class="jk-note">{status.lastLine}</p>}

      {props.readOnly ? (
        <p class="jk-note">{TUNNEL_FORBIDDEN_MESSAGE}</p>
      ) : (
        <>
          <div class="jk-field">
            <label class="jk-label" for="jk-tunnel-host">
              Hostname publik
            </label>
            <input
              id="jk-tunnel-host"
              class="jk-input"
              type="text"
              autoComplete="off"
              placeholder="jejak.contoh.com"
              value={props.publicHost}
              disabled={props.busy}
              onInput={(event) =>
                props.onPublicHost((event.currentTarget as HTMLInputElement).value)
              }
            />
          </div>

          <div class="jk-field">
            <label class="jk-label" for="jk-tunnel-token">
              Token tunnel
            </label>
            <input
              id="jk-tunnel-token"
              class="jk-input"
              type="password"
              autoComplete="off"
              placeholder={status?.hasToken === true ? "Token tersimpan" : ""}
              value={props.token}
              disabled={props.busy}
              onInput={(event) => props.onToken((event.currentTarget as HTMLInputElement).value)}
            />
          </div>

          <div class="jk-network-actions">
            <button
              type="button"
              class="jk-button"
              disabled={props.busy || (!aktif && alasan !== undefined)}
              onClick={props.onToggle}
            >
              {aktif ? "Matikan" : "Aktifkan"}
            </button>
            {status?.hasToken === true && (
              <button
                type="button"
                class="jk-button jk-button-danger"
                disabled={props.busy}
                onClick={props.onDeleteToken}
              >
                Hapus token
              </button>
            )}
          </div>

          {!aktif && alasan !== undefined && <p class="jk-note jk-access-reason">{alasan}</p>}
          {status?.installed === false && (
            <p class="jk-note">Pasang dengan: {CLOUDFLARED_INSTALL_COMMAND}</p>
          )}
        </>
      )}

      <ConfirmDialogView
        open={props.confirmOpen}
        title="Hapus token tunnel?"
        message={
          <p class="jk-note">
            Tunnel dimatikan dan token dihapus dari komputer ini. Kamu perlu menempel token baru
            untuk menyalakannya lagi.
          </p>
        }
        confirmLabel="Hapus token"
        cancelLabel="Batal"
        confirmAriaLabel="Hapus token tunnel"
        cancelAriaLabel="Batal hapus token tunnel"
        tone="danger"
        busy={props.busy}
        onConfirm={props.onConfirmDelete}
        onCancel={props.onCancelDelete}
        {...(props.dialog ?? {})}
      />
    </section>
  );
}

export interface TunnelSettingsProps {
  api: ApiClient;
  /** True bila server berjalan tanpa sandi; tombol nonaktif dengan alasan. */
  authDisabled?: boolean;
}

/**
 * Bagian "Akses dari mana saja" di kartu Akses & sandi: menyalakan Cloudflare
 * Tunnel ke listener jaringan. Token tak pernah ditampilkan ulang.
 */
export function TunnelSettings({ api, authDisabled = false }: TunnelSettingsProps) {
  const [status, setStatus] = useState<TunnelStatus | undefined>(undefined);
  // `undefined` berarti belum tahu apakah fitur ini tersedia di server.
  const [available, setAvailable] = useState<boolean | undefined>(undefined);
  const [networkEnabled, setNetworkEnabled] = useState(false);
  const [networkPort, setNetworkPort] = useState(DEFAULT_NETWORK_PORT);
  const [publicHost, setPublicHost] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [forbidden, setForbidden] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Bagian terlihat di layar; polling hanya berjalan selama true.
  const [visible, setVisible] = useState(true);
  const sectionRef = useRef<HTMLDivElement | null>(null);
  // True kalau pengguna sendiri yang mengubah kolom hostname.
  const hostEdited = useRef(false);
  const mobile = useMobile();

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await api.getTunnel();
      setStatus(next);
      setPublicHost((current) => {
        if (hostEdited.current) return current;
        return next.publicHost ?? current;
      });
      setAvailable(true);
      setError(undefined);
    } catch (caught) {
      // Server tanpa manajer tunnel: bagian ini tak ditampilkan.
      if (tunnelErrorKind(caught) === "unavailable") {
        setAvailable(false);
        return;
      }
      setAvailable(true);
      setError(tunnelErrorMessage(caught));
    }
  }, [api]);

  const loadNetwork = useCallback(async (): Promise<void> => {
    try {
      const next = await api.getNetworkStatus();
      setNetworkEnabled(next.enabled === true);
      setNetworkPort(next.port);
    } catch {
      // Status jaringan tak tersedia: syarat dianggap belum lengkap.
      setNetworkEnabled(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
    void loadNetwork();
  }, [load, loadNetwork]);

  // Polling ringan hanya selama bagian terlihat dan tunnel menyala.
  useEffect(() => {
    if (!shouldPollTunnel({ visible, enabled: status?.enabled === true })) return;
    const timer = setInterval(() => {
      void load();
    }, TUNNEL_POLL_MS);
    return () => clearInterval(timer);
  }, [load, status?.enabled, visible]);

  // Pantau apakah bagian masih terlihat; tanpa IntersectionObserver dianggap terlihat.
  useEffect(() => {
    const node = sectionRef.current;
    if (node === null || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setVisible(entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onPublicHost = useCallback((value: string): void => {
    hostEdited.current = true;
    setPublicHost(value);
  }, []);

  const onToggle = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      if (status?.enabled === true) {
        setStatus(await api.putTunnel({ enabled: false }));
        return;
      }
      const host = validatePublicHost(publicHost);
      if (!host.ok) {
        setError(host.error);
        return;
      }
      const trimmed = token.trim();
      const next = await api.putTunnel({
        enabled: true,
        publicHost: host.host,
        ...(trimmed === "" ? {} : { token: trimmed }),
      });
      setStatus(next);
      setPublicHost(next.publicHost ?? host.host);
      hostEdited.current = false;
      // Token tak disimpan di state setelah dikirim.
      setToken("");
    } catch (caught) {
      if (tunnelErrorKind(caught) === "forbidden") setForbidden(true);
      setError(tunnelErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [api, publicHost, status, token]);

  const onConfirmDelete = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await api.deleteTunnelToken());
      setToken("");
      setConfirmOpen(false);
    } catch (caught) {
      if (tunnelErrorKind(caught) === "forbidden") setForbidden(true);
      setError(tunnelErrorMessage(caught));
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  }, [api]);

  const onCancelDelete = useCallback((): void => {
    if (busy) return;
    setConfirmOpen(false);
  }, [busy]);

  const dialog = useConfirmDialogBindings({
    open: confirmOpen,
    busy,
    tone: "danger",
    onCancel: onCancelDelete,
  });

  if (available === false) return null;

  return (
    <div ref={sectionRef}>
      <TunnelSettingsView
        status={status}
        networkEnabled={networkEnabled}
        networkPort={networkPort}
        busy={busy}
        error={error}
        readOnly={forbidden || mobile}
        publicHost={publicHost}
        token={token}
        onPublicHost={onPublicHost}
        onToken={setToken}
        onToggle={() => void onToggle()}
        onDeleteToken={() => setConfirmOpen(true)}
        confirmOpen={confirmOpen}
        onConfirmDelete={() => void onConfirmDelete()}
        onCancelDelete={onCancelDelete}
        dialog={dialog}
        authDisabled={authDisabled}
      />
    </div>
  );
}

