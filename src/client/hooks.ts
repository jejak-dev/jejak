import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../server/sessions/session-manager";
import { ApiError, type ApiClient } from "./lib/api";
import { parseHashRoute, providersHash, sessionHash } from "./lib/format";
import { parseRegistryView, type RegistryView } from "./lib/registry-view";
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
  view?: "providers";
}

function currentRoute(): Route {
  return parseHashRoute(window.location.hash);
}

export interface HashRouteState {
  sessionId?: string;
  view?: "providers";
  navigateToSession: (id?: string) => void;
  navigateToProviders: () => void;
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

  return useMemo(
    () => ({
      sessionId: route.sessionId,
      view: route.view,
      navigateToSession,
      navigateToProviders,
    }),
    [route, navigateToSession, navigateToProviders],
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

export function useSessions(api: ApiClient, intervalMs = 3000): SessionsState {
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
        if (document.visibilityState === "visible") {
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
      if (document.visibilityState === "visible") {
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

export function useTimeline(api: ApiClient, session: SessionInfo | undefined): TimelineState {
  const [state, setState] = useState<TimelineState>(IDLE_TIMELINE);
  const sessionId = session?.id;
  const prompt = session?.prompt;

  useEffect(() => {
    if (sessionId === undefined || prompt === undefined) {
      setState(IDLE_TIMELINE);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setState({ items: startTimeline(prompt), connection: "menyambung" });

    void (async () => {
      try {
        for await (const item of followSession(sessionId, { signal: controller.signal })) {
          if (!active) return;
          if (item.kind === "event") {
            setState((previous) => {
              const connection = previous.connection === "menyambung" ? "terhubung" : previous.connection;
              return {
                ...previous,
                connection,
                items: reduceTimeline(previous.items, item.event),
              };
            });
          } else {
            setState((previous) => ({
              ...previous,
              connection: "selesai",
              status: item.status,
            }));
            return;
          }
        }
      } catch (caught) {
        if (!active) return;
        setState((previous) => ({
          ...previous,
          connection: "galat",
          error: caught instanceof ApiError ? caught.message : messageOf(caught),
        }));
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [api, sessionId, prompt]);

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
