import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  CONSENT_KEY,
  DICTATION_LANG_OPTIONS,
  LANG_KEY,
  createDictation,
  defaultLang,
  describeError,
  getRecognitionCtor,
  mergeTranscript,
  type DictationController,
  type RecognitionHost,
} from "./dictation";

/** Lama pesan galat tetap tampil sebelum menghilang sendiri. */
const NOTE_TIMEOUT_MS = 6000;

export interface UseDictationOptions {
  /** Draf kolom yang sedang diisi. */
  draft: string;
  /** Setter draf kolom. */
  setDraft: (value: string) => void;
  /** Kolom sedang tidak bisa diisi (mis. sesi sedang mengirim). */
  disabled?: boolean;
}

export interface DictationState {
  /** Peramban mendukung pengenalan suara. */
  supported: boolean;
  /** Sedang merekam. */
  active: boolean;
  /** Kartu persetujuan sedang diminta. */
  askingConsent: boolean;
  /** Pengguna sudah menyetujui dikte pada peramban ini. */
  consented: boolean;
  /** Pesan singkat untuk pengguna. */
  note?: string;
  /** Bahasa dikte terpilih. */
  lang: string;
  /** Kolom sedang tidak bisa diisi. */
  disabled: boolean;
  /** Nyalakan atau matikan dikte; `caret` adalah posisi sisip di kolom. */
  toggle: (caret?: number) => void;
  /** Setuju dikte dan langsung mulai merekam. */
  acceptConsent: () => void;
  /** Batalkan persetujuan dikte. */
  cancelConsent: () => void;
  /** Ganti bahasa dikte. */
  changeLang: (lang: string) => void;
  /** Hentikan dikte yang sedang berjalan. */
  stop: () => void;
  /** Batalkan dikte dan lepas mikrofon sekaligus. */
  abort: () => void;
}

function host(): RecognitionHost | undefined {
  if (typeof window === "undefined") return undefined;
  return window as unknown as RecognitionHost;
}

function detectSupport(): boolean {
  return getRecognitionCtor(host()) !== undefined;
}

function secureContext(): boolean {
  if (typeof window === "undefined") return false;
  return window.isSecureContext === true;
}

function storage(): Storage | undefined {
  try {
    if (typeof window === "undefined") return undefined;
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readConsent(): boolean {
  try {
    return storage()?.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeConsent(): void {
  try {
    storage()?.setItem(CONSENT_KEY, "1");
  } catch {
    // Penyimpanan opsional; persetujuan tetap berlaku untuk sesi halaman ini.
  }
}

function navLang(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.language;
}

function readLang(): string {
  try {
    const stored = storage()?.getItem(LANG_KEY);
    if (
      stored !== undefined &&
      stored !== null &&
      DICTATION_LANG_OPTIONS.some((option) => option.value === stored)
    ) {
      return stored;
    }
  } catch {
    // Penyimpanan opsional; pakai bawaan.
  }
  return defaultLang(navLang());
}

function writeLang(lang: string): void {
  try {
    storage()?.setItem(LANG_KEY, lang);
  } catch {
    // Penyimpanan opsional; pilihan bahasa tetap berlaku untuk sesi halaman ini.
  }
}

/**
 * Kendali dikte suara di kolom pesan.
 *
 * Alur: klik pertama kali meminta persetujuan (karena audio bisa dikirim ke
 * server vendor peramban), lalu rekaman berjalan. Hasil final masuk ke draf
 * pada posisi kursor, hasil sementara tampil di kolom dan diganti hasil
 * final berikutnya tanpa menggandakan teks.
 */
export function useDictation({
  draft,
  setDraft,
  disabled = false,
}: UseDictationOptions): DictationState {
  const [supported] = useState(detectSupport);
  const [active, setActive] = useState(false);
  const [askingConsent, setAskingConsent] = useState(false);
  const [consented, setConsented] = useState(readConsent);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [lang, setLang] = useState(readLang);

  const controllerRef = useRef<DictationController | null>(null);
  /** Draf terikat: tanpa bagian interim hasil dikte. */
  const baseRef = useRef("");
  /** Posisi sisip teks dikte di dalam draf terikat. */
  const caretRef = useRef(0);
  /** Teks terakhir yang-hook taruh di kolom; dipakai untuk membedakan suntingan manual. */
  const shownRef = useRef("");
  const draftRef = useRef(draft);
  const langRef = useRef(lang);
  const activeRef = useRef(active);
  const pendingCaretRef = useRef<number | undefined>(undefined);
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  draftRef.current = draft;
  langRef.current = lang;
  activeRef.current = active;

  const showNote = useCallback((message: string | undefined): void => {
    if (noteTimerRef.current !== null) {
      clearTimeout(noteTimerRef.current);
      noteTimerRef.current = null;
    }
    setNote(message);
    if (message === undefined) return;
    noteTimerRef.current = setTimeout(() => {
      noteTimerRef.current = null;
      setNote(undefined);
    }, NOTE_TIMEOUT_MS);
  }, []);

  /** Sesi pengenalan suara selesai; tombol kembali ke keadaan tidak aktif. */
  const finish = useCallback((): void => {
    controllerRef.current = null;
    baseRef.current = draftRef.current;
    caretRef.current = baseRef.current.length;
    if (!mountedRef.current) return;
    setActive(false);
  }, []);

  const stop = useCallback((): void => {
    const controller = controllerRef.current;
    if (controller === null) return;
    controller.stop();
    if (!mountedRef.current) return;
    setActive(false);
  }, []);

  const abort = useCallback((): void => {
    const controller = controllerRef.current;
    if (controller === null) return;
    controller.abort();
    controllerRef.current = null;
    if (!mountedRef.current) return;
    setActive(false);
  }, []);

  const start = useCallback(
    (caret?: number): void => {
      const ctor = getRecognitionCtor(host());
      if (ctor === undefined) return;
      showNote(undefined);
      const current = draftRef.current;
      baseRef.current = current;
      caretRef.current =
        caret === undefined ? current.length : Math.max(0, Math.min(caret, current.length));
      shownRef.current = current;
      const controller = createDictation({
        ctor,
        lang: langRef.current,
        onResult: (final, interim) => {
          const merged = mergeTranscript(baseRef.current, caretRef.current, final, interim);
          shownRef.current = merged.text;
          setDraft(merged.text);
        },
        onError: (code) => {
          showNote(describeError(code));
        },
        onEnd: () => {
          finish();
        },
      });
      controllerRef.current = controller;
      controller.start();
      setActive(true);
    },
    [finish, showNote],
  );

  const toggle = useCallback(
    (caret?: number): void => {
      if (!supported) return;
      if (activeRef.current) {
        stop();
        return;
      }
      if (!secureContext()) {
        showNote("Dikte butuh HTTPS atau localhost.");
        return;
      }
      pendingCaretRef.current = caret;
      if (!consented) {
        setAskingConsent(true);
        return;
      }
      start(caret);
    },
    [consented, showNote, start, stop, supported],
  );

  const acceptConsent = useCallback((): void => {
    writeConsent();
    setConsented(true);
    setAskingConsent(false);
    start(pendingCaretRef.current);
  }, [start]);

  const cancelConsent = useCallback((): void => {
    setAskingConsent(false);
  }, []);

  const changeLang = useCallback((next: string): void => {
    const value = DICTATION_LANG_OPTIONS.some((option) => option.value === next)
      ? next
      : defaultLang(navLang());
    langRef.current = value;
    setLang(value);
    writeLang(value);
  }, []);

  // Suntingan manual di kolom: draf jadi acuan baru. Saat merekam, dikte
  // dihentikan dulu supaya teks dikte lama tidak bercampur dengan suntingan.
  useEffect(() => {
    if (draft === shownRef.current) return;
    if (activeRef.current) stop();
    baseRef.current = draft;
    caretRef.current = draft.length;
    shownRef.current = draft;
  }, [draft, stop]);

  // Esc menghentikan dikte dan menutup kartu persetujuan; mengirim pesan
  // juga menghentikannya lebih dulu.
  useEffect(() => {
    if (!active && !askingConsent) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (active) stop();
      if (askingConsent) cancelConsent();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [active, askingConsent, cancelConsent, stop]);

  useEffect(() => {
    if (!active) return;
    const onSubmit = (): void => {
      stop();
    };
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("submit", onSubmit, true);
    };
  }, [active, stop]);

  // Halaman tersembunyi: mikrofon tidak boleh menyala diam-diam.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState !== "hidden") return;
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (mountedRef.current) setActive(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Komponen dilepas: pengenal dibatalkan supaya mikrofon bebas.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (noteTimerRef.current !== null) {
        clearTimeout(noteTimerRef.current);
        noteTimerRef.current = null;
      }
    };
  }, []);

  return {
    supported,
    active,
    askingConsent,
    consented,
    note,
    lang,
    disabled,
    toggle,
    acceptConsent,
    cancelConsent,
    changeLang,
    stop,
    abort,
  };
}
