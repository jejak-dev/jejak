import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import { ApiError, type ApiClient } from "../lib/api";
import {
  claudeMemoryDescriptionLine,
  claudeMemoryTypeLabel,
  type ClaudeMemoryItem,
  type ClaudeMemoryResponse,
} from "../lib/claude-memory";
import { folderName, formatRelative } from "../lib/format";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

export interface ClaudeMemorySectionProps {
  api: ApiClient;
  /** Kunci proyek yang dibaca; biasanya folder kerja sesi. */
  projects: string[];
  /** Id memory Jejak yang tampil di daftar Jejak; berkasnya disembunyikan. */
  jejakIds?: readonly string[];
}

/** Keadaan satu proyek pada tampilan bagian memory Claude Code. */
export interface ClaudeMemoryProjectState {
  project: string;
  response: ClaudeMemoryResponse | undefined;
  loading: boolean;
  error: string | undefined;
}

/** Tampilan bagian memory Claude Code tanpa pemuatan data. */
export interface ClaudeMemorySectionViewProps {
  states: ClaudeMemoryProjectState[];
  /** Id memory Jejak yang sudah tampil di daftar Jejak. */
  jejakIds?: readonly string[];
  /** Kunci proyek yang dibuka; lipatan lain tertutup. */
  openProjects?: ReadonlySet<string>;
  /** Kunci baris yang dibuka: `${label folder}/${nama berkas}`. */
  openItems?: ReadonlySet<string>;
  /** Dipanggil saat lipatan proyek dibuka atau ditutup. */
  onToggleProject?: (project: string, open: boolean) => void;
  /** Dipanggil saat baris memory dibuka atau ditutup. */
  onToggleItem?: (key: string, open: boolean) => void;
}

/** Properti baris memory; keadaan buka opsional agar tak terkontrol. */
export interface ClaudeMemoryRowProps {
  item: ClaudeMemoryItem;
  /** True bila baris terbuka; `undefined` berarti tak dikendalikan. */
  open?: boolean;
  /** Dipanggil saat baris dibuka atau ditutup. */
  onToggle?: (open: boolean) => void;
}

const EMPTY_MESSAGE = "Belum ada memory Claude Code untuk proyek ini.";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "memory Claude Code tidak dapat dimuat";
}

/**
 * Kunci isi daftar proyek. Dipakai sebagai dependensi efek pemuatan agar
 * penggantian referensi tak memicu muat ulang.
 */
export function claudeProjectsKey(projects: readonly string[]): string {
  return projects.join("\n");
}

/** Proyek yang dibuka secara bawaan: satu proyek saja. */
export function defaultOpenProjects(projects: readonly string[]): ReadonlySet<string> {
  if (projects.length !== 1) return new Set<string>();
  return new Set<string>([projects[0] as string]);
}

/**
 * Ambil memory tiap proyek. Galat satu proyek tak menggagalkan yang lain.
 */
export async function loadClaudeProjectStates(
  api: ApiClient,
  projects: readonly string[],
): Promise<ClaudeMemoryProjectState[]> {
  return Promise.all(
    projects.map(async (project): Promise<ClaudeMemoryProjectState> => {
      try {
        const response = await api.listClaudeMemory(project);
        return { project, response, loading: false, error: undefined };
      } catch (caught) {
        return {
          project,
          response: undefined,
          loading: false,
          error: errorMessage(caught),
        };
      }
    }),
  );
}

/**
 * Gabungkan keadaan lama dan baru. Saat muat ulang, isi lama tak
 * dikosongkan; isi baru menggantikannya secara diam-diam.
 */
export function mergeClaudeProjectStates(
  previous: readonly ClaudeMemoryProjectState[],
  next: readonly ClaudeMemoryProjectState[],
): ClaudeMemoryProjectState[] {
  const before = new Map<string, ClaudeMemoryProjectState>();
  for (const state of previous) before.set(state.project, state);
  return next.map((state) => {
    const old = before.get(state.project);
    if (old === undefined) return state;
    if (state.loading) return { ...old, loading: true, error: undefined };
    if (state.error !== undefined) return { ...old, loading: false, error: state.error };
    return state;
  });
}

/**
 * True bila berkas ini ditulis Jejak dan memory aslinya sudah tampil di
 * daftar Jejak; berkas seperti itu disembunyikan agar tak Appear dua kali.
 */
export function isDuplicateJejakItem(
  item: ClaudeMemoryItem,
  jejakIds: readonly string[],
): boolean {
  return item.jejakId !== undefined && jejakIds.includes(item.jejakId);
}

/** Baris memory Claude Code; isi dibuka lewat `details` (baca-saja). */
export function ClaudeMemoryRow({ item, open, onToggle }: ClaudeMemoryRowProps): VNode {
  const description = claudeMemoryDescriptionLine(item);
  return (
    <details
      class="jk-claude-row"
      open={open === true ? true : undefined}
      onToggle={
        onToggle === undefined
          ? undefined
          : (event) => onToggle(event.currentTarget.open)
      }
    >
      <summary>
        <span class="jk-memory-title">{item.title}</span>
        {description !== "" && <span class="jk-claude-desc">{description}</span>}
        <span class="jk-claude-type">{claudeMemoryTypeLabel(item.type)}</span>
        {item.jejakId !== undefined && (
          <span class="jk-claude-badge">Jejak</span>
        )}
        <span class="jk-claude-time">{formatRelative(item.updatedAt, new Date())}</span>
        <span class="jk-claude-origin">Claude</span>
      </summary>
      <div class="jk-claude-body">
        <Markdown text={item.body} />
        {item.truncated && (
          <p class="jk-note">Isi dipotong karena berkas terlalu besar.</p>
        )}
      </div>
    </details>
  );
}

export function ClaudeMemorySectionView(props: ClaudeMemorySectionViewProps): VNode {
  const states = props.states;
  const jejakIds = props.jejakIds ?? [];
  const openProjects =
    props.openProjects ?? defaultOpenProjects(states.map((state) => state.project));
  const openItems = props.openItems ?? new Set<string>();
  return (
    <section class="jk-claude-memory" aria-labelledby="jk-claude-memory-title">
      <header class="jk-claude-head">
        <h3 class="jk-settings-title" id="jk-claude-memory-title">
          Dari Claude Code
        </h3>
        <p class="jk-privacy-note">Hanya baca; dikelola Claude Code.</p>
      </header>

      {states.length === 0 && (
        <p class="jk-note">Belum ada folder proyek yang dikenal.</p>
      )}

      {states.map((state) => {
        const dirs = (state.response?.dirs ?? []).map((dir) => ({
          ...dir,
          items: dir.items.filter((item) => !isDuplicateJejakItem(item, jejakIds)),
        }));
        const total = dirs.reduce((sum, dir) => sum + dir.items.length, 0);
        const open = openProjects.has(state.project);
        return (
          <details
            class="jk-claude-project"
            key={state.project}
            open={open ? true : undefined}
            onToggle={
              props.onToggleProject === undefined
                ? undefined
                : (event) => props.onToggleProject?.(state.project, event.currentTarget.open)
            }
          >
            <summary>
              <span class="jk-chev">
                <Icon name="chevron" />
              </span>
              <span class="jk-claude-project-name">{folderName(state.project)}</span>
              <span class="jk-claude-project-count">
                · {total === 0 ? "kosong" : total}
              </span>
              {state.error !== undefined && (
                <span class="jk-claude-project-state">gagal dimuat</span>
              )}
            </summary>
            <div class="jk-claude-project-body">
              {state.loading && state.response === undefined && (
                <p class="jk-note">Memuat…</p>
              )}
              {state.error !== undefined && (
                <p class="jk-error-line" role="alert">
                  {state.error}
                </p>
              )}
              {state.response !== undefined &&
                !state.loading &&
                state.error === undefined &&
                total === 0 && <p class="jk-note">{EMPTY_MESSAGE}</p>}
              {state.response !== undefined && total > 0 && (
                <div class="jk-claude-list">
                  {dirs.map((dir) => (
                    <div class="jk-claude-dir" key={dir.label}>
                      {dirs.length > 1 && <p class="jk-note">{dir.label}</p>}
                      {dir.items.map((item) => {
                        const rowKey = `${dir.label}/${item.file}`;
                        return (
                          <ClaudeMemoryRow
                            item={item}
                            key={rowKey}
                            open={openItems.has(rowKey)}
                            onToggle={
                              props.onToggleItem === undefined
                                ? undefined
                                : (next) => props.onToggleItem?.(rowKey, next)
                            }
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        );
      })}
    </section>
  );
}

export function ClaudeMemorySection({
  api,
  projects,
  jejakIds,
}: ClaudeMemorySectionProps): VNode {
  const [states, setStates] = useState<ClaudeMemoryProjectState[]>([]);
  const [toggles, setToggles] = useState<{
    opened: ReadonlySet<string>;
    closed: ReadonlySet<string>;
  }>(() => ({ opened: new Set<string>(), closed: new Set<string>() }));
  const [openItems, setOpenItems] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // Referensi terbaru dipakai di dalam efek; dependensinya isi daftar,
  // bukan referensinya, agar penyegaran polling tak memicu muat ulang.
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const projectsKey = claudeProjectsKey(projects);

  useEffect(() => {
    const list = projectsRef.current;
    let cancelled = false;
    if (list.length === 0) {
      setStates([]);
      return () => {
        cancelled = true;
      };
    }
    setStates((previous) =>
      mergeClaudeProjectStates(
        previous,
        list.map((project) => ({
          project,
          response: undefined,
          loading: true,
          error: undefined,
        })),
      ),
    );
    void loadClaudeProjectStates(api, list).then((loaded) => {
      if (!cancelled) setStates((previous) => mergeClaudeProjectStates(previous, loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [api, projectsKey]);

  const toggleProject = useCallback((project: string, open: boolean): void => {
    setToggles((previous) => {
      const opened = new Set(previous.opened);
      const closed = new Set(previous.closed);
      if (open) {
        opened.add(project);
        closed.delete(project);
      } else {
        opened.delete(project);
        closed.add(project);
      }
      return { opened, closed };
    });
  }, []);

  const toggleItem = useCallback((key: string, open: boolean): void => {
    setOpenItems((previous) => {
      const next = new Set(previous);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Satu proyek dibuka bawaan; proyek yang ditutup manual tetap tertutup.
  const openProjects = useMemo(() => {
    const next = new Set(toggles.opened);
    if (projects.length === 1) {
      const project = projects[0] as string;
      if (!toggles.closed.has(project)) next.add(project);
    }
    return next;
  }, [toggles, projects]);

  return (
    <ClaudeMemorySectionView
      states={states}
      openProjects={openProjects}
      openItems={openItems}
      onToggleProject={toggleProject}
      onToggleItem={toggleItem}
      {...(jejakIds === undefined ? {} : { jejakIds })}
    />
  );
}
