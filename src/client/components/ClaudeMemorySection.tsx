import { useEffect, useState } from "preact/hooks";
import type { VNode } from "preact";
import { ApiError, type ApiClient } from "../lib/api";
import {
  claudeMemoryCount,
  claudeMemoryDescriptionLine,
  claudeMemoryTypeLabel,
  type ClaudeMemoryItem,
  type ClaudeMemoryResponse,
} from "../lib/claude-memory";
import { folderName, formatRelative } from "../lib/format";
import { Markdown } from "./Markdown";

export interface ClaudeMemorySectionProps {
  api: ApiClient;
  /** Kunci proyek yang dibaca; biasanya folder kerja sesi. */
  projects: string[];
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
}

const EMPTY_MESSAGE = "Belum ada memory Claude Code untuk proyek ini.";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "memory Claude Code tidak dapat dimuat";
}

/** Baris memory Claude Code; isi dibuka lewat `details` (baca-saja). */
export function ClaudeMemoryRow({ item }: { item: ClaudeMemoryItem }): VNode {
  const description = claudeMemoryDescriptionLine(item);
  return (
    <details class="jk-claude-row">
      <summary>
        <span class="jk-memory-title">{item.title}</span>
        {description !== "" && <span class="jk-claude-desc">{description}</span>}
        <span class="jk-claude-type">{claudeMemoryTypeLabel(item.type)}</span>
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
        const dirs = state.response?.dirs ?? [];
        const total = state.response === undefined ? 0 : claudeMemoryCount(state.response);
        return (
          <div class="jk-claude-project" key={state.project}>
            {states.length > 1 && (
              <p class="jk-claude-project-name">{folderName(state.project)}</p>
            )}
            {state.loading && <p class="jk-note">Memuat…</p>}
            {state.error !== undefined && (
              <p class="jk-error-line" role="alert">
                {state.error}
              </p>
            )}
            {!state.loading && state.error === undefined && total === 0 && (
              <p class="jk-note">{EMPTY_MESSAGE}</p>
            )}
            {!state.loading && state.error === undefined && total > 0 && (
              <div class="jk-claude-list">
                {dirs.map((dir) => (
                  <div class="jk-claude-dir" key={dir.label}>
                    {dirs.length > 1 && <p class="jk-note">{dir.label}</p>}
                    {dir.items.map((item) => (
                      <ClaudeMemoryRow item={item} key={`${dir.label}/${item.file}`} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function ClaudeMemorySection({
  api,
  projects,
}: ClaudeMemorySectionProps): VNode {
  const [states, setStates] = useState<ClaudeMemoryProjectState[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (projects.length === 0) {
      setStates([]);
      return () => {
        cancelled = true;
      };
    }
    setStates(
      projects.map((project) => ({
        project,
        response: undefined,
        loading: true,
        error: undefined,
      })),
    );
    void Promise.all(
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
    ).then((loaded) => {
      if (!cancelled) setStates(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [api, projects]);

  return <ClaudeMemorySectionView states={states} />;
}
