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
  browserSendInput,
  browserSetViewport,
  browserStop,
  browserView,
  activeTab,
  clampViewportSize,
  copySelectionToClipboard,
  dialogLabel,
  fitFrameSize,
  keyEventFrom,
  mouseEventFrom,
  parseBrowserEvent,
  parseBrowserState,
  statusLabel,
  textEvent,
  InputBatcher,
  type BrowserActionResult,
  type BrowserCanvasRect,
  type BrowserFrameInfo,
  type BrowserInputEvent,
  type BrowserStateInfo,
  type BrowserViewportInfo,
} from "../lib/browser";
import { BrowserAgentChip } from "./BrowserAgentChip";
import { BrowserTabStrip } from "./BrowserTabStrip";
import { BrowserToolbar } from "./BrowserToolbar";

const NOTE =
  "Browser memakai profil terpisah milik Jejak dan berjalan di latar belakang. Klik layar untuk mengendalikan halaman (klik, gulir, ketik). Tutup browser saat tidak dipakai.";

/** Pesan umum saat input gagal terkirim (isi input tak boleh ikut tampil). */
const PESAN_INPUT_GAGAL = "Gagal mengirim input ke browser";

/** Pesan umum saat salin gagal (isi halaman tak boleh ikut tampil). */
const PESAN_SALIN_GAGAL = "Gagal menyalin teks dari browser";

/** Jeda diam sebelum ukuran tampilan dikirim (ms). */
const VIEWPORT_DEBOUNCE_MS = 250;

/** Ukuran tampilan cadangan bila server belum melapor. */
const VIEWPORT_BAWAAN: BrowserViewportInfo = { width: 1280, height: 800 };

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
  /** Sudah ada frame? (dipakai untuk memount kanvas) */
  const adaFrame = frame !== undefined;
  /** Ukuran tampilan halaman menurut server. */
  const viewport = state?.viewport;
  /** Apakah kolom URL sedang disunting (pengguna fokus)? */
  const [sunting, setSunting] = useState(false);
  /** Teks yang diketik pengguna. */
  const [ketikan, setKetikan] = useState("");
  const [busy, setBusy] = useState(false);
  const [ditutup, setDitutup] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  /** Apakah kanvas sedang fokus (mode kontrol aktif)? */
  const [fokus, setFokus] = useState(false);
  /** Pesan galat input yang ditampilkan sebaris (sekali saja). */
  const [galatInput, setGalatInput] = useState<string | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamAktif = useRef(false);
  /** Pengumpul event input; dibuat sekali saat komponen hidup. */
  const batcherRef = useRef<InputBatcher | undefined>(undefined);
  /** Galat yang sudah ditampilkan (tak diulang). */
  const galatTampil = useRef(new Set<string>());
  /** Ukuran tampilan terakhir yang dikirim ke server. */
  const viewportTerkirim = useRef<BrowserViewportInfo | undefined>(undefined);
  /** Frame terakhir (dipakai saat menghitung ukuran tampilan). */
  const frameRef = useRef<BrowserFrameInfo | undefined>(undefined);
  /** Apakah klik kanan terakhir sudah terkirim lewat pointerdown? */
  const klikKanan = useRef(false);

  const stopStream = useCallback((): void => {
    streamAktif.current = false;
  }, []);

  /** Tampilkan pesan galat input satu kali saja. */
  const tampilGalat = useCallback((pesan: string): void => {
    if (galatTampil.current.has(pesan)) return;
    galatTampil.current.add(pesan);
    setGalatInput(pesan);
  }, []);

  // Pengumpul input: event dikirim per batch ke server.
  useEffect(() => {
    const batcher = new InputBatcher({
      send: (events: BrowserInputEvent[]) => {
        void browserSendInput(events).then((ok) => {
          if (!ok) tampilGalat(PESAN_INPUT_GAGAL);
        });
      },
    });
    batcherRef.current = batcher;
    return () => {
      batcher.dispose();
      batcherRef.current = undefined;
    };
  }, [tampilGalat]);

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

  // Simpan frame terakhir buat perhitungan ukuran tampilan.
  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

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

  // Ukuran tampilan 1:1: ukuran halaman disamakan dengan ukuran kanvas.
  // Lebar diambil dari kanvas (ikut lebar wadah); tinggi mengikuti rasio
  // frame supaya ukuran halaman dan kanvas tidak saling chase.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ukur = (): void => {
      timer = undefined;
      const bingkai = frameRef.current;
      const lebarKanvas = Math.round(canvas.clientWidth);
      if (lebarKanvas <= 0 || bingkai === undefined || bingkai.width <= 0) return;
      const tinggi = Math.round((lebarKanvas * bingkai.height) / bingkai.width);
      if (tinggi <= 0) return;
      // Ukuran diklem sama seperti server supaya koordinat klik tetap pas.
      const ukuran = clampViewportSize(lebarKanvas, tinggi);
      const sebelum = viewportTerkirim.current;
      if (sebelum !== undefined && sebelum.width === ukuran.width && sebelum.height === ukuran.height) {
        return;
      }
      viewportTerkirim.current = ukuran;
      void browserSetViewport(ukuran.width, ukuran.height);
    };
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(ukur, VIEWPORT_DEBOUNCE_MS);
    });
    observer.observe(canvas);
    ukur();
    return () => {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [adaFrame]);

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
    const ok = await jalankan(browserClose);
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

  /* ---------- Kontrol langsung di kanvas ---------- */

  /** Ukuran tampilan halaman yang dipakai untuk pemetaan koordinat. */
  const viewportSekarang = useCallback((): BrowserViewportInfo => {
    // Ukuran yang baru dikirim dipakai duluan supaya tak ada jeda dengan
    // ukuran lama (server sudah menerapkan ukuran itu).
    return viewportTerkirim.current ?? viewport ?? VIEWPORT_BAWAAN;
  }, [viewport]);

  /** Kotak kanvas dalam piksel CSS. */
  const kotakKanvas = useCallback((): BrowserCanvasRect | undefined => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, []);

  /** Kirim satu event mouse ke antrean. */
  const kirimMouse = useCallback(
    (
      type: "move" | "down" | "up" | "wheel",
      event: MouseEvent,
      clickCount?: number,
    ): void => {
      const batcher = batcherRef.current;
      const kotak = kotakKanvas();
      if (batcher === undefined || kotak === undefined) return;
      batcher.push(mouseEventFrom(type, event, kotak, viewportSekarang(), clickCount));
    },
    [kotakKanvas, viewportSekarang],
  );

  /** Salin teks pilihan halaman ke clipboard pengguna. */
  const salin = useCallback(async (): Promise<void> => {
    const ok = await copySelectionToClipboard();
    if (!ok) tampilGalat(PESAN_SALIN_GAGAL);
  }, [tampilGalat]);

  const onPointerDown = (event: PointerEvent): void => {
    // Klik di kanvas memindahkan fokus ke mode kontrol.
    canvasRef.current?.focus();
    if (event.button === 2) klikKanan.current = true;
    kirimMouse("down", event, event.detail);
    try {
      canvasRef.current?.setPointerCapture(event.pointerId);
    } catch {
      // Tangkapan pointer ditolak; seret tetap jalan tanpa tangkapan.
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.button === 2) klikKanan.current = false;
    kirimMouse("up", event, event.detail);
    try {
      canvasRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // Tangkapan pointer sudah lepas.
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    kirimMouse("move", event);
  };

  const onWheel = (event: WheelEvent): void => {
    // Gulir dialihkan ke halaman; panel jangan ikut tergulir.
    event.preventDefault();
    kirimMouse("wheel", event);
  };

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    // Klik kanan biasanya sudah terkirim lewat pointerdown/pointerup.
    if (klikKanan.current) return;
    kirimMouse("down", event);
    kirimMouse("up", event);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    const batcher = batcherRef.current;
    if (batcher === undefined) return;
    const lower = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && lower === "c") {
      event.preventDefault();
      void salin();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && lower === "v") {
      // Ditangani event paste; tak dikirim sebagai tombol.
      return;
    }
    const kirim = keyEventFrom(event);
    if (kirim === undefined) return;
    // Tab diteruskan ke halaman, tapi tak dicegat supaya fokus bisa keluar
    // dari kanvas ke panel Jejak.
    if (event.key !== "Tab") event.preventDefault();
    batcher.push(kirim);
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    const batcher = batcherRef.current;
    if (batcher === undefined) return;
    const kirim = keyEventFrom(event);
    if (kirim === undefined) return;
    event.preventDefault();
    batcher.push(kirim);
  };

  const onPaste = (event: ClipboardEvent): void => {
    event.preventDefault();
    const batcher = batcherRef.current;
    if (batcher === undefined) return;
    const teks = event.clipboardData?.getData("text") ?? "";
    const kirim = textEvent(teks);
    if (kirim === undefined) return;
    batcher.push(kirim);
  };

  const onCompositionEnd = (event: CompositionEvent): void => {
    const batcher = batcherRef.current;
    if (batcher === undefined) return;
    // Hasil IME dikirim sebagai teks utuh, bukan sebagai tombol.
    const kirim = textEvent(event.data ?? "");
    if (kirim === undefined) return;
    batcher.push(kirim);
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
      {galatInput !== undefined && (
        <p class="jk-error-line" role="alert">
          {galatInput}
        </p>
      )}
      {dialog !== "" && <p class="jk-note">{dialog}</p>}
      <BrowserAgentChip agent={state?.agent} />
      <div class="jk-browser-view">
        {frame === undefined ? (
          <p class="jk-note jk-browser-waiting" role="status">
            {ditutup ? "Browser ditutup." : "Menunggu frame pertama…"}
          </p>
        ) : (
          <canvas
            ref={canvasRef}
            class="jk-browser-canvas"
            aria-label="Layar browser, klik untuk mengendalikan"
            tabIndex={0}
            onFocus={() => setFokus(true)}
            onBlur={() => setFokus(false)}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerMove={onPointerMove}
            onWheel={onWheel}
            onContextMenu={onContextMenu}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onPaste={onPaste}
            onCompositionEnd={onCompositionEnd}
          />
        )}
      </div>
      {!fokus && frame !== undefined && (
        <p class="jk-note jk-browser-hint">Klik layar untuk mengendalikan</p>
      )}
      <p class="jk-note jk-browser-status" role="status">
        {busy ? "Memproses…" : statusLabel(state)}
      </p>
      <p class="jk-note">{NOTE}</p>
    </div>
  );
}
