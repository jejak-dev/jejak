import { useCallback, useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../server/sessions/session-manager";
import {
  ApiError,
  type ApiClient,
  type CommandInfo,
  type CommandListResult,
  type CommandSource,
  type HeldPrompt,
  type WorkspaceItem,
} from "./lib/api";
import {
  auditHash,
  instruksiHash,
  mcpHash,
  memoryHash,
  parseHashRoute,
  providersHash,
  schedulesHash,
  sessionHash,
  usageHash,
  workspacesHash,
  type AppView,
  type SettingsSection,
} from "./lib/format";
import { parseRegistryView, type RegistryView } from "./lib/registry-view";
import {
  detectEvents,
  notificationSupport,
  playBeep,
  showNotification,
  type NotifyPrefs,
} from "./lib/notify";
import { followSession } from "./lib/sse";
import { applyCommand, filterCommands, slashContext } from "./lib/slash";
import type { ContextState } from "./lib/context";
import { applyEventBatch, type BatchEvent } from "./lib/timeline-batch";
import { startTimeline, type TimelineItem } from "./lib/timeline";
import type { RewindEvent } from "./lib/rewind";

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return "terjadi kesalahan";
}

interface Route {
  sessionId?: string;
  view?: AppView;
  section?: SettingsSection;
}

function currentRoute(): Route {
  return parseHashRoute(window.location.hash);
}

export interface HashRouteState {
  sessionId?: string;
  view?: AppView;
  /** Bagian Pengaturan yang aktif; tidak ada pada "#/providers". */
  section?: SettingsSection;
  navigateToSession: (id?: string) => void;
  navigateToProviders: () => void;
  navigateToMemory: () => void;
  navigateToWorkspaces: () => void;
  navigateToMcp: () => void;
  navigateToAudit: () => void;
  navigateToInstruksi: () => void;
  navigateToSchedules: () => void;
  navigateToUsage: () => void;
}

export function useHashRoute(): HashRouteState {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onChange = (): void => {
      setRoute(currentRoute());
    };
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);

  const applyHash = useCallback((hash: string) => {
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    setRoute(parseHashRoute(hash));
  }, []);

  const navigateToSession = useCallback(
    (id?: string) => {
      applyHash(sessionHash(id));
    },
    [applyHash],
  );

  const navigateToProviders = useCallback(() => {
    applyHash(providersHash());
  }, [applyHash]);

  const navigateToMemory = useCallback(() => {
    applyHash(memoryHash());
  }, [applyHash]);

  const navigateToWorkspaces = useCallback(() => {
    applyHash(workspacesHash());
  }, [applyHash]);

  const navigateToMcp = useCallback(() => {
    applyHash(mcpHash());
  }, [applyHash]);

  const navigateToAudit = useCallback(() => {
    applyHash(auditHash());
  }, [applyHash]);

  const navigateToInstruksi = useCallback(() => {
    applyHash(instruksiHash());
  }, [applyHash]);

  const navigateToSchedules = useCallback(() => {
    applyHash(schedulesHash());
  }, [applyHash]);

  const navigateToUsage = useCallback(() => {
    applyHash(usageHash());
  }, [applyHash]);

  return useMemo(
    () => ({
      sessionId: route.sessionId,
      view: route.view,
      section: route.section,
      navigateToSession,
      navigateToProviders,
      navigateToMemory,
      navigateToWorkspaces,
      navigateToMcp,
      navigateToAudit,
      navigateToInstruksi,
      navigateToSchedules,
      navigateToUsage,
    }),
    [
      route,
      navigateToSession,
      navigateToProviders,
      navigateToMemory,
      navigateToWorkspaces,
      navigateToMcp,
      navigateToAudit,
      navigateToInstruksi,
      navigateToSchedules,
      navigateToUsage,
    ],
  );
}

export interface InfoState {
  info?: { name: string; version: string; cwd: string; mock: boolean };
  error?: string;
}

export function useInfo(api: ApiClient): InfoState {
  const [state, setState] = useState<InfoState>({});

  useEffect(() => {
    let active = true;
    void api
      .getInfo()
      .then((info) => {
        if (active) setState({ info });
      })
      .catch((error: unknown) => {
        if (active) setState({ error: messageOf(error) });
      });
    return () => {
      active = false;
    };
  }, [api]);

  return state;
}

export interface SessionsState {
  sessions: SessionInfo[];
  error?: string;
  refresh: () => Promise<void>;
}

export function useSessions(
  api: ApiClient,
  intervalMs = 3000,
  keepPolling = false,
): SessionsState {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const requestRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const ticket = requestRef.current + 1;
    requestRef.current = ticket;
    try {
      const list = await api.listSessions();
      if (ticket !== requestRef.current) return;
      setSessions(list);
      setError(undefined);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setError(messageOf(caught));
    }
  }, [api]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = (): void => {
      if (timer !== undefined) return;
      void refresh();
      timer = setInterval(() => {
        // Saat notifikasi aktif, polling tetap jalan di tab tersembunyi agar
        // peristiwa izin/selesai tidak terlewat.
        if (keepPolling || document.visibilityState === "visible") {
          void refresh();
        }
      }, intervalMs);
    };

    const stop = (): void => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible" || keepPolling) {
        start();
      } else {
        stop();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible" || keepPolling) {
      start();
    }

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, intervalMs, keepPolling]);

  return useMemo(() => ({ sessions, error, refresh }), [sessions, error, refresh]);
}

export interface HeldPromptsState {
  held: HeldPrompt[];
  refresh: () => Promise<void>;
}

/** Selang polling saat ada tahanan yang menunggu (ms). */
const HELD_POLL_ACTIVE_MS = 3000;
/** Selang polling saat tak ada tahanan yang menunggu (ms). */
const HELD_POLL_IDLE_MS = 15000;

/**
 * Daftar prompt tertahan yang tersimpan di server.
 *
 * Tahanan dibuat server; klien hanya_memantau. Saat sebuah tahanan berubah
 * dari "menunggu" menjadi "terkirim", `onDispatched` dipanggil supaya daftar
 * sesi dimuat ulang. Galat jaringan ditelan: daftar tak berubah.
 */
export function useHeldPrompts(
  api: ApiClient,
  onDispatched?: () => void,
): HeldPromptsState {
  const [held, setHeld] = useState<HeldPrompt[]>([]);
  const requestRef = useRef(0);
  /** Status terakhir tiap tahanan; dipakai mendeteksi perubahan ke "terkirim". */
  const statusRef = useRef(new Map<string, string>());
  const dispatchedRef = useRef(onDispatched);
  dispatchedRef.current = onDispatched;

  const refresh = useCallback(async (): Promise<void> => {
    const ticket = requestRef.current + 1;
    requestRef.current = ticket;
    try {
      const list = await api.listHeld();
      if (ticket !== requestRef.current) return;
      const status = statusRef.current;
      let terkirim = false;
      for (const item of list) {
        if (status.get(item.id) === "menunggu" && item.status === "terkirim") {
          terkirim = true;
        }
        status.set(item.id, item.status);
      }
      for (const id of [...status.keys()]) {
        if (!list.some((item) => item.id === id)) status.delete(id);
      }
      setHeld(list);
      if (terkirim) dispatchedRef.current?.();
    } catch {
      // Galat jaringan ditelan; daftar lama tetap ditampilkan.
    }
  }, [api]);

  const adaMenunggu = held.some((item) => item.status === "menunggu");
  const intervalMs = adaMenunggu ? HELD_POLL_ACTIVE_MS : HELD_POLL_IDLE_MS;

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = (): void => {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void refresh();
      }, intervalMs);
    };

    const stop = (): void => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void refresh();
        start();
      } else {
        stop();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") {
      start();
    }

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, intervalMs]);

  // Muat daftar sekali saat komponen dipasang.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return useMemo(() => ({ held, refresh }), [held, refresh]);
}

export type TimelineConnection = "idle" | "terhubung" | "menyambung" | "selesai" | "galat";

export interface TimelineState {
  items: TimelineItem[];
  connection: TimelineConnection;
  status?: string;
  error?: string;
  /** Ukuran konteks terbaru (diperbarui di tengah giliran). */
  context?: ContextState;
  /** Event sesi mentah (dengan nomor urut) untuk mundur percakapan. */
  events?: RewindEvent[];
}

export interface TimelineController extends TimelineState {
  /** Muat ulang timeline dari awal (dipakai setelah mundur percakapan). */
  reload: () => void;
}

const IDLE_TIMELINE: TimelineState = { items: [], connection: "idle" };

/** Jeda maksimum event yang tertahan sebelum diterapkan ke state. */
const FLUSH_INTERVAL_MS = 50;

/** Sambung ulang hanya bila aliran sudah berakhir, belum ada aliran aktif, dan (sesi berjalan atau ada event baru). */
export function shouldResume(
  connection: TimelineConnection,
  status: string | undefined,
  hasActiveStream: boolean,
  eventCount: number | undefined,
  lastSeq: number,
): boolean {
  if (hasActiveStream) return false;
  if (connection !== "selesai") return false;
  if (status === "berjalan") return true;
  // Cek apakah ada event baru yang belum diterima
  if (eventCount !== undefined && eventCount > lastSeq) return true;
  return false;
}

export function useTimeline(api: ApiClient, session: SessionInfo | undefined): TimelineController {
  const [state, setState] = useState<TimelineState>(IDLE_TIMELINE);
  const [reloadTick, setReloadTick] = useState(0);
  const sessionId = session?.id;
  const prompt = session?.prompt;
  const status = session?.status;
  const eventCount = session?.eventCount;

  const controllerRef = useRef<AbortController | null>(null);
  const lastSeqRef = useRef(0);
  const endedForRef = useRef<string | undefined>(undefined);
  /** Komponen masih terpasang; jangan sentuh state setelah unmount. */
  const mountedRef = useRef(true);
  /** Pemutus aliran aktif: flush event tertahan lalu lepaskan timer. */
  const stopStreamRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const openStream = useCallback(
    (id: string, after: number, initialItems: TimelineItem[] | undefined): void => {
      // Aliran sebelumnya: event yang tertahan tidak boleh hilang.
      stopStreamRef.current?.();
      stopStreamRef.current = undefined;

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      lastSeqRef.current = after;
      endedForRef.current = undefined;

      if (initialItems === undefined) {
        setState((previous) => ({
          ...previous,
          connection: "menyambung",
          status: "berjalan",
          error: undefined,
        }));
      } else {
        setState({ items: initialItems, connection: "menyambung", events: [] });
      }

      // Event yang datang ditampung dulu; state diperbarui per batch, bukan
      // per event, supaya membuka sesi lama tidak membekukan thread utama.
      let buffer: BatchEvent[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let connected = false;

      const flush = (): void => {
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        if (buffer.length === 0) return;
        const batch = buffer;
        buffer = [];
        if (!mountedRef.current) return;
        setState((previous) => {
          const next = applyEventBatch(previous, batch);
          return {
            ...previous,
            items: next.items,
            context: next.context,
            events: next.events,
          };
        });
      };

      const scheduleFlush = (): void => {
        if (flushTimer !== undefined) return;
        flushTimer = setTimeout(() => {
          flushTimer = undefined;
          flush();
        }, FLUSH_INTERVAL_MS);
      };

      stopStreamRef.current = (): void => {
        flush();
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        buffer = [];
      };

      void (async () => {
        try {
          for await (const item of followSession(id, { after, signal: controller.signal })) {
            if (controller.signal.aborted) {
              flush();
              return;
            }
            if (item.kind === "event") {
              lastSeqRef.current = item.seq;
              buffer.push({ seq: item.seq, event: item.event });
              if (!connected) {
                connected = true;
                // Sambungan dianggap terhubung begitu event pertama masuk
                // buffer; label "Menyambung ulang…" tidak ikut tertahan.
                setState((previous) =>
                  previous.connection === "menyambung"
                    ? { ...previous, connection: "terhubung" }
                    : previous,
                );
              }
              scheduleFlush();
            } else {
              endedForRef.current = id;
              // Flush terakhir sebelum status akhir diterapkan.
              flush();
              setState((previous) => ({
                ...previous,
                connection: "selesai",
                status: item.status,
              }));
              return;
            }
          }
        } catch (caught) {
          if (controller.signal.aborted) {
            flush();
            return;
          }
          flush();
          setState((previous) => ({
            ...previous,
            connection: "galat",
            error: caught instanceof ApiError ? caught.message : messageOf(caught),
          }));
        } finally {
          if (controllerRef.current === controller) {
            controllerRef.current = null;
          }
        }
      })();
    },
    [api],
  );

  useEffect(() => {
    if (sessionId === undefined || prompt === undefined) {
      setState(IDLE_TIMELINE);
      return;
    }

    openStream(sessionId, 0, startTimeline(prompt));

    return () => {
      stopStreamRef.current?.();
      stopStreamRef.current = undefined;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [openStream, sessionId, prompt, reloadTick]);

  // Giliran lanjutan: aliran sudah berakhir tetapi sesi kembali berjalan atau ada event baru.
  useEffect(() => {
    if (sessionId === undefined) return;
    // Hanya sambung ulang untuk sesi yang alirannya memang baru saja berakhir.
    if (endedForRef.current !== sessionId) return;
    if (!shouldResume(state.connection, status, controllerRef.current !== null, eventCount, lastSeqRef.current)) {
      return;
    }
    openStream(sessionId, lastSeqRef.current, undefined);
  }, [openStream, sessionId, status, state.connection, eventCount]);

  // Muat ulang dari awal: dipakai setelah mundur percakapan (riwayat berubah).
  // Efek di atas memakai `reloadTick` sebagai dependensi, jadi stream dibuka ulang.
  const reload = useCallback((): void => {
    setReloadTick((tick) => tick + 1);
  }, []);

  return { ...state, reload };
}

export interface RegistryState {
  view?: RegistryView;
  error?: string;
  reload: () => Promise<void>;
}

export function useRegistry(api: ApiClient): RegistryState {
  const [view, setView] = useState<RegistryView | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const requestRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    try {
      const payload = await api.getProviders();
      if (ticket !== requestRef.current) return;
      setView(parseRegistryView(payload));
      setError(undefined);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setError(messageOf(caught));
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return useMemo(() => ({ view, error, reload }), [view, error, reload]);
}

export interface MemoryCountsState {
  /** Jumlah usulan terbuka; undefined bila belum diketahui atau tidak tersedia. */
  proposed?: number;
  refresh: () => Promise<void>;
}

/**
 * Hook ringan untuk angka usulan di sidebar. Galat apa pun (jaringan, 503)
 * disembunyikan: angka tidak ditampilkan, bukan ditampilkan sebagai galat.
 */
export function useMemoryCounts(api: ApiClient, view?: AppView): MemoryCountsState {
  const [proposed, setProposed] = useState<number | undefined>(undefined);
  const requestRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    try {
      const list = await api.listMemory({ limit: 1 });
      if (ticket !== requestRef.current) return;
      setProposed(list.counts.proposed);
    } catch {
      if (ticket !== requestRef.current) return;
      setProposed(undefined);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh, view]);

  return useMemo(() => ({ proposed, refresh }), [proposed, refresh]);
}

export interface WorkspacesState {
  items: WorkspaceItem[];
}

/**
 * Daftar workspace untuk dialog sesi baru. Galat apa pun (jaringan, 503,
 * Workspace dimatikan) menghasilkan daftar kosong tanpa pesan.
 */
export function useWorkspaces(api: ApiClient): WorkspacesState {
  const [items, setItems] = useState<WorkspaceItem[]>([]);

  useEffect(() => {
    let active = true;
    void api
      .listWorkspaces()
      .then((list) => {
        if (active) setItems(list.items);
      })
      .catch(() => {
        if (active) setItems([]);
      });
    return () => {
      active = false;
    };
  }, [api]);

  return useMemo(() => ({ items }), [items]);
}

export interface SessionReposState {
  repos?: Array<{ name: string; primary: boolean; missing: boolean }>;
}

const DONE_STATUSES: readonly string[] = ["selesai", "gagal", "dibatalkan"];

/**
 * Daftar repo workspace sesi dari `GET /api/sessions/:id`. Dimuat ulang saat
 * sesi berganti dan saat sesi selesai/gagal/dibatalkan. Galat apa pun
 * menghasilkan `undefined` tanpa pesan.
 */
export function useSessionRepos(
  api: ApiClient,
  sessionId: string,
  status: string,
): SessionReposState {
  const [repos, setRepos] = useState<SessionReposState["repos"]>(undefined);
  const requestRef = useRef(0);
  // Hanya perubahan ke status akhir yang memicu muat ulang, bukan tiap detak status.
  const doneKey = DONE_STATUSES.includes(status) ? status : "";

  useEffect(() => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    void api
      .getSession(sessionId)
      .then((session) => {
        if (ticket !== requestRef.current) return;
        setRepos(session.workspaceRepos);
      })
      .catch(() => {
        if (ticket !== requestRef.current) return;
        setRepos(undefined);
      });
  }, [api, sessionId, doneKey]);

  return useMemo(() => ({ repos }), [repos]);
}

/**
 * Notifikasi sistem untuk peristiwa izin dan selesai saat tab tidak terlihat
 * atau jendela tidak fokus. Daftar sebelumnya selalu diperbarui meski
 * notifikasi tidak ditampilkan.
 */
export function useNotifications(
  sessions: SessionInfo[],
  prefs: NotifyPrefs,
  onOpenSession: (id: string) => void,
): void {
  const previousRef = useRef<SessionInfo[] | undefined>(undefined);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = sessions;
    if (previous === undefined) return;
    if (!prefs.enabled) return;
    if (notificationSupport() !== "diizinkan") return;
    const visible = document.visibilityState === "visible";
    if (visible && document.hasFocus()) return;

    for (const event of detectEvents(previous, sessions)) {
      showNotification(event, () => onOpenSession(event.sessionId));
      if (prefs.sound) playBeep();
    }
  }, [sessions, prefs, onOpenSession]);
}

/* ---------- Perintah slash ---------- */

/** Status pemuatan daftar perintah slash. */
export type CommandsStatus = "memuat" | "siap" | "gagal";

export interface CommandsState {
  /** Daftar perintah yang tersedia. */
  commands: CommandInfo[];
  /** Asal daftar: dari SDK atau daftar bawaan Jejak. */
  source: CommandSource;
  /** Status pemuatan; galat tak pernah melempar keluar. */
  status: CommandsStatus;
}

/** Cache daftar perintah: per klien API, per folder kerja. */
const commandCache = new WeakMap<ApiClient, Map<string, CommandListResult>>();
/** Permintaan yang sedang berjalan; satu per folder kerja. */
const commandPending = new WeakMap<ApiClient, Map<string, Promise<CommandListResult>>>();

function cacheOf(api: ApiClient): Map<string, CommandListResult> {
  let cache = commandCache.get(api);
  if (cache === undefined) {
    cache = new Map<string, CommandListResult>();
    commandCache.set(api, cache);
  }
  return cache;
}

function pendingOf(api: ApiClient): Map<string, Promise<CommandListResult>> {
  let pending = commandPending.get(api);
  if (pending === undefined) {
    pending = new Map<string, Promise<CommandListResult>>();
    commandPending.set(api, pending);
  }
  return pending;
}

/**
 * Daftar perintah slash untuk satu folder kerja.
 *
 * Dimuat malas: baru diambil setelah `enabled` menjadi true (mis. pengguna
 * baru mengetik "/"). Hasil disimpan di memori per folder kerja, jadi satu
 * permintaan per folder; ganti folder memuat ulang. Galat ditelan: status
 * jadi "gagal" tanpa mengganggu pengetikan.
 */
export function useCommands(
  api: ApiClient,
  cwd: string | undefined,
  enabled = false,
): CommandsState {
  const [state, setState] = useState<CommandsState>({
    commands: [],
    source: "bawaan",
    status: "siap",
  });

  useEffect(() => {
    if (!enabled) return;
    if (cwd === undefined || cwd.trim() === "") return;

    const cache = cacheOf(api);
    const tersimpan = cache.get(cwd);
    if (tersimpan !== undefined) {
      setState({ commands: tersimpan.commands, source: tersimpan.source, status: "siap" });
      return;
    }

    let aktif = true;
    setState((current) => ({ ...current, status: "memuat" }));

    const pending = pendingOf(api);
    let kerja = pending.get(cwd);
    if (kerja === undefined) {
      kerja = api
        .listCommands(cwd)
        .then((hasil) => {
          cache.set(cwd, hasil);
          return hasil;
        })
        .finally(() => {
          pending.delete(cwd);
        });
      pending.set(cwd, kerja);
    }

    void kerja.then(
      (hasil) => {
        if (!aktif) return;
        setState({ commands: hasil.commands, source: hasil.source, status: "siap" });
      },
      () => {
        if (!aktif) return;
        setState({ commands: [], source: "bawaan", status: "gagal" });
      },
    );

    return () => {
      aktif = false;
    };
  }, [api, cwd, enabled]);

  return state;
}

/** Opsi menu perintah slash yang dikendalikan hook. */
export interface SlashMenuOptions {
  api: ApiClient;
  /** Folder kerja; tanpa folder menu tak dibuka. */
  cwd: string | undefined;
  /** Isi kolom input saat perintah dipilih: teks dan posisi kursor baru. */
  onApply: (next: { text: string; caret: number }) => void;
}

export interface SlashMenuController {
  /** Menu sedang tampil? */
  open: boolean;
  /** Status pemuatan daftar perintah. */
  status: CommandsStatus;
  /** Asal daftar perintah. */
  source: CommandSource;
  /** Perintah yang cocok dengan query (maksimal 8). */
  options: CommandInfo[];
  /** Indeks opsi aktif. */
  activeIndex: number;
  /** Id opsi aktif untuk `aria-activedescendant`. */
  activeId: string | undefined;
  /** Id listbox untuk `aria-controls`. */
  listboxId: string;
  /** Catat teks dan kursor terbaru; menu mengikuti pola slash. */
  sync: (text: string, caret: number) => void;
  /** Tangani tombol keyboard; true bila peristiwa sudah dimakan. */
  onKeyDown: (event: KeyboardEvent) => boolean;
  /** Pilih satu perintah; isi kolom dengan `/nama `. */
  pick: (command: CommandInfo) => void;
}

interface SlashState {
  /** Query slash terakhir; undefined berarti menu tertutup. */
  query?: string;
  /** Teks saat menu ditutup Escape; menu muncul lagi saat teks berubah. */
  dismissedText?: string;
  /** Indeks opsi aktif. */
  activeIndex: number;
}

const KOSONG: SlashState = { activeIndex: 0 };

/**
 * Kendali menu perintah slash untuk satu kolom input.
 *
 * Logika tombol, keadaan buka/tutup, dan pemilihan perintah diletakkan di
 * sini supaya komposer dan baris balasan memakai perilaku yang sama.
 */
export function useSlashMenu(options: SlashMenuOptions): SlashMenuController {
  const { api, cwd, onApply } = options;
  const [state, setState] = useState<SlashState>(KOSONG);
  const textRef = useRef("");
  const caretRef = useRef(0);
  const baseId = useId();
  const listboxId = `${baseId}-slash`;

  const adaFolder = cwd !== undefined && cwd.trim() !== "";
  const commands = useCommands(api, cwd, state.query !== undefined && adaFolder);

  const dismissed = state.dismissedText !== undefined && state.dismissedText === textRef.current;
  const open = state.query !== undefined && !dismissed && adaFolder;

  const daftar = useMemo(
    () => (state.query === undefined ? [] : filterCommands(commands.commands, state.query)),
    [commands.commands, state.query],
  );

  const sync = useCallback((text: string, caret: number): void => {
    textRef.current = text;
    caretRef.current = caret;
    setState((current) => {
      const ctx = slashContext(text, caret);
      if (ctx === undefined) return KOSONG;
      if (current.dismissedText !== undefined) {
        // Ditutup Escape: tetap tertutup sampai teksnya berubah.
        if (current.dismissedText === text) return { ...current, query: ctx.query };
        return { query: ctx.query, activeIndex: 0 };
      }
      return { query: ctx.query, activeIndex: 0 };
    });
  }, []);

  const pick = useCallback(
    (command: CommandInfo): void => {
      const next = applyCommand(textRef.current, caretRef.current, command.name);
      textRef.current = next.text;
      caretRef.current = next.caret;
      setState(KOSONG);
      onApply(next);
    },
    [onApply],
  );

  const geser = useCallback(
    (arah: 1 | -1): void => {
      setState((current) => {
        if (daftar.length === 0) return current;
        const total = daftar.length;
        const berikut = (current.activeIndex + arah + total) % total;
        return { ...current, activeIndex: berikut };
      });
    },
    [daftar.length],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!open) return false;
      // Pintasan dengan tombol khusus tetap jalan (mis. Cmd+Enter).
      if (event.metaKey === true || event.ctrlKey === true) return false;
      const key = event.key;
      if (key === "Escape") {
        event.preventDefault();
        setState((current) => ({ ...current, dismissedText: textRef.current }));
        return true;
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        geser(key === "ArrowDown" ? 1 : -1);
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        // Tanpa pilihan, Enter berperilaku seperti biasa (kirim pesan).
        if (daftar.length === 0) return false;
        const command = daftar[state.activeIndex] ?? daftar[0];
        if (command === undefined) return false;
        event.preventDefault();
        pick(command);
        return true;
      }
      return false;
    },
    [open, daftar, state.activeIndex, geser, pick],
  );

  const activeId =
    open && daftar.length > 0 ? `${listboxId}-opsi-${state.activeIndex}` : undefined;

  return {
    open,
    status: commands.status,
    source: commands.source,
    options: open ? daftar : [],
    activeIndex: state.activeIndex,
    activeId,
    listboxId,
    sync,
    onKeyDown,
    pick,
  };
}
