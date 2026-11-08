import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ApiClient,
  type MemoryItem,
  type MemoryLayer,
  type MemoryQuery,
  type MemoryStatus,
} from "../lib/api";
import {
  filterByLayer,
  type MemoryDraft,
  type MemoryLayerFilter,
} from "../lib/memory";
import { MemoryForm } from "./MemoryForm";
import { MemoryRow } from "./MemoryRow";

export interface MemoryPageProps {
  api: ApiClient;
  /** Folder kerja yang dikenal sesi + cwd; untuk pilihan proyek. */
  projects: string[];
  /** Dipanggil setelah aksi supaya angka usulan di sidebar ikut segar. */
  onChanged?: () => void;
}

interface TabSpec {
  id: MemoryStatus;
  label: string;
}

const TABS: TabSpec[] = [
  { id: "proposed", label: "Usulan" },
  { id: "active", label: "Aktif" },
];

const LAYER_FILTERS: { id: MemoryLayerFilter; label: string }[] = [
  { id: "semua", label: "Semua" },
  { id: "profile", label: "Profil" },
  { id: "project", label: "Proyek" },
];

const DISABLED_HINT = "Memory dimatikan (JEJAK_MEMORY=0).";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "memory tidak dapat dimuat";
}

function isDisabled(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 503;
}

export function MemoryPage({ api, projects, onChanged }: MemoryPageProps) {
  const [tab, setTab] = useState<MemoryStatus>("proposed");
  const [layerFilter, setLayerFilter] = useState<MemoryLayerFilter>("semua");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [counts, setCounts] = useState<{ proposed: number; active: number }>({
    proposed: 0,
    active: 0,
  });
  const [problems, setProblems] = useState<{ file: string; reason: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [disabled, setDisabled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [confirmRejectId, setConfirmRejectId] = useState<string | undefined>(undefined);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [failures, setFailures] = useState<Record<string, string | undefined>>({});

  const requestRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingFocusRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setLoadError(undefined);
    try {
      const query: MemoryQuery = { status: tab };
      if (layerFilter !== "semua") query.layer = layerFilter as MemoryLayer;
      const payload = await api.listMemory(query);
      if (ticket !== requestRef.current) return;
      setItems(payload.items);
      setOpenIds((current) => {
        const ids = new Set(payload.items.map((entry) => entry.id));
        return new Set([...current].filter((id) => ids.has(id)));
      });
      setCounts(payload.counts);
      setProblems(payload.problems);
      setDisabled(false);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setDisabled(isDisabled(caught));
      setLoadError(errorMessage(caught));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, [api, tab, layerFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Kembalikan fokus setelah daftar dimuat ulang karena aksi.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    headingRef.current?.focus();
  }, [items]);

  const afterAction = useCallback(async (): Promise<void> => {
    pendingFocusRef.current = true;
    setEditingId(undefined);
    setConfirmRejectId(undefined);
    setConfirmDeleteId(undefined);
    await load();
    onChanged?.();
  }, [load, onChanged]);

  const runAction = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    if (busyId !== undefined) return;
    setBusyId(id);
    setFailures((current) => ({ ...current, [id]: undefined }));
    try {
      await action();
      await afterAction();
    } catch (caught) {
      setFailures((current) => ({ ...current, [id]: errorMessage(caught) }));
      setConfirmRejectId(undefined);
      setConfirmDeleteId(undefined);
    } finally {
      setBusyId(undefined);
    }
  };

  const submitAdd = async (draft: MemoryDraft): Promise<void> => {
    if (addBusy) return;
    setAddBusy(true);
    setAddError(undefined);
    try {
      await api.createMemory({
        layer: draft.layer,
        ...(draft.layer === "project" ? { projectKey: draft.projectKey } : {}),
        title: draft.title,
        body: draft.body,
      });
      setAdding(false);
      pendingFocusRef.current = true;
      await load();
      onChanged?.();
    } catch (caught) {
      setAddError(errorMessage(caught));
    } finally {
      setAddBusy(false);
    }
  };

  const submitEdit = async (id: string, draft: MemoryDraft): Promise<void> => {
    await runAction(id, () =>
      api.updateMemory(id, { title: draft.title, body: draft.body }),
    );
  };

  const onTabKeyDown = (event: KeyboardEvent, index: number): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const next = TABS[(index + delta + TABS.length) % TABS.length]!;
    setTab(next.id);
    setConfirmDeleteId(undefined);
    setConfirmRejectId(undefined);
    setEditingId(undefined);
    tabRefs.current[next.id]?.focus();
  };

  const visible = useMemo(() => filterByLayer(items, layerFilter), [items, layerFilter]);

  const emptyMessage =
    tab === "proposed"
      ? "Tidak ada usulan. Agent akan mengusulkan memory di sini."
      : "Belum ada memory. Tambahkan preferensi atau fakta proyek.";

  return (
    <section class="jk-memory" aria-labelledby="jk-memory-title">
      <header class="jk-settings-head">
        <h2 id="jk-memory-title" ref={headingRef} tabIndex={-1} class="jk-settings-title">
          Memory
        </h2>
        <p class="jk-privacy-note">
          Hal yang diingat agent lintas sesi. Agent hanya mengusulkan; kamu yang menerima.
        </p>
      </header>

      <div class="jk-memory-head">
        <div class="jk-panel-tabs" role="tablist" aria-label="Daftar memory">
          {TABS.map((entry, index) => (
            <button
              key={entry.id}
              ref={(element) => {
                tabRefs.current[entry.id] = element;
              }}
              type="button"
              role="tab"
              id={`jk-memory-tab-${entry.id}`}
              class={`jk-panel-tab${tab === entry.id ? " jk-panel-tab-active" : ""}`}
              aria-selected={tab === entry.id}
              aria-controls={`jk-memory-panel-${entry.id}`}
              tabIndex={tab === entry.id ? 0 : -1}
              onClick={() => {
                setTab(entry.id);
                setEditingId(undefined);
                setConfirmDeleteId(undefined);
                setConfirmRejectId(undefined);
              }}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {entry.label}
              <span class="jk-panel-count">
                {entry.id === "proposed" ? counts.proposed : counts.active}
              </span>
            </button>
          ))}
        </div>

        <div class="jk-memory-filters">
          {LAYER_FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              class={`jk-memory-filter${layerFilter === entry.id ? " jk-memory-filter-active" : ""}`}
              aria-pressed={layerFilter === entry.id}
              onClick={() => setLayerFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          class="jk-button jk-memory-add"
          aria-expanded={adding}
          disabled={disabled}
          onClick={() => {
            setAdding((value) => !value);
            setAddError(undefined);
          }}
        >
          Tambah
        </button>
      </div>

      {adding && !disabled && (
        <div class="jk-memory-form-wrap">
          <MemoryForm
            projects={projects}
            busy={addBusy}
            serverError={addError}
            onSubmit={(draft) => void submitAdd(draft)}
            onCancel={() => {
              setAdding(false);
              setAddError(undefined);
            }}
          />
        </div>
      )}

      {problems.length > 0 && (
        <details class="jk-memory-problems">
          <summary class="jk-memory-warn">
            {problems.length} berkas memory dilewati karena rusak.
          </summary>
          <ul class="jk-memory-problem-list">
            {problems.map((problem) => (
              <li key={problem.file}>
                <code>{problem.file}</code>
              </li>
            ))}
          </ul>
        </details>
      )}

      {loading && <p class="jk-note">Memuat…</p>}

      {disabled ? (
        <p class="jk-note">{DISABLED_HINT}</p>
      ) : (
        loadError !== undefined && (
          <div class="jk-panel-error">
            <p class="jk-error-line" role="alert">
              {loadError}
            </p>
            <button type="button" class="jk-link-btn" onClick={() => void load()}>
              Coba lagi
            </button>
          </div>
        )
      )}

      {!loading && loadError === undefined && (
        <div
          class="jk-memory-list"
          role="tabpanel"
          id={`jk-memory-panel-${tab}`}
          aria-labelledby={`jk-memory-tab-${tab}`}
        >
          {visible.length === 0 ? (
            <p class="jk-note">{emptyMessage}</p>
          ) : (
            visible.map((item) => (
              <MemoryRow
                key={item.id}
                item={item}
                projects={projects}
                open={openIds.has(item.id)}
                editing={editingId === item.id}
                confirmingReject={confirmRejectId === item.id}
                confirmingDelete={confirmDeleteId === item.id}
                busy={busyId === item.id}
                failure={failures[item.id]}
                onToggleOpen={(isOpen) => {
                  setOpenIds((current) => {
                    const next = new Set(current);
                    if (isOpen) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  });
                }}
                onSubmitEdit={(draft) => void submitEdit(item.id, draft)}
                onCancelEdit={() => setEditingId(undefined)}
                onAskReject={() => setConfirmRejectId(item.id)}
                onAskDelete={() => setConfirmDeleteId(item.id)}
                onCancelConfirm={() => {
                  setConfirmRejectId(undefined);
                  setConfirmDeleteId(undefined);
                }}
                onConfirmReject={() => void runAction(item.id, () => api.rejectMemory(item.id))}
                onConfirmDelete={() => void runAction(item.id, () => api.deleteMemory(item.id))}
                onArchive={() => void runAction(item.id, () => api.archiveMemory(item.id))}
                onAccept={() => void runAction(item.id, () => api.acceptMemory(item.id))}
                onStartEdit={() => {
                  setConfirmRejectId(undefined);
                  setConfirmDeleteId(undefined);
                  setOpenIds((current) => new Set(current).add(item.id));
                  setEditingId(item.id);
                }}
              />
            ))
          )}
        </div>
      )}

      <p class="jk-note jk-memory-privacy">
        Memory yang dibaca agent ikut terkirim ke penyedia model.
      </p>
    </section>
  );
}
