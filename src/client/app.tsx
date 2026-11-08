import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { SessionInfo } from "../server/sessions/session-manager";
import { Composer } from "./components/Composer";
import { MemoryPage } from "./components/MemoryPage";
import { Panel } from "./components/Panel";
import { ProviderSettings } from "./components/ProviderSettings";
import { ReplyBar } from "./components/ReplyBar";
import { SessionHeader, Topbar } from "./components/SessionHeader";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { WorkspacePage } from "./components/WorkspacePage";
import {
  useHashRoute,
  useInfo,
  useMemoryCounts,
  useNotifications,
  useRegistry,
  useSessions,
  useTimeline,
  useWorkspaces,
} from "./hooks";
import { createApiClient } from "./lib/api";
import { readNotifyPrefs, writeNotifyPrefs, type NotifyPrefs } from "./lib/notify";
import { readPanelPrefs, writePanelPrefs } from "./lib/panel-prefs";

export function App() {
  const api = useMemo(() => createApiClient(), []);
  const { sessionId: selectedId, view: routeView, navigateToSession: navigate } = useHashRoute();
  const { info } = useInfo(api);
  const [notifyPrefs, setNotifyPrefs] = useState<NotifyPrefs>(() => readNotifyPrefs());
  const { sessions, refresh } = useSessions(api, undefined, notifyPrefs.enabled);
  const { view, reload } = useRegistry(api);
  const { proposed: memoryProposed, refresh: refreshMemory } = useMemoryCounts(api, routeView);
  const { items: workspaces } = useWorkspaces(api);

  const selected = sessions.find((session) => session.id === selectedId);
  const timeline = useTimeline(api, selected);

  const onOpenSession = useCallback(
    (id: string): void => {
      navigate(id);
    },
    [navigate],
  );

  useNotifications(sessions, notifyPrefs, onOpenSession);

  const onNotifyPrefsChange = useCallback((prefs: NotifyPrefs): void => {
    setNotifyPrefs(prefs);
    writeNotifyPrefs(prefs);
  }, []);

  const [interruptError, setInterruptError] = useState<string | undefined>(undefined);
  const [interrupting, setInterrupting] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => readPanelPrefs().open);

  const activeProfile = view?.profiles.find((profile) => profile.id === view.activeProfileId);
  const activeProfileLabel = activeProfile?.name ?? view?.activeProfileId;

  const showingProviders = routeView === "providers";
  const showingMemory = routeView === "memory";
  const showingWorkspaces = routeView === "workspaces";

  const waiting = sessions.reduce((total, session) => total + session.pendingPermissions, 0);

  useEffect(() => {
    const base = showingProviders
      ? "Provider · Jejak"
      : showingMemory
        ? "Memory · Jejak"
        : showingWorkspaces
          ? "Workspace · Jejak"
          : selected !== undefined
            ? `${selected.title} · Jejak`
            : "Jejak";
    document.title = waiting > 0 ? `(${waiting}) ${base}` : base;
  }, [selected, showingProviders, showingMemory, showingWorkspaces, waiting]);

  // Pindah halaman menutup laci sidebar (tampilan sempit).
  useEffect(() => {
    setDrawerOpen(false);
  }, [selectedId, routeView]);

  const openDrawer = useCallback((): void => setDrawerOpen(true), []);
  const closeDrawer = useCallback((): void => setDrawerOpen(false), []);

  const onPanelOpenChange = useCallback((open: boolean): void => {
    setPanelOpen(open);
    writePanelPrefs({ open });
  }, []);
  const togglePanel = useCallback((): void => {
    const next = !panelOpen;
    setPanelOpen(next);
    writePanelPrefs({ open: next });
  }, [panelOpen]);

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

  const onRenameSession = useCallback(
    async (id: string, title: string): Promise<void> => {
      await api.renameSession(id, title);
      await refresh();
    },
    [api, refresh],
  );

  const onArchiveSession = useCallback(
    async (id: string, archived: boolean): Promise<void> => {
      await api.archiveSession(id, archived);
      await refresh();
      if (archived && id === selectedId) navigate();
    },
    [api, navigate, refresh, selectedId],
  );

  const onDeleteSession = useCallback(
    async (id: string): Promise<void> => {
      await api.deleteSession(id);
      await refresh();
      if (id === selectedId) navigate();
    },
    [api, navigate, refresh, selectedId],
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

  const memoryProjects = useMemo(() => {
    const seen = [...recentCwds];
    const cwd = info?.cwd;
    if (cwd !== undefined && cwd !== "" && !seen.includes(cwd)) seen.unshift(cwd);
    return seen;
  }, [info?.cwd, recentCwds]);

  const onMemoryChanged = useCallback((): void => {
    void refreshMemory();
  }, [refreshMemory]);

  const mainClass =
    showingProviders || showingMemory || showingWorkspaces || selected !== undefined
      ? "jk-main"
      : "jk-main jk-main-home";

  return (
    <div class={`jk-app${drawerOpen ? " jk-drawer-open" : ""}`}>
      <Sidebar
        info={info}
        sessions={sessions}
        selectedId={showingProviders || showingMemory || showingWorkspaces ? undefined : selectedId}
        onSelect={onSelect}
        onNew={onNew}
        onClose={closeDrawer}
        activeProfileLabel={activeProfileLabel}
        providersActive={showingProviders}
        memoryActive={showingMemory}
        workspacesActive={showingWorkspaces}
        memoryProposed={memoryProposed}
        onRename={onRenameSession}
        onArchive={onArchiveSession}
        onDelete={onDeleteSession}
        notifyPrefs={notifyPrefs}
        onNotifyPrefsChange={onNotifyPrefsChange}
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
        ) : showingMemory ? (
          <>
            <Topbar onMenu={openDrawer} />
            <div class="jk-page">
              <MemoryPage api={api} projects={memoryProjects} onChanged={onMemoryChanged} />
            </div>
          </>
        ) : showingWorkspaces ? (
          <>
            <Topbar onMenu={openDrawer} />
            <div class="jk-page">
              <WorkspacePage api={api} projects={memoryProjects} />
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
              panelOpen={panelOpen}
              onTogglePanel={togglePanel}
              error={headerError}
            />
            <div class="jk-main-body">
              <div class="jk-main-col">
                <Timeline
                  items={timeline.items}
                  connection={timeline.connection}
                  cwd={selected.cwd}
                  onDecide={onDecide}
                />
                <ReplyBar key={selected.id} api={api} session={selected} refresh={refresh} />
              </div>
              {panelOpen && (
                <Panel
                  key={selected.id}
                  api={api}
                  sessionId={selected.id}
                  eventCount={selected.eventCount}
                  status={timeline.status ?? selected.status}
                  open={panelOpen}
                  onOpenChange={onPanelOpenChange}
                />
              )}
            </div>
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
                  workspaces={workspaces}
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
