import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../server/sessions/session-manager";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import { AuditPage } from "./components/AuditPage";
import { InstruksiPage } from "./components/InstruksiPage";
import { UsagePage } from "./components/UsagePage";
import { LoginScreen } from "./components/LoginScreen";
import { MemoryPage } from "./components/MemoryPage";
import { McpPage } from "./components/McpPage";
import { Panel } from "./components/Panel";
import { ProviderSettings } from "./components/ProviderSettings";
import { ReplyBar } from "./components/ReplyBar";
import { SessionHeader, Topbar } from "./components/SessionHeader";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Sidebar } from "./components/Sidebar";
import { PaneResizer } from "./components/PaneResizer";
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
import { createApiClient, ApiError } from "./lib/api";
import { needsTlsWarning, type AuthStatus } from "./lib/auth";
import { buildCommands, type CommandId } from "./lib/commands";
import { contextUsage } from "./lib/context";
import { groupSessions } from "./lib/format";
import { readNotifyPrefs, writeNotifyPrefs, type NotifyPrefs } from "./lib/notify";
import { readPanelPrefs, writePanelPrefs, type PanelTab } from "./lib/panel-prefs";
import { panelWidth } from "./lib/panel-width";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  loadSidebarWidth,
  saveSidebarWidth,
  sidebarWidth,
} from "./lib/sidebar-width";
import { adjacentSession, matchShortcut, targetKindOf } from "./lib/shortcuts";
import { dirtyWarning } from "./lib/worktree";
import { rewindableSeqs } from "./lib/rewind";

export function App() {
  // Respons 401 di tengah sesi mengembalikan ke layar login tanpa kehilangan draf.
  const unauthorizedRef = useRef<() => void>(() => undefined);
  const api = useMemo(
    () => createApiClient({ onUnauthorized: () => unauthorizedRef.current() }),
    [],
  );
  const [auth, setAuth] = useState<AuthStatus | undefined>(undefined);
  const [loginError, setLoginError] = useState<string | undefined>(undefined);
  const [retryAfterSec, setRetryAfterSec] = useState<number | undefined>(undefined);

  const onUnauthorized = useCallback((): void => {
    setAuth((current) =>
      current === undefined || current.authenticated === false
        ? current
        : { ...current, authenticated: false },
    );
  }, []);

  useEffect(() => {
    unauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  // Status autentikasi dicek saat aplikasi mulai.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const status = await api.getAuthStatus();
        if (!alive) return;
        setAuth(status);
      } catch {
        if (alive) setAuth({ required: false, authenticated: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  const onLogin = useCallback(
    async (password: string): Promise<void> => {
      setLoginError(undefined);
      setRetryAfterSec(undefined);
      try {
        await api.login(password);
        setAuth((current) =>
          current === undefined
            ? { required: true, authenticated: true }
            : { ...current, authenticated: true },
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 429 && error.retryAfterSec !== undefined) {
          setRetryAfterSec(error.retryAfterSec);
          setLoginError("Terlalu banyak percobaan. Tunggu sebentar.");
          return;
        }
        setLoginError(
          error instanceof Error && error.message !== "" ? error.message : "gagal masuk",
        );
      }
    },
    [api],
  );

  const onLogout = useCallback((): void => {
    void (async () => {
      try {
        await api.logout();
      } catch {
        // Cookie mungkin sudah kedaluwarsa; layar login tetap ditampilkan.
      }
      setAuth((current) =>
        current === undefined ? current : { ...current, authenticated: false },
      );
    })();
  }, [api]);

  const {
    sessionId: selectedId,
    view: routeView,
    navigateToSession: navigate,
    navigateToMemory,
    navigateToMcp,
    navigateToAudit,
    navigateToInstruksi,
    navigateToUsage,
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
  const [panelW, setPanelW] = useState(() => {
    try {
      return panelWidth.load(window.localStorage);
    } catch {
      return panelWidth.load(undefined);
    }
  });
  const [sideWidth, setSideWidth] = useState(() => {
    try {
      return loadSidebarWidth(window.localStorage);
    } catch {
      return loadSidebarWidth(undefined);
    }
  });
  const [panelOpen, setPanelOpen] = useState(() => readPanelPrefs().open);
  const [panelTabRequest, setPanelTabRequest] = useState<
    { tab: PanelTab; nonce: number } | undefined
  >(undefined);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [worktreeNotice, setWorktreeNotice] = useState<
    { sessionId: string; text: string } | undefined
  >(undefined);
  const previousFocusRef = useRef<Element | null>(null);
  const [promptFocusTick, setPromptFocusTick] = useState(0);
  // Teks yang ditaruh di kolom input (pesan yang dibuang saat mundur percakapan).
  const [draft, setDraft] = useState<
    { sessionId: string; text: string; nonce: number } | undefined
  >(undefined);
  const draftNonceRef = useRef(0);

  // Teks draf tidak berlaku untuk sesi lain.
  useEffect(() => {
    setDraft(undefined);
  }, [selectedId]);

  const activeProfile = view?.profiles.find((profile) => profile.id === view.activeProfileId);
  const activeProfileLabel = activeProfile?.name ?? view?.activeProfileId;

  const showingProviders = routeView === "providers";
  const showingMemory = routeView === "memory";
  const showingWorkspaces = routeView === "workspaces";
  const showingMcp = routeView === "mcp";
  const showingAudit = routeView === "audit";
  const showingInstruksi = routeView === "instruksi";
  const showingUsage = routeView === "usage";

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
            : showingAudit
              ? "Audit log · Jejak"
              : showingInstruksi
                ? "Instructions · Jejak"
                : showingUsage
                  ? "Usage · Jejak"
                  : selected !== undefined
                    ? `${selected.title} · Jejak`
                    : "Jejak";
    document.title = waiting > 0 ? `(${waiting}) ${base}` : base;
  }, [selected, showingProviders, showingMemory, showingWorkspaces, showingMcp, showingAudit, showingInstruksi, showingUsage, waiting]);

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

  // Palette "Buka tab Rahasia": pola sama dengan tab Git.
  const openSecretsTab = useCallback((): void => {
    setPanelOpen(true);
    writePanelPrefs({ open: true, tab: "rahasia" });
    setPanelTabRequest((current) => ({ tab: "rahasia", nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const onSaved = useCallback((): void => {
    void reload();
  }, [reload]);

  // Keyboard shortcuts global (Ctrl/Cmd+K, ?, /, n, p, Alt↑↓).
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

  // Fokus ke textarea tugas setelah "New session" lewat pintasan.
  const handledPromptFocusRef = useRef(0);
  useEffect(() => {
    if (promptFocusTick === 0 || handledPromptFocusRef.current === promptFocusTick) return;
    if (routeView !== undefined || selected !== undefined) return;
    handledPromptFocusRef.current = promptFocusTick;
    const prompt = document.getElementById("jk-prompt");
    if (prompt !== null) (prompt as HTMLTextAreaElement).focus();
  }, [promptFocusTick, routeView, selected, selectedId]);

  // Peringatan perubahan folder asli hanya untuk sesi yang baru dibuat; hilang saat pindah sesi.
  useEffect(() => {
    setWorktreeNotice((current) =>
      current !== undefined && current.sessionId !== selectedId ? undefined : current,
    );
  }, [selectedId]);

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
        case "open-audit":
          navigateToAudit();
          return;
        case "open-instruksi":
          navigateToInstruksi();
          return;
        case "open-usage":
          navigateToUsage();
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
        case "open-secrets-tab":
          openSecretsTab();
          return;
        case "focus-search":
          document.getElementById("jk-session-search")?.focus();
          return;
        case "show-shortcuts":
          setHelpOpen(true);
          return;
        case "compact":
          if (selected !== undefined && selected.status !== "berjalan") {
            void api.sendMessage(selected.id, "/compact").then(() => refresh()).catch(() => undefined);
          }
          return;
      }
    },
    [api, selected, refresh, navigate, navigateToMcp, navigateToMemory, navigateToProviders, navigateToWorkspaces, navigateToAudit, navigateToInstruksi, navigateToUsage, openGitPanel, openSecretsTab, togglePanel],
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
      const warning = dirtyWarning(session.dirtyInSource);
      setWorktreeNotice(
        warning === undefined ? undefined : { sessionId: session.id, text: warning },
      );
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
    async (
      requestId: string,
      decision: "allow" | "deny",
      message?: string,
      answers?: Record<string, string>,
    ): Promise<void> => {
      if (interruptId === undefined) return;
      await api.decidePermission(interruptId, requestId, decision, message, answers);
      void refresh();
    },
    [api, interruptId, refresh],
  );

  const headerError = selected !== undefined ? interruptError : undefined;

  // Mundur percakapan: buang pesan dan sesudahnya, lalu taruh teksnya di input.
  const rewindable = useMemo(
    () => rewindableSeqs(timeline.events ?? []),
    [timeline.events],
  );
  const reloadTimeline = timeline.reload;
  const onRewind = useCallback(
    async (seq: number): Promise<void> => {
      if (selected === undefined) return;
      const result = await api.rewindConversation(selected.id, seq);
      reloadTimeline();
      draftNonceRef.current += 1;
      setDraft({
        sessionId: selected.id,
        text: result.text,
        nonce: draftNonceRef.current,
      });
      void refresh();
    },
    [api, refresh, reloadTimeline, selected],
  );
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
    showingProviders ||
    showingMemory ||
    showingWorkspaces ||
    showingMcp ||
    showingAudit ||
    showingInstruksi ||
    showingUsage ||
    selected !== undefined
      ? "jk-main"
      : "jk-main jk-main-home";

  // Tanpa TLS di luar loopback, kata sandi dan cookie berjalan sebagai teks biasa.
  const tlsWarning = useMemo(() => {
    if (auth?.required !== true) return false;
    if (typeof window === "undefined") return false;
    return needsTlsWarning(window.location.protocol, window.location.hostname);
  }, [auth]);

  // Auth aktif tapi belum masuk: layar login penuh, draf tetap tersimpan di state.
  if (auth !== undefined && auth.required && !auth.authenticated) {
    return (
      <div class="jk-app jk-app-login">
        <LoginScreen
          error={loginError}
          retryAfterSec={retryAfterSec}
          onLogin={onLogin}
        />
      </div>
    );
  }

  return (
    <div
      class={`jk-app${drawerOpen ? " jk-drawer-open" : ""}`}
      style={{ "--side-w": `${sideWidth}px` }}
    >
      <Sidebar
        info={info}
        sessions={sessions}
        selectedId={
          showingProviders || showingMemory || showingWorkspaces || showingMcp || showingAudit || showingInstruksi || showingUsage
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
        auditActive={showingAudit}
        instruksiActive={showingInstruksi}
        usageActive={showingUsage}
        memoryProposed={memoryProposed}
        onRename={onRenameSession}
        onArchive={onArchiveSession}
        onDelete={onDeleteSession}
        notifyPrefs={notifyPrefs}
        onNotifyPrefsChange={onNotifyPrefsChange}
        onOpenPalette={openPalette}
        authRequired={auth?.required === true}
        onLogout={onLogout}
      />
      <div class="jk-scrim" onClick={closeDrawer} aria-hidden="true" />
      <PaneResizer
        width={sideWidth}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        def={SIDEBAR_DEFAULT}
        label="Lebar sidebar"
        edge="end"
        style={{ left: `${sideWidth - 3}px` }}
        clamp={sidebarWidth.clamp}
        keyFor={(current, key) => sidebarWidth.forKey(current, key, "ArrowRight")}
        onChange={setSideWidth}
        onCommit={(width) => {
          setSideWidth(width);
          try {
            saveSidebarWidth(window.localStorage, width);
          } catch {
            // penyimpanan tidak tersedia
          }
        }}
      />

      <main class={mainClass}>
        {tlsWarning && (
          <p class="jk-auth-banner" role="status">
            Tanpa HTTPS: kata sandi dan cookie sesi dikirim sebagai teks biasa di jaringan.
          </p>
        )}
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
        ) : showingAudit ? (
          <>
            <Topbar onMenu={openDrawer} />
            <div class="jk-page">
              <AuditPage api={api} sessions={sessions} />
            </div>
          </>
        ) : showingInstruksi ? (
          <>
            <Topbar onMenu={openDrawer} />
            <div class="jk-page">
              <InstruksiPage api={api} sessions={sessions} defaultCwd={info?.cwd} />
            </div>
          </>
        ) : showingUsage ? (
          <>
            <Topbar onMenu={openDrawer} />
            <div class="jk-page">
              <UsagePage api={api} sessions={sessions} />
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
                {worktreeNotice !== undefined && worktreeNotice.sessionId === selected.id && (
                  <div class="jk-worktree-notice" role="status">
                    <span>{worktreeNotice.text}</span>
                    <button
                      type="button"
                      class="jk-link-btn"
                      aria-label="Tutup peringatan worktree"
                      onClick={() => setWorktreeNotice(undefined)}
                    >
                      Tutup
                    </button>
                  </div>
                )}
                <Timeline
                  items={timeline.items}
                  connection={timeline.connection}
                  running={selected.status === "berjalan"}
                  sandboxed={selected.sandbox === "standar"}
                  cwd={selected.cwd}
                  onDecide={onDecide}
                  rewindableSeqs={rewindable}
                  onRewind={onRewind}
                />
                <ReplyBar
                  key={selected.id}
                  api={api}
                  session={selected}
                  refresh={refresh}
                  context={contextUsage(timeline.context)}
                  registry={view}
                  draft={draft !== undefined && draft.sessionId === selected.id ? draft : undefined}
                />
              </div>
              {panelOpen && (
                <Panel
                  key={selected.id}
                  api={api}
                  sessionId={selected.id}
                  session={selected}
                  eventCount={selected.eventCount}
                  status={timeline.status ?? selected.status}
                  timelineItems={timeline.items}
                  open={panelOpen}
                  onOpenChange={onPanelOpenChange}
                  tabRequest={panelTabRequest}
                  onSessionChanged={() => void refresh()}
                  width={panelW}
                />
              )}
              {panelOpen && (
                <PaneResizer
                  width={panelW}
                  min={panelWidth.spec.min}
                  max={panelWidth.spec.max}
                  def={panelWidth.spec.def}
                  label="Lebar panel"
                  edge="start"
                  style={{ right: `${panelW - 3}px` }}
                  clamp={panelWidth.clamp}
                  keyFor={(current, key) => panelWidth.forKey(current, key, "ArrowLeft")}
                  onChange={setPanelW}
                  onCommit={(width) => {
                    setPanelW(width);
                    try {
                      panelWidth.save(window.localStorage, width);
                    } catch {
                      // penyimpanan tidak tersedia
                    }
                  }}
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
