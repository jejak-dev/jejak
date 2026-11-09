import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../server/sessions/session-manager";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import { MemoryPage } from "./components/MemoryPage";
import { McpPage } from "./components/McpPage";
import { Panel } from "./components/Panel";
import { ProviderSettings } from "./components/ProviderSettings";
import { ReplyBar } from "./components/ReplyBar";
import { SessionHeader, Topbar } from "./components/SessionHeader";
import { ShortcutHelp } from "./components/ShortcutHelp";
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
import { buildCommands, type CommandId } from "./lib/commands";
import { groupSessions } from "./lib/format";
import { readNotifyPrefs, writeNotifyPrefs, type NotifyPrefs } from "./lib/notify";
import { readPanelPrefs, writePanelPrefs } from "./lib/panel-prefs";
import { adjacentSession, matchShortcut, targetKindOf } from "./lib/shortcuts";

export function App() {
  const api = useMemo(() => createApiClient(), []);
  const {
    sessionId: selectedId,
    view: routeView,
    navigateToSession: navigate,
    navigateToMemory,
    navigateToMcp,
    navigateToProviders,
    navigateToWorkspaces,
  } = useHashRoute();
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
  const [panelTabRequest, setPanelTabRequest] = useState<
    { tab: "git"; nonce: number } | undefined
  >(undefined);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const previousFocusRef = useRef<Element | null>(null);
  const [promptFocusTick, setPromptFocusTick] = useState(0);

  const activeProfile = view?.profiles.find((profile) => profile.id === view.activeProfileId);
  const activeProfileLabel = activeProfile?.name ?? view?.activeProfileId;

  const showingProviders = routeView === "providers";
  const showingMemory = routeView === "memory";
  const showingWorkspaces = routeView === "workspaces";
  const showingMcp = routeView === "mcp";

  const waiting = sessions.reduce((total, session) => total + session.pendingPermissions, 0);

  useEffect(() => {
    const base = showingProviders
      ? "Provider · Jejak"
      : showingMemory
        ? "Memory · Jejak"
        : showingWorkspaces
          ? "Workspace · Jejak"
          : showingMcp
            ? "Server MCP · Jejak"
            : selected !== undefined
              ? `${selected.title} · Jejak`
              : "Jejak";
    document.title = waiting > 0 ? `(${waiting}) ${base}` : base;
  }, [selected, showingProviders, showingMemory, showingWorkspaces, showingMcp, waiting]);

  // Pindah halaman menutup laci sidebar (tampilan sempit).
  useEffect(() => {
    setDrawerOpen(false);
  }, [selectedId, routeView]);

  const openDrawer = useCallback((): void => setDrawerOpen(true), []);
  const closeDrawer = useCallback((): void => setDrawerOpen(false), []);
  const openPalette = useCallback((): void => {
    previousFocusRef.current = document.activeElement;
    setPaletteOpen(true);
  }, []);

  const onPanelOpenChange = useCallback((open: boolean): void => {
    setPanelOpen(open);
    writePanelPrefs({ open });
  }, []);
  const togglePanel = useCallback((): void => {
    const next = !panelOpen;
    setPanelOpen(next);
    writePanelPrefs({ open: next });
  }, [panelOpen]);

  // Palette "Buka panel Git": buka panel lalu minta tab Git; preferensi ikut disimpan.
  const openGitPanel = useCallback((): void => {
    setPanelOpen(true);
    writePanelPrefs({ open: true, tab: "git" });
    setPanelTabRequest((current) => ({ tab: "git", nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const onSaved = useCallback((): void => {
    void reload();
  }, [reload]);

  // Pintasan keyboard global (Ctrl/Cmd+K, ?, /, n, p, Alt↑↓).
  // Saat overlay terbuka, tombol ditangani komponen overlay itu sendiri.
  useEffect(() => {
    if (paletteOpen || helpOpen) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;

      const targetKind = targetKindOf(event.target);
      const action = matchShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
        targetKind,
      });
      if (action === undefined || action === "escape") return;

      if (action === "palette") {
        // Selalu cegah perilaku bawaan, termasuk saat fokus di kolom teks.
        event.preventDefault();
        previousFocusRef.current = document.activeElement;
        setPaletteOpen(true);
        return;
      }

      if (action === "help") {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }

      if (action === "search") {
        // Input pencarian hanya ada saat sidebar punya sesi.
        const search = document.getElementById("jk-session-search");
        if (search === null) return;
        event.preventDefault();
        (search as HTMLInputElement).focus();
        return;
      }

      if (action === "new-session") {
        event.preventDefault();
        setPromptFocusTick(tick => tick + 1);
        navigate();
        return;
      }

      if (action === "toggle-panel") {
        if (selected === undefined) return;
        event.preventDefault();
        togglePanel();
        return;
      }

      if (action === "prev-session" || action === "next-session") {
        event.preventDefault();
        // Urutan sama dengan daftar sidebar: per folder, terbaru dulu.
        const visible = sessions.filter((session) => session.archivedAt === undefined);
        const ids = groupSessions(visible).flatMap((group) => group.items.map((session) => session.id));
        const next = adjacentSession(ids, selectedId, action === "next-session" ? "next" : "prev");
        if (next !== undefined) navigate(next);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    helpOpen,
    navigate,
    paletteOpen,
    selected,
    selectedId,
    sessions,
    togglePanel,
  ]);

  // Fokus ke textarea tugas setelah "Sesi baru" lewat pintasan.
  const handledPromptFocusRef = useRef(0);
  useEffect(() => {
    if (promptFocusTick === 0 || handledPromptFocusRef.current === promptFocusTick) return;
    if (routeView !== undefined || selected !== undefined) return;
    handledPromptFocusRef.current = promptFocusTick;
    const prompt = document.getElementById("jk-prompt");
    if (prompt !== null) (prompt as HTMLTextAreaElement).focus();
  }, [promptFocusTick, routeView, selected, selectedId]);

  const closePalette = useCallback((): void => {
    setPaletteOpen(false);
    const focused = previousFocusRef.current;
    previousFocusRef.current = null;
    if (focused instanceof HTMLElement) focused.focus();
  }, []);

  const runCommand = useCallback(
    (run: CommandId | { session: string }): void => {
      if (typeof run === "object") {
        navigate(run.session);
        return;
      }
      switch (run) {
        case "new-session":
          setPromptFocusTick(tick => tick + 1);
          navigate(undefined);
          return;
        case "open-workspace":
          navigateToWorkspaces();
          return;
        case "open-mcp":
          navigateToMcp();
          return;
        case "open-memory":
          navigateToMemory();
          return;
        case "open-providers":
          navigateToProviders();
          return;
        case "toggle-panel":
          togglePanel();
          return;
        case "open-git":
          openGitPanel();
          return;
        case "focus-search":
          document.getElementById("jk-session-search")?.focus();
          return;
        case "show-shortcuts":
          setHelpOpen(true);
          return;
      }
    },
    [navigate, navigateToMcp, navigateToMemory, navigateToProviders, navigateToWorkspaces, openGitPanel, togglePanel],
  );

  const commands = useMemo(
    () =>
      buildCommands({
        sessions,
        hasSession: selected !== undefined,
        panelOpen,
      }),
    [panelOpen, selected, sessions],
  );

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
    showingProviders || showingMemory || showingWorkspaces || showingMcp || selected !== undefined
      ? "jk-main"
      : "jk-main jk-main-home";

  return (
    <div class={`jk-app${drawerOpen ? " jk-drawer-open" : ""}`}>
      <Sidebar
        info={info}
        sessions={sessions}
        selectedId={
          showingProviders || showingMemory || showingWorkspaces || showingMcp
            ? undefined
            : selectedId
        }
        onSelect={onSelect}
        onNew={onNew}
        onClose={closeDrawer}
        activeProfileLabel={activeProfileLabel}
        providersActive={showingProviders}
        memoryActive={showingMemory}
        workspacesActive={showingWorkspaces}
        mcpActive={showingMcp}
        memoryProposed={memoryProposed}
        onRename={onRenameSession}
        onArchive={onArchiveSession}
        onDelete={onDeleteSession}
        notifyPrefs={notifyPrefs}
        onNotifyPrefsChange={onNotifyPrefsChange}
        onOpenPalette={openPalette}
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
        ) : showingMcp ? (
          <>
            <Topbar onMenu={openDrawer} />
            <div class="jk-page">
              <McpPage api={api} />
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
                  tabRequest={panelTabRequest}
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

      {paletteOpen && (
        <CommandPalette commands={commands} onRun={runCommand} onClose={closePalette} />
      )}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
