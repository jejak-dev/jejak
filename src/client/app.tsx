import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { SessionInfo } from "../server/sessions/session-manager";
import { Composer } from "./components/Composer";
import { ProviderSettings } from "./components/ProviderSettings";
import { SessionHeader, Topbar } from "./components/SessionHeader";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { useHashRoute, useInfo, useRegistry, useSessions, useTimeline } from "./hooks";
import { createApiClient } from "./lib/api";

export function App() {
  const api = useMemo(() => createApiClient(), []);
  const { sessionId: selectedId, view: routeView, navigateToSession: navigate } = useHashRoute();
  const { info } = useInfo(api);
  const { sessions, refresh } = useSessions(api);
  const { view, reload } = useRegistry(api);

  const selected = sessions.find((session) => session.id === selectedId);
  const timeline = useTimeline(api, selected);

  const [interruptError, setInterruptError] = useState<string | undefined>(undefined);
  const [interrupting, setInterrupting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const activeProfile = view?.profiles.find((profile) => profile.id === view.activeProfileId);
  const activeProfileLabel = activeProfile?.name ?? view?.activeProfileId;

  const showingProviders = routeView === "providers";

  const waiting = sessions.reduce((total, session) => total + session.pendingPermissions, 0);

  useEffect(() => {
    const base = showingProviders
      ? "Provider · Jejak"
      : selected !== undefined
        ? `${selected.title} · Jejak`
        : "Jejak";
    document.title = waiting > 0 ? `(${waiting}) ${base}` : base;
  }, [selected, showingProviders, waiting]);

  // Pindah halaman menutup laci sidebar (tampilan sempit).
  useEffect(() => {
    setDrawerOpen(false);
  }, [selectedId, routeView]);

  const openDrawer = useCallback((): void => setDrawerOpen(true), []);
  const closeDrawer = useCallback((): void => setDrawerOpen(false), []);

  const onSaved = useCallback((): void => {
    void reload();
  }, [reload]);

  const onSelect = useCallback(
    (id: string): void => {
      navigate(id);
    },
    [navigate],
  );

  const onNew = useCallback((): void => {
    navigate();
  }, [navigate]);

  const onCreated = useCallback(
    (session: SessionInfo): void => {
      void (async () => {
        await refresh();
        navigate(session.id);
      })();
    },
    [navigate, refresh],
  );

  const interruptId = selected?.id;
  const onInterrupt = useCallback((): void => {
    if (interruptId === undefined) return;
    setInterrupting(true);
    setInterruptError(undefined);
    void (async () => {
      try {
        await api.interruptSession(interruptId);
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : "gagal menghentikan sesi";
        setInterruptError(message);
      } finally {
        setInterrupting(false);
      }
    })();
  }, [api, interruptId, refresh]);

  const onDecide = useCallback(
    async (requestId: string, decision: "allow" | "deny", message?: string): Promise<void> => {
      if (interruptId === undefined) return;
      await api.decidePermission(interruptId, requestId, decision, message);
      void refresh();
    },
    [api, interruptId, refresh],
  );

  const headerError = selected !== undefined ? interruptError : undefined;
  const recentCwds = useMemo(() => {
    const seen: string[] = [];
    for (const session of sessions) {
      if (!seen.includes(session.cwd)) seen.push(session.cwd);
    }
    return seen;
  }, [sessions]);

  const mainClass =
    showingProviders || selected !== undefined ? "jk-main" : "jk-main jk-main-home";

  return (
    <div class={`jk-app${drawerOpen ? " jk-drawer-open" : ""}`}>
      <Sidebar
        info={info}
        sessions={sessions}
        selectedId={showingProviders ? undefined : selectedId}
        onSelect={onSelect}
        onNew={onNew}
        onClose={closeDrawer}
        activeProfileLabel={activeProfileLabel}
        providersActive={showingProviders}
      />
      <div class="jk-scrim" onClick={closeDrawer} aria-hidden="true" />

      <main class={mainClass}>
        {showingProviders ? (
          <>
            <Topbar onMenu={openDrawer} />
            <div class="jk-page">
              <ProviderSettings api={api} onSaved={onSaved} />
            </div>
          </>
        ) : selected !== undefined ? (
          <>
            <SessionHeader
              session={selected}
              status={timeline.status ?? selected.status}
              onInterrupt={onInterrupt}
              onMenu={openDrawer}
              busy={interrupting}
              error={headerError}
            />
            <Timeline
              items={timeline.items}
              connection={timeline.connection}
              cwd={selected.cwd}
              onDecide={onDecide}
            />
          </>
        ) : (
          <>
            <Topbar onMenu={openDrawer} />
            <section class="jk-home" aria-labelledby="jk-greeting">
              <h2 id="jk-greeting" class="jk-greeting">
                Mau mengerjakan apa hari ini?
              </h2>
              <div class="jk-home-wrap">
                <Composer
                  api={api}
                  defaultCwd={info?.cwd}
                  registry={view}
                  recentCwds={recentCwds}
                  onCreated={onCreated}
                />
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
