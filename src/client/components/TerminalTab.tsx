import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient } from "../lib/api";
import { parseSse } from "../lib/sse";
import {
  applyOutput,
  base64ToText,
  emptyScreen,
  keyToInput,
  screenText,
  type Screen,
} from "../lib/terminal";

export interface TerminalTabProps {
  api: ApiClient;
  /** Folder kerja sesi; terminal dibuka di sini. */
  cwd: string;
}

const NOTE =
  "Terminal ini memberi akses shell penuh dengan hak akunmu dan TIDAK disandbox. Env dibersihkan dari kunci Jejak. Ketikan tidak dicatat; pembukaan dan penutupan tercatat di Log audit. Terminal sederhana: program layar penuh (vim, htop) belum didukung. Tutup otomatis setelah 30 menit tanpa aktivitas.";

type State = "siap" | "membuka" | "aktif" | "selesai" | "mati";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : "Permintaan gagal.";
}

export function TerminalTab({ api, cwd }: TerminalTabProps) {
  const [state, setState] = useState<State>("siap");
  const [error, setError] = useState<string | undefined>();
  const [screen, setScreen] = useState<Screen>(emptyScreen);
  const idRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const logRef = useRef<HTMLPreElement | null>(null);
  const screenRef = useRef<Screen>(emptyScreen());
  // Ketikan digabung dan dikirim berurutan agar urutan tombol tidak tertukar.
  const queueRef = useRef<string>("");
  const flushingRef = useRef(false);

  const stopStream = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = undefined;
  }, []);

  // Tutup terminal saat tab dilepas supaya tidak ada shell yatim.
  useEffect(
    () => () => {
      stopStream();
      const id = idRef.current;
      if (id !== undefined) void api.closeTerminal(id).catch(() => undefined);
    },
    [api, stopStream],
  );

  useEffect(() => {
    const element = logRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [screen]);

  const follow = async (id: string): Promise<void> => {
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`/api/terminal/${encodeURIComponent(id)}/output`, {
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) throw new ApiError("Keluaran terminal tidak tersedia.", response.status);
      for await (const frame of parseSse(response.body)) {
        if (frame.event === "exit") {
          setState("selesai");
          continue;
        }
        screenRef.current = applyOutput(screenRef.current, base64ToText(frame.data));
        setScreen(screenRef.current);
      }
    } catch (caught) {
      if (!controller.signal.aborted) setError(errorMessage(caught));
    }
  };

  const open = async (): Promise<void> => {
    if (state === "membuka" || cwd === "") return;
    setState("membuka");
    setError(undefined);
    screenRef.current = emptyScreen();
    setScreen(screenRef.current);
    try {
      const info = await api.createTerminal(cwd, { cols: 100, rows: 28 });
      idRef.current = info.id;
      setState("aktif");
      void follow(info.id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 503) {
        setState("mati");
      } else {
        setState("siap");
        setError(errorMessage(caught));
      }
    }
  };

  const close = async (): Promise<void> => {
    const id = idRef.current;
    stopStream();
    idRef.current = undefined;
    queueRef.current = "";
    setState("siap");
    if (id !== undefined) await api.closeTerminal(id).catch(() => undefined);
  };

  const flush = async (): Promise<void> => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      while (queueRef.current !== "") {
        const id = idRef.current;
        const data = queueRef.current;
        queueRef.current = "";
        if (id === undefined) return;
        await api.sendTerminalInput(id, data);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      flushingRef.current = false;
    }
  };

  const send = (data: string): void => {
    if (idRef.current === undefined || state !== "aktif") return;
    queueRef.current += data;
    void flush();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const data = keyToInput(event);
    if (data === undefined) return;
    event.preventDefault();
    send(data);
  };

  const onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text");
    if (text === undefined || text === "") return;
    event.preventDefault();
    send(text.replace(/\r?\n/g, "\r"));
  };

  if (state === "mati") {
    return (
      <div class="jk-terminal">
        <p class="jk-note" role="status">
          Terminal dimatikan. Jalankan Jejak dengan <code>JEJAK_TERMINAL=1</code> untuk menyalakannya.
        </p>
        <p class="jk-note">{NOTE}</p>
      </div>
    );
  }

  return (
    <div class="jk-terminal">
      <div class="jk-terminal-bar">
        {state === "siap" || state === "selesai" ? (
          <button type="button" class="jk-button" disabled={cwd === ""} onClick={() => void open()}>
            {state === "selesai" ? "Buka lagi" : "Buka terminal"}
          </button>
        ) : (
          <button type="button" class="jk-button" onClick={() => void close()}>
            Tutup terminal
          </button>
        )}
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
        <span class="jk-help" role="status">
          {state === "membuka" ? "Membuka…" : state === "aktif" ? "Aktif" : state === "selesai" ? "Selesai" : ""}
        </span>
      </div>
      {error !== undefined && (
        <p class="jk-error-line" role="alert">
          {error}
        </p>
      )}
      {(state === "aktif" || state === "selesai") && (
        <pre
          ref={logRef}
          class="jk-terminal-screen"
          tabIndex={0}
          role="log"
          aria-label="Terminal; ketik di sini"
          aria-live="off"
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        >
          {screenText(screen)}
        </pre>
      )}
      <p class="jk-note jk-terminal-note">{NOTE}</p>
    </div>
  );
}
