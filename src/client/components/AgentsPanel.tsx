import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type ClaudeAgentItem, type ClaudeScope } from "../lib/api";
import {
  agentSummary,
  agentTemplate,
  byteLength,
  isDirty,
  scopeLabel,
  validSkillName,
} from "../lib/instruksi";
import { Select } from "./Select";

/** Batas berkas subagent yang sama dengan server. */
const AGENT_MAX_BYTES = 64 * 1024;

const AGENTS_NOTE =
  "Subagent adalah berkas .claude/agents/<nama>.md (proyek) atau ~/.claude/agents (pengguna; dipakai sesi bila \"Muat pengaturan pengguna\" nyala). Agent utama mendelegasikan tugas ke subagent lewat tool Task; izin, sandbox, dan audit tetap berlaku.";

interface EditorState {
  scope: ClaudeScope;
  name: string;
  original: string;
  content: string;
  isNew: boolean;
}

interface NewAgentState {
  scope: ClaudeScope;
  name: string;
}

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return caught instanceof Error ? caught.message : "Permintaan gagal.";
}

export interface AgentsPanelProps {
  api: ApiClient;
  cwd: string;
}

export function AgentsPanel({ api, cwd }: AgentsPanelProps) {
  const [agents, setAgents] = useState<ClaudeAgentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [editor, setEditor] = useState<EditorState | undefined>();
  const [editorError, setEditorError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<NewAgentState | undefined>();
  const reqRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    reqRef.current += 1;
    const ticket = reqRef.current;
    if (cwd === "") {
      setAgents([]);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const list = await api.listAgents(cwd);
      if (ticket === reqRef.current) setAgents(list);
    } catch (caught) {
      if (ticket !== reqRef.current) return;
      setAgents([]);
      setError(errorMessage(caught));
    } finally {
      if (ticket === reqRef.current) setLoading(false);
    }
  }, [api, cwd]);

  useEffect(() => {
    setEditor(undefined);
    setCreating(undefined);
    void load();
  }, [load]);

  const open = async (agent: ClaudeAgentItem): Promise<void> => {
    setEditorError(undefined);
    try {
      const file = await api.getAgent(agent.scope, agent.name, cwd);
      setEditor({
        scope: agent.scope,
        name: agent.name,
        original: file.content,
        content: file.content,
        isNew: false,
      });
    } catch (caught) {
      setEditorError(errorMessage(caught));
    }
  };

  const openNew = (): void => {
    if (creating === undefined) return;
    const name = creating.name.trim();
    if (!validSkillName(name)) {
      setEditorError("Nama harus huruf kecil, angka, atau tanda hubung (maks 64).");
      return;
    }
    if (agents.some((agent) => agent.scope === creating.scope && agent.name === name)) {
      setEditorError("Subagent dengan nama itu sudah ada.");
      return;
    }
    setEditorError(undefined);
    const content = agentTemplate(name);
    setEditor({ scope: creating.scope, name, original: "", content, isNew: true });
    setCreating(undefined);
  };

  const save = async (): Promise<void> => {
    if (editor === undefined || busy) return;
    setBusy(true);
    setEditorError(undefined);
    try {
      const file = await api.putAgent(editor.scope, editor.name, editor.content, cwd);
      setEditor({ ...editor, original: file.content, content: file.content, isNew: false });
      await load();
    } catch (caught) {
      setEditorError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const tooBig = editor !== undefined && byteLength(editor.content) > AGENT_MAX_BYTES;

  return (
    <div
      class="jk-instruksi-panel"
      role="tabpanel"
      id="jk-instruksi-panel-agents"
      aria-labelledby="jk-instruksi-tab-agents"
    >
      <div class="jk-instruksi-panel-head">
        <button
          type="button"
          class="jk-button jk-instruksi-add"
          disabled={cwd === ""}
          aria-expanded={creating !== undefined}
          onClick={() =>
            setCreating(creating === undefined ? { scope: "project", name: "" } : undefined)
          }
        >
          Subagent baru
        </button>
      </div>

      {creating !== undefined && (
        <div class="jk-instruksi-new">
          <div class="jk-field-row">
            <div class="jk-field">
              <span class="jk-label">Cakupan</span>
              <Select
                ariaLabel="Cakupan subagent baru"
                value={creating.scope}
                options={[
                  { value: "project", label: "Proyek" },
                  { value: "user", label: "Pengguna" },
                ]}
                onChange={(value) =>
                  setCreating({
                    ...creating,
                    scope: value === "user" ? "user" : "project",
                  })
                }
              />
            </div>
            <div class="jk-field">
              <label class="jk-label" for="jk-agent-new-name">
                Nama subagent
              </label>
              <input
                id="jk-agent-new-name"
                class="jk-input jk-input-code"
                type="text"
                value={creating.name}
                autoComplete="off"
                placeholder="nama-subagent"
                onInput={(event) => setCreating({ ...creating, name: event.currentTarget.value })}
              />
            </div>
          </div>
          <div class="jk-form-actions">
            <button type="button" class="jk-button" onClick={openNew}>
              Buka editor
            </button>
            <button type="button" class="jk-button" onClick={() => setCreating(undefined)}>
              Batal
            </button>
          </div>
        </div>
      )}

      {editorError !== undefined && (
        <p class="jk-error-line" role="alert">
          {editorError}
        </p>
      )}

      {editor !== undefined && (
        <div class="jk-instruksi-editor">
          <div class="jk-instruksi-editor-head">
            <span class="jk-label">
              {editor.isNew ? "Subagent baru" : "Sunting subagent"}: {editor.name} (
              {scopeLabel(editor.scope)})
            </span>
          </div>
          <textarea
            class="jk-textarea jk-instruksi-text"
            rows={14}
            aria-label={`Isi subagent ${editor.name}`}
            value={editor.content}
            onInput={(event) => setEditor({ ...editor, content: event.currentTarget.value })}
          />
          <div class="jk-instruksi-actions">
            <button
              type="button"
              class="jk-button jk-button-primary"
              disabled={busy || !isDirty(editor.original, editor.content) || tooBig}
              onClick={() => void save()}
            >
              {busy ? "Menyimpan…" : "Simpan"}
            </button>
            <button
              type="button"
              class="jk-button"
              disabled={busy}
              onClick={() => setEditor(undefined)}
            >
              Tutup
            </button>
            <span class="jk-help jk-instruksi-count">
              {Math.ceil(byteLength(editor.content) / 1024)} KB / 64 KB
            </span>
          </div>
        </div>
      )}

      {loading && (
        <p class="jk-note" role="status" aria-live="polite">
          Memuat…
        </p>
      )}

      {!loading && error !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {error}
          </p>
          <button type="button" class="jk-link-btn" onClick={() => void load()}>
            Coba lagi
          </button>
        </div>
      )}

      {!loading && error === undefined && agents.length === 0 && (
        <p class="jk-note">Belum ada subagent.</p>
      )}

      {!loading && error === undefined && agents.length > 0 && (
        <ul class="jk-instruksi-list">
          {agents.map((agent) => (
            <li class="jk-instruksi-row" key={`${agent.scope}:${agent.name}`}>
              <button
                type="button"
                class="jk-link-btn jk-instruksi-name"
                onClick={() => void open(agent)}
              >
                {agent.name}
              </button>
              <span class="jk-instruksi-desc" title={agent.description}>
                {agent.description}
              </span>
              <span class="jk-badge jk-badge-muted">{scopeLabel(agent.scope)}</span>
              <span class="jk-badge jk-badge-muted" title="Model dan tool">
                {agentSummary(agent)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p class="jk-note jk-instruksi-note">{AGENTS_NOTE}</p>
    </div>
  );
}
