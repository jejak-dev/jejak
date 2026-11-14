import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ApiClient } from "../lib/api";
import { featureOffHint, openFeatureSettings, type FeatureState } from "../lib/features";
import { parseSse } from "../lib/sse";
import {
  browserErrorText,
  browserFrameUrl,
  browserStatusText,
  browserView,
  fitFrameSize,
  parseBrowserEvent,
  parseBrowserState,
  type BrowserFrameInfo,
  type BrowserStateInfo,
} from "../lib/browser";

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
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [fitur, setFitur] = useState<FeatureState | undefined>(undefined);
  const [state, setState] = useState<BrowserStateInfo | undefined>(undefined);
  const [frame, setFrame] = useState<BrowserFrameInfo | undefined>(undefined);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
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
          setMessage(err);
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
        setMessage(caught instanceof Error ? caught.message : "Permintaan gagal.");
      }
    })();
    void (async () => {
      try {
        const response = await fetch("/api/browser/stream", { signal: controller.signal });
        if (!response.ok) {
          const err = await readError(response);
          setStatus(response.status);
          setMessage(err);
          return;
        }
        if (response.body === null) return;
        for await (const item of parseSse(response.body)) {
          if (controller.signal.aborted) break;
          const parsed = parseBrowserEvent(item.event, item.data);
          if (parsed === undefined) continue;
          if (parsed.kind === "state") {
            setState(parsed.state);
          } else {
            setFrame(parsed.frame);
          }
        }
        streamAktif.current = false;
      } catch (caught) {
        if (controller.signal.aborted) return;
        setMessage(caught instanceof Error ? caught.message : "Aliran browser terputus.");
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

  const navigate = async (): Promise<void> => {
    const target = url.trim();
    if (target === "" || busy) return;
    setBusy(true);
    // Aliran yang sudah terputus (mis. browser ditutup) dinyalakan lagi.
    if (!streamAktif.current) setStreamKey((key) => key + 1);
    try {
      const response = await fetch("/api/browser/navigate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      if (!response.ok) {
        const err = await readError(response);
        setStatus(response.status);
        setMessage(browserErrorText(response.status, err));
        return;
      }
      const parsed = parseBrowserState(await response.json());
      if (parsed !== undefined) setState(parsed);
      setStatus(undefined);
      setMessage(undefined);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Permintaan gagal.");
    } finally {
      setBusy(false);
    }
  };

  const closeBrowser = async (): Promise<void> => {
    try {
      const response = await fetch("/api/browser", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        const err = await readError(response);
        setMessage(browserErrorText(response.status, err));
        return;
      }
      setState(undefined);
      setFrame(undefined);
      setStatus(undefined);
      setMessage("Browser ditutup.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Permintaan gagal.");
    }
  };

  const view = browserView({ status, message, adaFrame: frame !== undefined, state });

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
      <div class="jk-browser-bar">
        <input
          class="jk-input jk-browser-url"
          type="text"
          value={url}
          placeholder="https://example.com"
          aria-label="Alamat situs yang dibuka"
          onInput={(event) => setUrl((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void navigate();
          }}
        />
        <button
          type="button"
          class="jk-button"
          disabled={busy || url.trim() === ""}
          aria-label="Buka alamat di browser"
          onClick={() => void navigate()}
        >
          Buka
        </button>
        <button
          type="button"
          class="jk-button"
          aria-label="Tutup browser"
          onClick={() => void closeBrowser()}
        >
          Tutup browser
        </button>
        <span class="jk-help" role="status">
          {busy ? "Membuka…" : browserStatusText(state)}
        </span>
      </div>
      {view.kind === "galat" && (
        <p class="jk-error-line" role="alert">
          {view.pesan}
        </p>
      )}
      <div class="jk-browser-view">
        {frame === undefined ? (
          <p class="jk-note jk-browser-waiting" role="status">
            Menunggu frame pertama…
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
      <p class="jk-note">{NOTE}</p>
    </div>
  );
}
