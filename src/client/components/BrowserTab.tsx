import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ApiClient } from "../lib/api";
import { featureOffHint, openFeatureSettings, type FeatureState } from "../lib/features";
import { parseSse } from "../lib/sse";
import {
  browserActivateTab,
  browserBack,
  browserClose,
  browserCloseTab,
  browserForward,
  browserFrameUrl,
  browserNavigate,
  browserNewTab,
  browserReload,
  browserStop,
  browserView,
  activeTab,
  dialogLabel,
  fitFrameSize,
  parseBrowserEvent,
  parseBrowserState,
  statusLabel,
  type BrowserActionResult,
  type BrowserFrameInfo,
  type BrowserStateInfo,
} from "../lib/browser";
import { BrowserTabStrip } from "./BrowserTabStrip";
import { BrowserToolbar } from "./BrowserToolbar";

const NOTE =
  "Browser memakai profil terpisah milik Jejak dan berjalan di latar belakang. Panel ini hanya menampilkan halaman; belum ada klik atau ketikan. Tutup browser saat tidak dipakai.";

async function readError(response: Response): Promise<string> {
  try {
    const data: unknown = await response.json();
    if (typeof data === "object" && data !== null) {
      const message = (data as { error?: unknown }).error;
      if (typeof message === "string") return message;
    }
  } catch {
    // Respons tanpa JSON; pesan bawaan dipakai.
  }
  return "";
}

export interface BrowserTabProps {
  /** Klien API; dipakai membaca status fitur saat browser mati. */
  api: ApiClient;
}

export function BrowserTab({ api }: BrowserTabProps) {
  const [status, setStatus] = useState<number | undefined>(undefined);
  const [galat, setGalat] = useState<string | undefined>(undefined);
  const [fitur, setFitur] = useState<FeatureState | undefined>(undefined);
  const [state, setState] = useState<BrowserStateInfo | undefined>(undefined);
  const [frame, setFrame] = useState<BrowserFrameInfo | undefined>(undefined);
  /** Apakah kolom URL sedang disunting (pengguna fokus)? */
  const [sunting, setSunting] = useState(false);
  /** Teks yang diketik pengguna. */
  const [ketikan, setKetikan] = useState("");
  const [busy, setBusy] = useState(false);
  const [ditutup, setDitutup] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamAktif = useRef(false);

  const stopStream = useCallback((): void => {
    streamAktif.current = false;
  }, []);

  // Aliran SSE: state lalu frame. Ditutup saat komponen dilepas atau tab diganti.
  useEffect(() => {
    const controller = new AbortController();
    streamAktif.current = true;
    void (async () => {
      try {
        const response = await fetch("/api/browser", { signal: controller.signal });
        if (!response.ok) {
          const err = await readError(response);
          setStatus(response.status);
          setGalat(err);
          if (response.status === 503) {
            // Status fitur diketahui supaya tahu saklar terkunci env atau tidak.
            void api
              .getFeatures()
              .then((features) => setFitur(features.browser))
              .catch(() => undefined);
          }
          return;
        }
        const parsed = parseBrowserState(await response.json());
        if (parsed !== undefined) setState(parsed);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setGalat(caught instanceof Error ? caught.message : "Permintaan gagal.");
      }
    })();
    void (async () => {
      try {
        const response = await fetch("/api/browser/stream", { signal: controller.signal });
        if (!response.ok) {
          const err = await readError(response);
          setStatus(response.status);
          setGalat(err);
          return;
        }
        if (response.body === null) return;
        for await (const item of parseSse(response.body)) {
          if (controller.signal.aborted) break;
          const parsed = parseBrowserEvent(item.event, item.data);
          if (parsed === undefined) continue;
          if (parsed.kind === "state") {
            // State baru menggantikan seluruh state lama (tab, viewport, dialog).
            setState(parsed.state);
          } else {
            setFrame(parsed.frame);
          }
        }
        streamAktif.current = false;
      } catch (caught) {
        if (controller.signal.aborted) return;
        setGalat(caught instanceof Error ? caught.message : "Aliran browser terputus.");
      }
    })();
    return () => {
      controller.abort();
      stopStream();
    };
  }, [streamKey, stopStream, api]);

  // Gambar frame terakhir ke kanvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || frame === undefined) return;
    const image = new Image();
    image.onload = (): void => {
      const parent = canvas.parentElement;
      const boxWidth = parent?.clientWidth ?? 0;
      const size = fitFrameSize(frame, { width: boxWidth, height: 0 });
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (context === null) return;
      context.drawImage(image, 0, 0, size.width, size.height);
    };
    image.src = browserFrameUrl(frame.data);
  }, [frame]);

  /** Jalankan aksi browser; state dari respons langsung dipakai. */
  const jalankan = useCallback(async (aksi: () => Promise<BrowserActionResult>): Promise<boolean> => {
    setBusy(true);
    try {
      const hasil = await aksi();
      if (!hasil.ok) {
        setGalat(hasil.error ?? "Permintaan gagal.");
        if (hasil.status !== undefined) setStatus(hasil.status);
        return false;
      }
      setGalat(undefined);
      setStatus(undefined);
      if (hasil.state !== undefined) setState(hasil.state);
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  const navigate = useCallback(
    async (target: string): Promise<void> => {
      const trimmed = target.trim();
      if (trimmed === "") return;
      // Aliran yang sudah terputus (mis. browser ditutup) dinyalakan lagi.
      if (!streamAktif.current) setStreamKey((key) => key + 1);
      const ok = await jalankan(() => browserNavigate(trimmed));
      // Setelah sukses, kolom URL kembali mengikuti state server.
      if (ok) setSunting(false);
    },
    [jalankan],
  );

  const closeBrowser = useCallback(async (): Promise<void> => {
    const ok = await jalankan(() => browserClose());
    if (!ok) return;
    setState(undefined);
    setFrame(undefined);
    setDitutup(true);
  }, [jalankan]);

  const onUrlInput = (value: string): void => {
    setSunting(true);
    setKetikan(value);
  };

  const onUrlFocus = (): void => {
    setSunting(true);
    setKetikan(state?.url ?? "");
  };

  const onUrlBlur = (): void => {
    setSunting(false);
  };

  const onUrlSubmit = (): void => {
    const target = sunting ? ketikan : (state?.url ?? "");
    void navigate(target);
  };

  const view = browserView({ status, message: galat, adaFrame: frame !== undefined, state });
  const dialog = dialogLabel(state?.lastDialog);

  if (view.kind === "mati") {
    const hint = featureOffHint("browser", fitur);
    return (
      <div class="jk-browser">
        <p class="jk-note" role="status">
          {hint.text}
        </p>
        {hint.locked ? (
          <p class="jk-note">
            Jalankan Jejak dengan <code>JEJAK_BROWSER=1</code> untuk menyalakannya.
          </p>
        ) : (
          <button type="button" class="jk-button" onClick={() => openFeatureSettings()}>
            Aktifkan di Pengaturan
          </button>
        )}
        <p class="jk-note">{NOTE}</p>
      </div>
    );
  }

  return (
    <div class="jk-browser">
      <BrowserToolbar
        state={state}
        editing={sunting}
        urlText={ketikan}
        onUrlInput={onUrlInput}
        onUrlFocus={onUrlFocus}
        onUrlBlur={onUrlBlur}
        onUrlSubmit={onUrlSubmit}
        onBack={() => void jalankan(browserBack)}
        onForward={() => void jalankan(browserForward)}
        onReload={() => void jalankan(browserReload)}
        onStop={() => void jalankan(browserStop)}
        onClose={() => void closeBrowser()}
      />
      <BrowserTabStrip
        tabs={state?.tabs ?? []}
        activeId={activeTab(state)?.id}
        onActivate={(id) => void jalankan(() => browserActivateTab(id))}
        onClose={(id) => void jalankan(() => browserCloseTab(id))}
        onNew={() => void jalankan(() => browserNewTab(undefined))}
      />
      {view.kind === "galat" && (
        <p class="jk-error-line" role="alert">
          {view.pesan}
        </p>
      )}
      {dialog !== "" && <p class="jk-note">{dialog}</p>}
      <div class="jk-browser-view">
        {frame === undefined ? (
          <p class="jk-note jk-browser-waiting" role="status">
            {ditutup ? "Browser ditutup." : "Menunggu frame pertama…"}
          </p>
        ) : (
          <canvas
            ref={canvasRef}
            class="jk-browser-canvas"
            aria-label="Tampilan halaman browser"
            role="img"
          />
        )}
      </div>
      <p class="jk-note jk-browser-status" role="status">
        {busy ? "Memproses…" : statusLabel(state)}
      </p>
      <p class="jk-note">{NOTE}</p>
    </div>
  );
}
