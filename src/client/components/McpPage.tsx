import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ApiClient,
  type McpServerItem,
  type McpTestOutcome,
} from "../lib/api";
import { buildCreateInput, buildUpdateInput, type McpFormValues } from "../lib/mcp";
import { McpForm } from "./McpForm";
import { McpRow } from "./McpRow";

export interface McpPageProps {
  api: ApiClient;
}

interface Problem {
  file: string;
  reason: string;
}

const SECRET_NOTE =
  "Nilai rahasia hanya ditulis, tidak pernah ditampilkan lagi. Tool eksternal tetap meminta izin.";

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "server MCP tidak dapat dimuat";
}

function isDisabled(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 503;
}

export function McpPage({ api }: McpPageProps) {
  const [items, setItems] = useState<McpServerItem[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [disabled, setDisabled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [testingId, setTestingId] = useState<string | undefined>(undefined);
  const [tests, setTests] = useState<Record<string, McpTestOutcome | undefined>>({});
  const [failures, setFailures] = useState<Record<string, string | undefined>>({});

  const requestRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingFocusRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setLoadError(undefined);
    try {
      const payload = await api.listMcpServers();
      if (ticket !== requestRef.current) return;
      const ids = new Set(payload.items.map((entry) => entry.id));
      setItems(payload.items);
      setTests((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))),
      );
      setProblems(payload.problems);
      setDisabled(false);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setDisabled(isDisabled(caught));
      setLoadError(errorMessage(caught));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    headingRef.current?.focus();
  }, [items]);

  const afterAction = useCallback(async (): Promise<void> => {
    pendingFocusRef.current = true;
    setEditingId(undefined);
    setConfirmDeleteId(undefined);
    await load();
  }, [load]);

  const runAction = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    if (busyId !== undefined) return;
    setBusyId(id);
    setFailures((current) => ({ ...current, [id]: undefined }));
    try {
      await action();
      await afterAction();
    } catch (caught) {
      setFailures((current) => ({ ...current, [id]: errorMessage(caught) }));
      setConfirmDeleteId(undefined);
    } finally {
      setBusyId(undefined);
    }
  };

  const submitAdd = async (form: McpFormValues): Promise<void> => {
    if (addBusy) return;
    setAddBusy(true);
    setAddError(undefined);
    try {
      await api.createMcpServer(buildCreateInput(form));
      setAdding(false);
      pendingFocusRef.current = true;
      await load();
    } catch (caught) {
      setAddError(errorMessage(caught));
    } finally {
      setAddBusy(false);
    }
  };

  const submitEdit = async (id: string, form: McpFormValues): Promise<void> => {
    const original = items.find((entry) => entry.id === id);
    if (original === undefined) return;
    await runAction(id, () => api.updateMcpServer(id, buildUpdateInput(form, original)));
  };

  const runTest = async (id: string): Promise<void> => {
    if (testingId !== undefined) return;
    setTestingId(id);
    setFailures((current) => ({ ...current, [id]: undefined }));
    try {
      const result = await api.testMcpServer(id);
      setTests((current) => ({ ...current, [id]: result }));
    } catch (caught) {
      setFailures((current) => ({ ...current, [id]: errorMessage(caught) }));
    } finally {
      setTestingId(undefined);
    }
  };

  return (
    <section class="jk-mcp" aria-labelledby="jk-mcp-title">
      <header class="jk-settings-head">
        <h2 id="jk-mcp-title" ref={headingRef} tabIndex={-1} class="jk-settings-title">
          Server MCP
        </h2>
        <p class="jk-privacy-note">
          Daftarkan server MCP eksternal sekali agar tool-nya tersedia di semua sesi.
        </p>
      </header>

      {!disabled && (
        <div class="jk-mcp-head">
          <button
            type="button"
            class="jk-button jk-mcp-add"
            aria-expanded={adding}
            onClick={() => {
              setAdding((value) => !value);
              setAddError(undefined);
              setEditingId(undefined);
            }}
          >
            Tambah server
          </button>
        </div>
      )}

      {adding && !disabled && (
        <div class="jk-mcp-form-wrap">
          <McpForm
            busy={addBusy}
            serverError={addError}
            onSubmit={(form) => void submitAdd(form)}
            onCancel={() => {
              setAdding(false);
              setAddError(undefined);
            }}
          />
        </div>
      )}

      {problems.length > 0 && (
        <details class="jk-mcp-problems">
          <summary class="jk-mcp-warn">
            {problems.length} entri server MCP dilewati karena rusak.
          </summary>
          <ul class="jk-mcp-problem-list">
            {problems.map((problem, index) => (
              <li key={`${problem.file}-${index}`}>
                <code>{problem.file}</code>
              </li>
            ))}
          </ul>
        </details>
      )}

      {loading && <p class="jk-note">Memuat…</p>}

      {disabled ? (
        <p class="jk-note">{loadError ?? "Server MCP dimatikan."}</p>
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

      {!loading && !disabled && loadError === undefined && (
        <div class="jk-mcp-list">
          {items.length === 0 ? (
            <p class="jk-note">Belum ada server MCP.</p>
          ) : (
            items.map((mcp) => (
              <McpRow
                key={mcp.id}
                mcp={mcp}
                editing={editingId === mcp.id}
                confirmingDelete={confirmDeleteId === mcp.id}
                busy={busyId === mcp.id || testingId === mcp.id}
                testing={testingId === mcp.id}
                test={tests[mcp.id]}
                failure={failures[mcp.id]}
                onToggleEnabled={(enabled) =>
                  void runAction(mcp.id, () => api.updateMcpServer(mcp.id, { enabled }))
                }
                onTest={() => void runTest(mcp.id)}
                onStartEdit={() => {
                  setConfirmDeleteId(undefined);
                  setAdding(false);
                  setEditingId(mcp.id);
                }}
                onCancelEdit={() => setEditingId(undefined)}
                onSubmitEdit={(form) => void submitEdit(mcp.id, form)}
                onAskDelete={() => setConfirmDeleteId(mcp.id)}
                onCancelConfirm={() => setConfirmDeleteId(undefined)}
                onConfirmDelete={() =>
                  void runAction(mcp.id, () => api.deleteMcpServer(mcp.id))
                }
              />
            ))
          )}
        </div>
      )}

      <p class="jk-mcp-secret-note jk-note">{SECRET_NOTE}</p>
    </section>
  );
}
