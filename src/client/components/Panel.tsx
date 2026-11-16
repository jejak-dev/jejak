import { Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import type { ApiClient } from "../lib/api";
import {
  canMoveTab,
  closePane,
  closeTab,
  evenBoundary,
  flattenForNarrow,
  focusTarget,
  moveTab,
  openTool,
  openTools,
  paneOfTool,
  resizeBoundary,
  resizeBoundaryByKey,
  setActive,
  toggleMaximize,
  visibleLayout,
  type MoveDirection,
  type Pane,
  type PaneLayout,
} from "../lib/pane-layout";
import { useNarrowViewport } from "../lib/pane-narrow";
import { readPaneLayout, writePaneLayout } from "../lib/pane-prefs";
import type { PanelTab } from "../lib/panel-prefs";
import {
  PANEL_RAIL_TABS,
  TABS_WITH_REFRESH,
  TABS_WITH_REPO,
  nextPanelTabIndex,
} from "../lib/panel-rail";
import type { TimelineItem } from "../lib/timeline";
import { extractPlans, pendingPlans, type PlanEntry } from "../lib/plans";
import { latestTodos, todoProgress, type TodoItem } from "../lib/todos";
import {
  effectivePanelRepo,
  checkpointRepoNote,
  panelRepoOptions,
  repoForRequest,
} from "../lib/workspace";
import { useSessionRepos } from "../hooks";
import { ChangesTab } from "./ChangesTab";
import { BrowserTab } from "./BrowserTab";
import { CheckpointsTab } from "./CheckpointsTab";
import { FilesTab } from "./FilesTab";
import { GitTab } from "./GitTab";
import { PanelRail } from "./PanelRail";
import { PaneDivider } from "./PaneDivider";
import { PaneWindow } from "./PaneWindow";
import { PlanTab } from "./PlanTab";
import { RunnerTab } from "./RunnerTab";
import { SecretsTab } from "./SecretsTab";
import { TerminalTab } from "./TerminalTab";
import { TodosTab } from "./TodosTab";
import { WikiTab } from "./WikiTab";

export interface PanelProps {
  /** Lebar panel dalam px; default dari CSS bila kosong. */
  width?: number;
  api: ApiClient;
  sessionId: string;
  /** Sesi terpilih; diteruskan ke tab Git untuk kotak worktree. */
  session?: SessionInfo;
  eventCount: number;
  status: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Item timeline berjalan; sumber daftar langkah agent (tool TodoWrite). */
  timelineItems?: readonly TimelineItem[];
  /** Rencana yang difokuskan di tab Rencana; undefined = yang terbaru. */
  focusedPlanId?: string;
  /** Kirim keputusan rencana dari tab Rencana. */
  onDecide?: (
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
  ) => Promise<void>;
  /** Permintaan pindah tab dari luar (palette); `nonce` memaksa ulang. */
  tabRequest?: { tab: PanelTab; nonce: number };
  /** Dipanggil setelah aksi yang mengubah sesi (mis. hapus/pulihkan worktree). */
  onSessionChanged?: () => void;
  /** Kutipan wiki yang ditempel ke kolom pesan; tidak mengirim apa pun. */
  onQuote?: (text: string) => void;
}

const PANEL_LABEL =
  "Perubahan, langkah, berkas, git, checkpoint, rahasia, wiki, perintah, terminal, browser, dan rencana";

/** Kunci navigasi keyboard pada rel ikon. */
const RAIL_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

/** Isi satu tab panel; dipisah dari Panel agar bisa dipakai tiap jendela. */
interface PanelTabBodyProps {
  tab: PanelTab;
  api: ApiClient;
  sessionId: string;
  session?: SessionInfo;
  open: boolean;
  eventCount: number;
  status: string;
  refreshToken: number;
  repo?: string;
  todos: readonly TodoItem[];
  plans: readonly PlanEntry[];
  focusedPlanId?: string;
  onDecide?: (
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
  ) => Promise<void>;
  checkpointNote?: string;
  commitDraft: string;
  terminalToAttach?: string;
  onDraftChange: (value: string) => void;
  onOpenChanges: () => void;
  onOpenTerminal: (terminalId: string) => void;
  onFileCount: (count: number | undefined) => void;
  onGitCount: (count: number | undefined) => void;
  onCheckpointCount: (count: number | undefined) => void;
  onChanged: () => void;
  onSessionChanged?: () => void;
  onQuote?: (text: string) => void;
  /** Perbesar atau pulihkan jendela panel; cadangan tombol layar penuh browser. */
  onToggleMaximize?: () => void;
  /** Jendela panel sedang diperbesar? */
  maximized?: boolean;
}

/** Badan tab yang aktif; hanya tab aktif yang dipasang di jendela. */
function PanelTabBody(props: PanelTabBodyProps) {
  const {
    tab,
    api,
    sessionId,
    session,
    open,
    eventCount,
    status,
    refreshToken,
    repo,
    todos,
    plans,
    focusedPlanId,
    onDecide,
    checkpointNote,
    commitDraft,
    terminalToAttach,
    onDraftChange,
    onOpenChanges,
    onOpenTerminal,
    onFileCount,
    onGitCount,
    onCheckpointCount,
    onChanged,
    onSessionChanged,
    onQuote,
    onToggleMaximize,
    maximized,
  } = props;

  if (tab === "changes") {
    return (
      <ChangesTab
        api={api}
        sessionId={sessionId}
        open={open}
        eventCount={eventCount}
        status={status}
        refreshToken={refreshToken}
        repo={repo}
        onFileCount={onFileCount}
      />
    );
  }
  if (tab === "todos") return <TodosTab todos={todos} />;
  if (tab === "plan") {
    return (
      <PlanTab plans={plans} focusedPlanId={focusedPlanId} onDecide={onDecide} />
    );
  }
  if (tab === "checkpoints") {
    return (
      <CheckpointsTab
        api={api}
        sessionId={sessionId}
        open={open}
        eventCount={eventCount}
        status={status}
        refreshToken={refreshToken}
        repoNote={checkpointNote}
        onCount={onCheckpointCount}
        onChanged={onChanged}
      />
    );
  }
  if (tab === "git") {
    return (
      <GitTab
        api={api}
        sessionId={sessionId}
        session={session}
        open={open}
        eventCount={eventCount}
        status={status}
        refreshToken={refreshToken}
        repo={repo}
        draft={commitDraft}
        onDraftChange={onDraftChange}
        onOpenChanges={onOpenChanges}
        onCount={onGitCount}
        onChanged={onChanged}
        onSessionChanged={onSessionChanged}
      />
    );
  }
  if (tab === "rahasia") return <SecretsTab api={api} sessionId={sessionId} />;
  if (tab === "wiki") {
    return <WikiTab api={api} cwd={session?.cwd ?? ""} onQuote={onQuote} />;
  }
  if (tab === "commands") {
    return <RunnerTab api={api} cwd={session?.cwd ?? ""} onOpenTerminal={onOpenTerminal} />;
  }
  if (tab === "terminal") {
    return <TerminalTab api={api} cwd={session?.cwd ?? ""} attachId={terminalToAttach} />;
  }
  if (tab === "browser") {
    return (
      <BrowserTab api={api} onToggleMaximize={onToggleMaximize} maximized={maximized} />
    );
  }
  return (
    <FilesTab
      api={api}
      sessionId={sessionId}
      open={open}
      refreshToken={refreshToken}
      repo={repo}
      sessionRunning={status === "berjalan"}
    />
  );
}

export function Panel({
  width,
  api,
  sessionId,
  session,
  eventCount,
  status,
  open,
  onOpenChange,
  timelineItems,
  focusedPlanId,
  onDecide,
  tabRequest,
  onSessionChanged,
  onQuote,
}: PanelProps) {
  const [layout, setLayout] = useState<PaneLayout>(() => readPaneLayout());
  // Jendela yang terakhir difokuskan; menentukan tab aktif pada rel ikon.
  const [focusPaneId, setFocusPaneId] = useState<string | undefined>(undefined);
  // Layar sempit: satu jendela dengan seluruh tab digabung.
  const sempit = useNarrowViewport();
  // Sedang menyeret pembatas; penyimpanan ditunda sampai pembatas dilepas.
  const [menggeser, setMenggeser] = useState(false);
  // Permintaan memfokuskan sebuah tombol tab setelah tata letak berubah.
  const [fokusTab, setFokusTab] = useState<{ paneId: string; tab: PanelTab } | undefined>(
    undefined,
  );
  // Indeks tombol rel yang punya fokus keyboard.
  const [railFocus, setRailFocus] = useState(0);
  const [fileCount, setFileCount] = useState<number | undefined>(undefined);
  const [gitCount, setGitCount] = useState<number | undefined>(undefined);
  const [checkpointCount, setCheckpointCount] = useState<number | undefined>(undefined);
  const [refreshToken, setRefreshToken] = useState(0);
  // Draf pesan commit bertahan saat pindah tab selama panel (per sesi) hidup.
  const [commitDraft, setCommitDraft] = useState("");
  // Pilihan repo hanya disimpan di state; panel dipasang ulang per sesi, jadi
  // pindah sesi kembali ke repo utama.
  const [repoChoice, setRepoChoice] = useState<string | undefined>(undefined);
  // Terminal yang dibuat peluncur perintah; tab Terminal menempel ke sana.
  const [terminalToAttach, setTerminalToAttach] = useState<string | undefined>(undefined);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const railRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Tombol tab per jendela; dipakai untuk memfokuskan tab yang berpindah.
  const tabRefs = useRef<Record<string, Record<string, HTMLButtonElement | null>>>({});

  const repos = useSessionRepos(api, sessionId, status).repos;
  const multiRepo = repos !== undefined && repos.length > 1;
  const effective = multiRepo ? effectivePanelRepo(repos, repoChoice) : undefined;
  const repo = multiRepo ? repoForRequest(repos, repoChoice) : undefined;
  const repoOptions = multiRepo ? panelRepoOptions(repos) : [];
  const checkpointNote = checkpointRepoNote(repos);

  // Daftar langkah agent berasal dari tool TodoWrite di timeline berjalan.
  const todos = useMemo(() => latestTodos(timelineItems ?? []), [timelineItems]);
  const todoProgressValue = todoProgress(todos);
  const todoPending = todoProgressValue.total - todoProgressValue.done;

  // Dokumen rencana (ExitPlanMode) tak pernah tampil di chat; hidup di tab Rencana.
  const plans = useMemo(() => extractPlans(timelineItems ?? []), [timelineItems]);
  const planPending = pendingPlans(plans).length;

  // Jendela yang sedang difokuskan; jatuh ke jendela terakhir bila hilang.
  const paneTerfokus = useMemo(
    () =>
      layout.panes.find((pane) => pane.id === focusPaneId) ??
      layout.panes[layout.panes.length - 1],
    [layout, focusPaneId],
  );
  const railActiveId = paneTerfokus?.active;
  const terbuka = useMemo(() => new Set(openTools(layout)), [layout]);
  const tersedia = useMemo(
    () => PANEL_RAIL_TABS.filter((entry) => !terbuka.has(entry.id)),
    [terbuka],
  );

  // Tata letak yang digambar: layar sempit menggabungkan seluruh tab, dan
  // jendela yang diperbesar menyembunyikan jendela lain tanpa melepasnya.
  const renderLayout = useMemo(() => {
    if (sempit) return flattenForNarrow(layout, focusPaneId);
    return visibleLayout(layout);
  }, [sempit, layout, focusPaneId]);

  // Penyimpanan ditunda selama pembatas diseret; ditulis lagi saat dilepas.
  useEffect(() => {
    if (menggeser) return;
    writePaneLayout(layout);
  }, [layout, menggeser]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  // Fokus rel mengikuti tab aktif jendela yang difokuskan.
  useEffect(() => {
    const index = PANEL_RAIL_TABS.findIndex((entry) => entry.id === railActiveId);
    if (index >= 0) setRailFocus(index);
  }, [railActiveId]);

  // Tab yang baru berpindah atau jendela yang baru jadi aktif difokuskan.
  useEffect(() => {
    if (fokusTab === undefined) return;
    const tombol = tabRefs.current[fokusTab.paneId]?.[fokusTab.tab];
    if (tombol !== undefined && tombol !== null) tombol.focus();
    setFokusTab(undefined);
  }, [fokusTab, layout]);

  /** Buka sebuah alat; tab baru masuk ke jendela yang difokuskan. */
  const bukaTool = (tab: PanelTab, paneId?: string): void => {
    const fokus = paneId ?? focusPaneId ?? focusTarget(layout);
    const next = openTool(layout, tab, fokus);
    setLayout(next);
    const pemilik = paneOfTool(next, tab);
    if (pemilik !== undefined) setFocusPaneId(pemilik.id);
  };

  /** Jadikan tab aktif pada sebuah jendela dan fokuskan jendela itu. */
  const pilihTab = (paneId: string, tab: PanelTab): void => {
    // Layar sempit menggabungkan jendela; tab aktif mengikuti pemiliknya.
    if (sempit) {
      const pemilik = paneOfTool(layout, tab);
      if (pemilik === undefined) return;
      setLayout((current) => setActive(current, pemilik.id, tab));
      setFocusPaneId(pemilik.id);
      return;
    }
    setLayout((current) => setActive(current, paneId, tab));
    setFocusPaneId(paneId);
  };

  /** Tutup sebuah tab; jendela yang jadi kosong ikut hilang. */
  const tutupTab = (tab: PanelTab): void => {
    const pemilik = paneOfTool(layout, tab);
    const next = closeTab(layout, tab);
    setLayout(next);
    // Jendela yang jadi kosong hilang; fokus pindah ke jendela tetangga.
    if (pemilik === undefined) return;
    if (next.panes.some((entry) => entry.id === pemilik.id)) return;
    const index = layout.panes.findIndex((entry) => entry.id === pemilik.id);
    const tetangga = next.panes[index] ?? next.panes[index - 1] ?? next.panes[0];
    if (tetangga === undefined) return;
    setFocusPaneId(tetangga.id);
    setFokusTab({ paneId: tetangga.id, tab: tetangga.active });
  };

  /** Tutup sebuah jendela beserta seluruh tabnya. */
  const tutupJendela = (paneId: string): void => {
    const index = layout.panes.findIndex((entry) => entry.id === paneId);
    const next = closePane(layout, paneId);
    setLayout(next);
    setFocusPaneId((current) => (current === paneId ? undefined : current));
    // Fokus tidak boleh hilang; pindah ke tab aktif jendela tetangga.
    const tetangga = next.panes[index] ?? next.panes[index - 1] ?? next.panes[0];
    if (tetangga === undefined) return;
    setFocusPaneId(tetangga.id);
    setFokusTab({ paneId: tetangga.id, tab: tetangga.active });
  };

  /** Pindahkan tab aktif sebuah jendela ke arah atas atau bawah. */
  const pindahkanTab = (tab: PanelTab, arah: MoveDirection): void => {
    const next = moveTab(layout, tab, arah);
    if (next === layout) return;
    setLayout(next);
    const pemilik = paneOfTool(next, tab);
    if (pemilik === undefined) return;
    setFocusPaneId(pemilik.id);
    setFokusTab({ paneId: pemilik.id, tab });
  };

  /** Perbesar atau pulihkan ukuran sebuah jendela. */
  const perbesar = (paneId: string): void => {
    setLayout((current) => toggleMaximize(current, paneId));
  };

  /** Geser pembatas; dipakai saat pembatas diseret. */
  const geserPembatas = (index: number, sizeAbove: number): void => {
    setLayout((current) => {
      const delta = sizeAbove - (current.sizes[index] ?? 0);
      return resizeBoundary(current, index, delta);
    });
  };

  /** Geser pembatas dengan keyboard. */
  const geserPembatasKunci = (index: number, key: string): void => {
    setLayout((current) => resizeBoundaryByKey(current, index, key) ?? current);
  };

  /** Bagi rata dua jendela tetangga di sekitar pembatas. */
  const bagiRata = (index: number): void => {
    setLayout((current) => evenBoundary(current, index));
  };

  /** Bolehkah tab aktif sebuah jendela dipindah ke arah tertentu? */
  const bisaPindah = (pane: Pane, arah: MoveDirection): boolean => {
    if (sempit) return false;
    if (layout.maximized !== undefined) return false;
    return canMoveTab(layout, pane.active, arah);
  };

  useEffect(() => {
    if (tabRequest === undefined) return;
    bukaTool(tabRequest.tab);
  }, [tabRequest?.nonce]);

  /** Lencana jumlah pada rel ikon; 0 atau tidak diketahui disembunyikan. */
  const countFor = (id: PanelTab): number | undefined => {
    switch (id) {
      case "todos":
        return todoPending;
      case "changes":
        return fileCount;
      case "git":
        return gitCount;
      case "checkpoints":
        return checkpointCount;
      case "plan":
        return planPending > 0 ? planPending : undefined;
      default:
        return undefined;
    }
  };

  /** Terminal baru dari peluncur perintah: buka tab Terminal dan menempel. */
  const onOpenTerminal = (terminalId: string): void => {
    setTerminalToAttach(terminalId);
    bukaTool("terminal");
  };

  const onRailKeyDown = (event: KeyboardEvent, index: number): void => {
    if (!RAIL_KEYS.has(event.key)) return;
    event.preventDefault();
    const next = PANEL_RAIL_TABS[nextPanelTabIndex(event.key, index)];
    if (!next) return;
    setRailFocus(PANEL_RAIL_TABS.findIndex((entry) => entry.id === next.id));
    railRefs.current[next.id]?.focus();
  };

  return (
    // Layar sempit: panel jadi lapisan penuh; biarkan CSS yang menentukan
    // lebar (inline width akan menimpanya dan membuat panel hanya memakai
    // sebagian sisi).
    <aside
      class="jk-panel"
      style={sempit || width === undefined ? undefined : { width: `${width}px` }}
      aria-label={PANEL_LABEL}>
      <div class="jk-pane-stack">
        {renderLayout.panes.map((pane, index) => {
          const refsTab = tabRefs.current[pane.id] ?? (tabRefs.current[pane.id] = {});
          return (
            <Fragment key={pane.id}>
              {index > 0 && (
                <PaneDivider
                  index={index - 1}
                  sizeAbove={renderLayout.sizes[index - 1] ?? 0}
                  onDragStart={() => setMenggeser(true)}
                  onResize={(size) => geserPembatas(index - 1, size)}
                  onCommit={() => setMenggeser(false)}
                  onKeyResize={(key) => geserPembatasKunci(index - 1, key)}
                  onEven={() => bagiRata(index - 1)}
                />
              )}
              <PaneWindow
                pane={pane}
                size={renderLayout.sizes[index] ?? 1}
                isFirst={index === 0}
                paneCount={renderLayout.panes.length}
                availableTools={tersedia}
                countFor={countFor}
                showRepo={multiRepo && TABS_WITH_REPO.includes(pane.active)}
                repoLabel={effective}
                repoOptions={repoOptions}
                onRepoChange={setRepoChoice}
                showRefresh={TABS_WITH_REFRESH.includes(pane.active)}
                narrow={sempit}
                maximized={layout.maximized === pane.id}
                canMoveUp={bisaPindah(pane, "atas")}
                canMoveDown={bisaPindah(pane, "bawah")}
                onSelectTab={(tab) => pilihTab(pane.id, tab)}
                onCloseTab={tutupTab}
                onOpenTool={(tab) => bukaTool(tab, pane.id)}
                onClosePane={() => tutupJendela(pane.id)}
                onClosePanel={() => onOpenChange(false)}
                onRefresh={() => setRefreshToken((value) => value + 1)}
                onMoveUp={() => pindahkanTab(pane.active, "atas")}
                onMoveDown={() => pindahkanTab(pane.active, "bawah")}
                onToggleMaximize={() => perbesar(pane.id)}
                closeRef={index === 0 ? closeRef : undefined}
                tabRefs={refsTab}
              >
                <PanelTabBody
                  tab={pane.active}
                  api={api}
                  sessionId={sessionId}
                  session={session}
                  open={open}
                  eventCount={eventCount}
                  status={status}
                  refreshToken={refreshToken}
                  repo={repo}
                  todos={todos}
                  plans={plans}
                  focusedPlanId={focusedPlanId}
                  onDecide={onDecide}
                  checkpointNote={checkpointNote}
                  commitDraft={commitDraft}
                  terminalToAttach={terminalToAttach}
                  onDraftChange={setCommitDraft}
                  onOpenChanges={() => bukaTool("changes")}
                  onOpenTerminal={onOpenTerminal}
                  onFileCount={setFileCount}
                  onGitCount={setGitCount}
                  onCheckpointCount={setCheckpointCount}
                  onChanged={() => setRefreshToken((value) => value + 1)}
                  onSessionChanged={onSessionChanged}
                  onQuote={onQuote}
                  onToggleMaximize={sempit ? undefined : () => perbesar(pane.id)}
                  maximized={layout.maximized === pane.id}
                />
              </PaneWindow>
            </Fragment>
          );
        })}
      </div>

      <PanelRail
        openTabs={[...terbuka]}
        activeTab={railActiveId}
        focusIndex={railFocus}
        countFor={countFor}
        onOpen={(id) => bukaTool(id)}
        onKeyDown={(event, index) => onRailKeyDown(event, index)}
        railRefs={railRefs.current}
      />
    </aside>
  );
}
