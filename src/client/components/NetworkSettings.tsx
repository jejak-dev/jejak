import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient } from "../lib/api";
import {
  DEFAULT_NETWORK_PORT,
  MAX_NETWORK_PORT,
  MIN_NETWORK_PORT,
  NETWORK_FIREWALL_NOTE,
  NETWORK_WARNING,
  networkStatusText,
  networkUrls,
  resolveNetworkPort,
  shouldReloadNetworkStatus,
  toggleQrUrl,
  validateNetworkPort,
  type NetworkRefreshKey,
  type NetworkStatus,
} from "../lib/network-form";
import { encodeQr, qrPath } from "../lib/qr";
import { CopyButton } from "./CopyButton";

export interface NetworkSettingsViewProps {
  /** Status jaringan terakhir dari server. */
  status: NetworkStatus | undefined;
  /** Permintaan sedang berjalan. */
  busy: boolean;
  /** Galat terakhir (ditampilkan sebaris). */
  error: string | undefined;
  /** Isi kolom port. */
  port: string;
  /** Kolom port berubah. */
  onPort: (value: string) => void;
  /** Saklar akses jaringan ditekan. */
  onToggle: () => void;
  /** URL yang kodenya sedang terbuka; `undefined` bila semua tertutup. */
  qrUrl?: string | undefined;
  /** Tombol QR ditekan: buka kodenya, atau tutup bila sedang terbuka. */
  onToggleQr?: (url: string) => void;
}

/**
 * Kode QR sebagai SVG. Latar putih dan modul hitam selalu, bukan token
 * tema, supaya tetap terbaca pemindai saat aplikasi memakai mode gelap.
 */
function QrCode({ value }: { value: string }) {
  const modules = encodeQr(value);
  // Quiet zone 4 modul di tiap sisi.
  const total = modules.length + 8;
  return (
    <svg
      class="jk-qr"
      role="img"
      aria-label={`Kode QR untuk ${value}`}
      viewBox={`0 0 ${total} ${total}`}
      shape-rendering="crispEdges"
    >
      <rect x="0" y="0" width={total} height={total} fill="#ffffff" />
      <g transform="translate(4 4)">
        <path d={qrPath(modules)} fill="#000000" />
      </g>
    </svg>
  );
}

/** Tampilan bagian akses jaringan tanpa hook; dipakai uji render tanpa DOM. */
export function NetworkSettingsView(props: NetworkSettingsViewProps) {
  const status = props.status;
  const aktif = status?.enabled === true;
  const listening = status?.listening === true;
  const needsPassword = status?.passwordRequired === true;
  const urls = networkUrls(status);
  const galat = props.error ?? status?.error;

  return (
    <section class="jk-network" aria-labelledby="jk-network-title">
      <h3 class="jk-network-title" id="jk-network-title">
        Akses dari jaringan
      </h3>

      <div class="jk-network-actions">
        <button
          type="button"
          class="jk-button"
          disabled={props.busy || needsPassword}
          onClick={props.onToggle}
        >
          {aktif
            ? "Matikan akses dari perangkat lain"
            : "Izinkan akses dari perangkat lain"}
        </button>
      </div>

      {needsPassword && <p class="jk-note">Buat sandi dulu</p>}

      <div class="jk-field">
        <label class="jk-label" for="jk-network-port">
          Port
        </label>
        <input
          id="jk-network-port"
          class="jk-input"
          type="number"
          min={MIN_NETWORK_PORT}
          max={MAX_NETWORK_PORT}
          value={props.port}
          disabled={props.busy || listening}
          onInput={(event) =>
            props.onPort((event.currentTarget as HTMLInputElement).value)
          }
        />
      </div>

      <p class="jk-access-status">{networkStatusText(status)}</p>

      {urls.map((url) => (
        <div class="jk-network-url-row" key={url}>
          <div class="jk-network-url">
            <span class="jk-network-url-text">{url}</span>
            <CopyButton text={url} label={`Salin ${url}`} />
            <button
              type="button"
              class="jk-qr-toggle"
              aria-label={`Tampilkan kode QR untuk ${url}`}
              onClick={() => props.onToggleQr?.(url)}
            >
              QR
            </button>
          </div>
          {props.qrUrl === url && (
            <>
              <QrCode value={url} />
              <p class="jk-note">Pindai dari HP di jaringan yang sama.</p>
            </>
          )}
        </div>
      ))}

      {galat !== undefined && (
        <p class="jk-error-line" role="alert">
          {galat}
        </p>
      )}

      <p class="jk-note">{NETWORK_WARNING}</p>
      <p class="jk-note">{NETWORK_FIREWALL_NOTE}</p>
    </section>
  );
}

export interface NetworkSettingsProps {
  api: ApiClient;
  /**
   * Kunci pemicu muat ulang status jaringan. Nilainya berubah setiap kali
   * status sandi berubah (sandi dibuat, diganti, atau dihapus) sehingga
   * kartu ini langsung menyegarkan statusnya.
   */
  refreshKey?: NetworkRefreshKey;
}

/** Pesan galat singkat dari galat API atau galat biasa. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "Permintaan gagal.";
}

/**
 * Bagian "Akses dari jaringan" di kartu Akses & sandi: menyalakan listener
 * kedua supaya Jejak bisa dibuka dari perangkat lain di jaringan yang sama.
 */
export function NetworkSettings({ api, refreshKey = 0 }: NetworkSettingsProps) {
  const [status, setStatus] = useState<NetworkStatus | undefined>(undefined);
  // `undefined` berarti belum tahu apakah fitur ini tersedia di server.
  const [available, setAvailable] = useState<boolean | undefined>(undefined);
  const [port, setPort] = useState(String(DEFAULT_NETWORK_PORT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // URL yang kodenya terbuka; satu saja supaya tak menumpuk.
  const [qrUrl, setQrUrl] = useState<string | undefined>(undefined);
  // True kalau pengguna sendiri yang mengubah kolom port; muat ulang status
  // tak boleh menimpa isian yang sedang diketik.
  const portEdited = useRef(false);
  // Kunci pemicu yang terakhir dimuat.
  const lastRefreshKey = useRef<NetworkRefreshKey | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await api.getNetworkStatus();
      setStatus(next);
      setPort((current) =>
        resolveNetworkPort({
          serverPort: next.port,
          currentPort: current,
          edited: portEdited.current,
        }),
      );
      setAvailable(true);
      setError(undefined);
    } catch (caught) {
      // Server tanpa manajer jaringan: bagian ini tak ditampilkan.
      if (caught instanceof ApiError && caught.status === 404) {
        setAvailable(false);
        return;
      }
      setAvailable(true);
      setError(messageOf(caught));
    }
  }, [api]);

  // Muat saat mount dan tiap kali pemicu berubah (status sandi berubah).
  useEffect(() => {
    if (!shouldReloadNetworkStatus(lastRefreshKey.current, refreshKey)) return;
    lastRefreshKey.current = refreshKey;
    void load();
  }, [load, refreshKey]);

  const onPort = useCallback((value: string): void => {
    portEdited.current = true;
    setPort(value);
  }, []);

  const onToggle = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      if (status?.enabled === true) {
        setStatus(await api.setNetwork({ enabled: false }));
        return;
      }
      const parsed = validateNetworkPort(port);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      const next = await api.setNetwork({ enabled: true, port: parsed.port });
      setStatus(next);
      setPort(String(next.port));
      portEdited.current = false;
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }, [api, port, status]);

  const onToggleQr = useCallback((url: string): void => {
    setQrUrl((current) => toggleQrUrl(current, url));
  }, []);

  if (available === false) return null;

  return (
    <NetworkSettingsView
      status={status}
      busy={busy}
      error={error}
      port={port}
      onPort={onPort}
      onToggle={() => void onToggle()}
      qrUrl={qrUrl}
      onToggleQr={onToggleQr}
    />
  );
}
