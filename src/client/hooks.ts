import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../server/sessions/session-manager";
import { ApiError, type ApiClient, type WorkspaceItem } from "./lib/api";
import {
  auditHash,
  mcpHash,
  memoryHash,
  parseHashRoute,
  providersHash,
  sessionHash,
  workspacesHash,
  type AppView,
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
import { reduceTimeline, startTimeline, type TimelineItem } from "./lib/timeline";

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return "terjadi kesalahan";
}

interface Route {
  sessionId?: string;
  view?: AppView;
}

function currentRoute(): Route {
  return parseHashRoute(window.location.hash);
}

export interface HashRouteState {
  sessionId?: string;
  view?: AppView;
  navigateToSession: (id?: string) => void;
  navigateToProviders: () => void;
  navigateToMemory: () => void;
  navigateToWorkspaces: () => void;
  navigateToMcp: () => void;
  navigateToAudit: () => void;
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

  return useMemo(
    () => ({
      sessionId: route.sessionId,
      view: route.view,
      navigateToSession,
      navigateToProviders,
      navigateToMemory,
      navigateToWorkspaces,
      navigateToMcp,
      navigateToAudit,
    }),
    [
      route,
      navigateToSession,
      navigateToProviders,
      navigateToMemory,
      navigateToWorkspaces,
      navigateToMcp,
      navigateToAudit,
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

export type TimelineConnection = "idle" | "terhubung" | "menyambung" | "selesai" | "galat";

export interface TimelineState {
  items: TimelineItem[];
  connection: TimelineConnection;
  status?: string;
  error?: string;
}

const IDLE_TIMELINE: TimelineState = { items: [], connection: "idle" };

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

export function useTimeline(api: ApiClient, session: SessionInfo | undefined): TimelineState {
  const [state, setState] = useState<TimelineState>(IDLE_TIMELINE);
  const sessionId = session?.id;
  const prompt = session?.prompt;
  const status = session?.status;
  const eventCount = session?.eventCount;

  const controllerRef = useRef<AbortController | null>(null);
  const lastSeqRef = useRef(0);
  const endedForRef = useRef<string | undefined>(undefined);

  const openStream = useCallback(
    (id: string, after: number, initialItems: TimelineItem[] | undefined): void => {
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
        setState({ items: initialItems, connection: "menyambung" });
      }

      void (async () => {
        try {
          for await (const item of followSession(id, { after, signal: controller.signal })) {
            if (controller.signal.aborted) return;
            if (item.kind === "event") {
              lastSeqRef.current = item.seq;
              setState((previous) => ({
                ...previous,
                connection: previous.connection === "menyambung" ? "terhubung" : previous.connection,
                items: reduceTimeline(previous.items, item.event),
              }));
            } else {
              endedForRef.current = id;
              setState((previous) => ({
                ...previous,
                connection: "selesai",
                status: item.status,
              }));
              return;
            }
          }
        } catch (caught) {
          if (controller.signal.aborted) return;
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
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [openStream, sessionId, prompt]);

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

  return state;
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
