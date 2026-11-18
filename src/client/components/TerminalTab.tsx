import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import "@xterm/xterm/css/xterm.css";
import { ApiError, type ApiClient } from "../lib/api";
import { featureOffHint, openFeatureSettings, type FeatureState } from "../lib/features";
import { connectTerminal, terminalWsUrl, type TerminalSocket } from "../lib/terminal-socket";
import {
  createXtermEngine,
  type TerminalEngine,
  type TerminalEngineFactory,
} from "../lib/xterm-engine";

export interface TerminalTabProps {
  api: ApiClient;
  /** Folder kerja sesi; terminal dibuka di sini. */
  cwd: string;
  /** Terminal yang sudah ada (mis. dibuat peluncur perintah) untuk ditempel. */
  attachId?: string;
  /** Pabrik mesin terminal; bisa diganti di tes. */
  engineFactory?: TerminalEngineFactory;
  /** Pembuat soket; bisa diganti di tes. */
  connect?: typeof connectTerminal;
}

const NOTE =
  "Terminal ini memberi akses shell penuh dengan hak akunmu dan TIDAK disandbox. Env dibersihkan dari kunci Jejak. Ketikan tidak dicatat; pembukaan dan penutupan tercatat di Log audit. Mendukung program layar penuh (vim, htop). Sambungan terputus disambung ulang otomatis dengan layar dipulihkan dari riwayat terbaru (±256 KB). Tutup otomatis setelah 30 menit tanpa aktivitas.";

type State = "siap" | "membuka" | "aktif" | "selesai" | "mati";
type Conn = "menyambung" | "tersambung" | "terputus";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : "Permintaan gagal.";
}

export function TerminalTab({
  api,
  cwd,
  attachId,
  engineFactory = createXtermEngine,
  connect = connectTerminal,
}: TerminalTabProps) {
  const [state, setState] = useState<State>("siap");
  const [conn, setConn] = useState<Conn | undefined>(undefined);
  const [error, setError] = useState<string | undefined>();
  const [fitur, setFitur] = useState<FeatureState | undefined>(undefined);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<TerminalEngine | undefined>(undefined);
  const socketRef = useRef<TerminalSocket | undefined>(undefined);
  const idRef = useRef<string | undefined>(undefined);
  // Terminal yang ditempel (bukan dibuat tab ini); tidak ditutup saat tab dilepas.
  const attachedRef = useRef<string | undefined>(undefined);
  // Id yang sedang ditempel pada pembukaan berikutnya.
  const attachRef = useRef<string | undefined>(undefined);
  const startingRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Buka otomatis hanya sekali per mount; setelah ditutup pengguna tetap lewat tombol.
  const autoOpenedRef = useRef(false);

  // Tutup terminal saat tab dilepas supaya tidak ada shell yatim.
  // Terminal yang ditempel (dari peluncur perintah) bukan milik tab ini.
  useEffect(
    () => () => {
      socketRef.current?.close();
      socketRef.current = undefined;
      engineRef.current?.dispose();
      engineRef.current = undefined;
      const id = idRef.current;
      if (id !== undefined && attachedRef.current !== id) {
        void api.closeTerminal(id).catch(() => undefined);
      }
    },
    [api],
  );

  const start = useCallback(async (): Promise<void> => {
    const host = hostRef.current;
    if (host === null) return;
    try {
      let engine = engineRef.current;
      if (engine === undefined) {
        engine = await engineFactory(host);
        engineRef.current = engine;
        engine.onData((text) => socketRef.current?.sendInput(text));
      } else {
        engine.reset();
      }
      engine.fit();

      let id: string;
      const attach = attachRef.current;
      if (attach !== undefined) {
        id = attach;
        attachedRef.current = attach;
      } else {
        const info = await api.createTerminal(cwd, { cols: engine.cols, rows: engine.rows });
        id = info.id;
      }
      idRef.current = id;

      const socket = connect({
        url: terminalWsUrl(id),
        onReset: () => engineRef.current?.reset(),
        onOutput: (bytes) => engineRef.current?.write(bytes),
        onExit: () => {
          setConn(undefined);
          setState("selesai");
        },
        onError: (message) => setError(message),
        onStatus: (status) => {
          setConn(status);
          if (status === "tersambung") {
            const current = engineRef.current;
            if (current !== undefined) {
              current.fit();
              socketRef.current?.resize(current.cols, current.rows);
            }
          }
        },
      });
      socketRef.current = socket;
      setState("aktif");
      engine.focus();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 503) {
        setState("mati");
        // Status fitur diketahui supaya tahu saklar terkunci env atau tidak.
        void api
          .getFeatures()
          .then((features) => setFitur(features.terminal))
          .catch(() => undefined);
      } else {
        setState("siap");
        setError(errorMessage(caught));
      }
    }
  }, [api, connect, cwd, engineFactory]);

  // Mulai sesi setelah host ter-render (state "membuka").
  useEffect(() => {
    if (state !== "membuka" || startingRef.current) return;
    startingRef.current = true;
    void start().finally(() => {
      startingRef.current = false;
    });
  }, [state, start]);

  // Ukuran terminal mengikuti host; resize dikirim setelah fit.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current !== undefined) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = undefined;
        const engine = engineRef.current;
        if (engine === undefined) return;
        engine.fit();
        socketRef.current?.resize(engine.cols, engine.rows);
      }, 100);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      if (resizeTimerRef.current !== undefined) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = undefined;
      }
    };
  }, [state]);

  // Permukaan terminal langsung siap diketik saat aktif.
  useEffect(() => {
    if (state === "aktif") engineRef.current?.focus();
  }, [state]);

  const open = (): void => {
    if (state === "membuka" || cwd === "") return;
    setError(undefined);
    setConn(undefined);
    attachedRef.current = undefined;
    attachRef.current = undefined;
    setState("membuka");
  };

  const close = async (): Promise<void> => {
    const id = idRef.current;
    socketRef.current?.close();
    socketRef.current = undefined;
    idRef.current = undefined;
    attachedRef.current = undefined;
    attachRef.current = undefined;
    setConn(undefined);
    setState("siap");
    if (id !== undefined) await api.closeTerminal(id).catch(() => undefined);
  };

  // Tempel ke terminal yang sudah ada (dibuat peluncur perintah).
  useEffect(() => {
    if (attachId === undefined || attachId === "") return;
    if (attachedRef.current === attachId && idRef.current === attachId) return;
    setError(undefined);
    setConn(undefined);
    attachRef.current = attachId;
    setState("membuka");
  }, [attachId]);

  // Buka sendiri saat tab muncul (sekali per mount); lewat tombol setelahnya.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (state !== "siap" || cwd === "" || (attachId !== undefined && attachId !== "")) return;
    autoOpenedRef.current = true;
    open();
  }, [state, cwd, attachId]);

  const send = (data: string): void => {
    if (state !== "aktif") return;
    socketRef.current?.sendInput(data);
  };

  if (state === "mati") {
    const hint = featureOffHint("terminal", fitur);
    return (
      <div class="jk-terminal">
        <p class="jk-note" role="status">
          {hint.text}
        </p>
        {hint.locked ? (
          <p class="jk-note">
            Jalankan Jejak dengan <code>JEJAK_TERMINAL=1</code> untuk menyalakannya.
          </p>
        ) : (
          <button
            type="button"
            class="jk-button"
            aria-label="Aktifkan terminal di Pengaturan"
            onClick={() => openFeatureSettings()}
          >
            Aktifkan di Pengaturan
          </button>
        )}
        <p class="jk-note">{NOTE}</p>
      </div>
    );
  }

  const statusText =
    state === "membuka"
      ? "Membuka…"
      : state === "aktif"
        ? conn === "terputus"
          ? "Menyambung ulang…"
          : "Aktif"
        : state === "selesai"
          ? "Selesai"
          : "";

  return (
    <div class="jk-terminal">
      <div class="jk-terminal-bar">
        <span class="jk-terminal-status" role="status">
          {state === "aktif" && conn !== "terputus" && <span class="jk-terminal-dot" aria-hidden="true" />}
          {statusText}
        </span>
        <span class="jk-terminal-actions">
          {state === "aktif" && (
            <>
              <button type="button" class="jk-link-btn" onClick={() => send("\x03")}>
                Ctrl+C
              </button>
              <button type="button" class="jk-link-btn" onClick={() => send("\x04")}>
                Ctrl+D
              </button>
            </>
          )}
          {state === "aktif" || state === "membuka" ? (
            <button type="button" class="jk-link-btn" aria-label="Tutup terminal" onClick={() => void close()}>
              Tutup
            </button>
          ) : (
            <button type="button" class="jk-link-btn" disabled={cwd === ""} onClick={() => open()}>
              {state === "selesai" ? "Buka lagi" : "Buka terminal"}
            </button>
          )}
        </span>
      </div>
      {error !== undefined && (
        <p class="jk-error-line" role="alert">
          {error}
        </p>
      )}
      <div
        ref={hostRef}
        class="jk-terminal-host"
        hidden={state === "siap"}
        role="log"
        aria-label="Terminal; ketik di sini"
        aria-live="off"
        onClick={() => engineRef.current?.focus()}
      />
      <details class="jk-terminal-info">
        <summary>Tentang terminal ini</summary>
        <p class="jk-note">{NOTE}</p>
      </details>
    </div>
  );
}
