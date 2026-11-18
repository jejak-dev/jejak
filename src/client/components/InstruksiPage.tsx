import { AgentsPanel } from "./AgentsPanel";
import { PluginsPanel } from "./PluginsPanel";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { invalidateCommands } from "../hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import {
  ApiError,
  type ApiClient,
  type ClaudeConfigItem,
  type ClaudeHookItem,
  type ClaudeInstructions,
  type ClaudeScope,
  type ClaudeSkillItem,
} from "../lib/api";
import {
  byteLength,
  hookEventLine,
  hookSourceLabel,
  INSTRUKSI_MAX_BYTES,
  isDirty,
  overLimit,
  projectChoices,
  scopeLabel,
  skillBadge,
  skillTemplate,
  validSkillName,
} from "../lib/instruksi";
import { Select } from "./Select";

export interface InstruksiPageProps {
  api: ApiClient;
  sessions: SessionInfo[];
  defaultCwd?: string;
}

type TabId = "claude" | "skills" | "agents" | "hooks" | "plugins";

const TABS: { id: TabId; label: string }[] = [
  { id: "claude", label: "CLAUDE.md" },
  { id: "skills", label: "Skills" },
  { id: "agents", label: "Subagent" },
  { id: "hooks", label: "Hooks" },
  { id: "plugins", label: "Plugin" },
];

const SKILLS_NOTE =
  "Menonaktifkan hanya menyembunyikan skill dari agent (filter konteks); berkasnya tetap ada.";

const HOOKS_NOTE =
  "Hooks dibaca dari .claude/settings.json (proyek, lokal) dan ~/.claude/settings.json. Untuk menambah atau mengubah perintah hook, sunting berkas secara manual.";

const DISABLED_NOTE = "Pengaturan Claude dimatikan (JEJAK_CLAUDE_CONFIG=0).";

const PENDING_ACTION_NOTE = "Draf belum disimpan.";

const SKILLS_USER_OFF_NOTE =
  'Skill berlabel "Pengguna" (dari ~/.claude) belum dipakai sesi dan tak muncul di menu "/" komposer: nyalakan "Muat pengaturan pengguna" di atas.';

const USER_OFF_NOTE =
  'CLAUDE.md pengguna hanya dipakai sesi bila "Muat pengaturan pengguna" nyala';

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "instruksi tidak dapat dimuat";
}

function isDisabled(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 503;
}

function sizeLabel(text: string): string {
  return `${byteLength(text)} / ${INSTRUKSI_MAX_BYTES} byte`;
}

type PendingSwitch =
  | { kind: "scope"; scope: ClaudeScope }
  | { kind: "cwd"; cwd: string };

interface Editor {
  scope: ClaudeScope;
  name: string;
  original: string;
  content: string;
  isNew: boolean;
}

export function InstruksiPage({ api, sessions, defaultCwd }: InstruksiPageProps) {
  const projects = useMemo(() => projectChoices(sessions, defaultCwd), [defaultCwd, sessions]);

  const [cwd, setCwd] = useState<string>(() => projects[0]?.cwd ?? "");
  const [tab, setTab] = useState<TabId>("claude");

  const [config, setConfig] = useState<ClaudeConfigItem | undefined>(undefined);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | undefined>(undefined);
  const [configDisabled, setConfigDisabled] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);

  const [scope, setScope] = useState<ClaudeScope>("project");
  const [instructions, setInstructions] = useState<ClaudeInstructions | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [instructionsLoading, setInstructionsLoading] = useState(false);
  const [instructionsError, setInstructionsError] = useState<string | undefined>(undefined);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<PendingSwitch | undefined>(undefined);

  const [skills, setSkills] = useState<ClaudeSkillItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | undefined>(undefined);
  const [skillBusy, setSkillBusy] = useState<string | undefined>(undefined);
  const [editor, setEditor] = useState<Editor | undefined>(undefined);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | undefined>(undefined);
  const [newSkill, setNewSkill] = useState<{ scope: ClaudeScope; name: string } | undefined>(
    undefined,
  );

  const [hooks, setHooks] = useState<ClaudeHookItem[]>([]);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [hooksError, setHooksError] = useState<string | undefined>(undefined);

  const configReqRef = useRef(0);
  const instructionsReqRef = useRef(0);
  const skillsReqRef = useRef(0);
  const hooksReqRef = useRef(0);
  const editorReqRef = useRef(0);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingFocusRef = useRef(false);

  const dirty = instructions !== undefined && isDirty(instructions.content, draft);

  const loadConfig = useCallback(async (): Promise<void> => {
    configReqRef.current += 1;
    const ticket = configReqRef.current;
    setConfigLoading(true);
    setConfigError(undefined);
    try {
      const payload = await api.getClaudeConfig();
      if (ticket !== configReqRef.current) return;
      setConfig(payload);
      setConfigDisabled(false);
    } catch (caught) {
      if (ticket !== configReqRef.current) return;
      if (isDisabled(caught)) {
        setConfigDisabled(true);
        setConfigError(undefined);
      } else {
        setConfigError(errorMessage(caught));
      }
    } finally {
      if (ticket === configReqRef.current) setConfigLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const updateConfig = async (patch: {
    userSettings?: boolean;
    hooksEnabled?: boolean;
  }): Promise<void> => {
    if (configBusy) return;
    setConfigBusy(true);
    setConfigError(undefined);
    try {
      const next = await api.putClaudeConfig(patch);
      invalidateCommands(api);
      setConfig(next);
    } catch (caught) {
      setConfigError(errorMessage(caught));
    } finally {
      setConfigBusy(false);
    }
  };

  const projectCwd = scope === "project" ? cwd : undefined;
  const canLoadInstructions = scope === "user" || cwd !== "";

  const loadInstructions = useCallback(async (): Promise<void> => {
    if (!canLoadInstructions) {
      setInstructions(undefined);
      setDraft("");
      return;
    }
    instructionsReqRef.current += 1;
    const ticket = instructionsReqRef.current;
    setInstructionsLoading(true);
    setInstructionsError(undefined);
    setSaveError(undefined);
    try {
      const payload = await api.getInstructions(scope, projectCwd);
      if (ticket !== instructionsReqRef.current) return;
      setInstructions(payload);
      setDraft(payload.content);
    } catch (caught) {
      if (ticket !== instructionsReqRef.current) return;
      setInstructions(undefined);
      setDraft("");
      setInstructionsError(errorMessage(caught));
    } finally {
      if (ticket === instructionsReqRef.current) setInstructionsLoading(false);
    }
  }, [api, canLoadInstructions, projectCwd, scope]);

  useEffect(() => {
    if (tab !== "claude") return;
    void loadInstructions();
  }, [loadInstructions, tab]);

  const loadSkills = useCallback(async (): Promise<void> => {
    if (cwd === "") {
      setSkills([]);
      return;
    }
    skillsReqRef.current += 1;
    const ticket = skillsReqRef.current;
    setSkillsLoading(true);
    setSkillsError(undefined);
    try {
      const payload = await api.listSkills(cwd);
      if (ticket !== skillsReqRef.current) return;
      setSkills(payload);
    } catch (caught) {
      if (ticket !== skillsReqRef.current) return;
      setSkills([]);
      setSkillsError(errorMessage(caught));
    } finally {
      if (ticket === skillsReqRef.current) setSkillsLoading(false);
    }
  }, [api, cwd]);

  useEffect(() => {
    if (tab !== "skills") return;
    void loadSkills();
  }, [loadSkills, tab]);

  const loadHooks = useCallback(async (): Promise<void> => {
    if (cwd === "") {
      setHooks([]);
      return;
    }
    hooksReqRef.current += 1;
    const ticket = hooksReqRef.current;
    setHooksLoading(true);
    setHooksError(undefined);
    try {
      const payload = await api.listHooks(cwd);
      if (ticket !== hooksReqRef.current) return;
      setHooks(payload);
    } catch (caught) {
      if (ticket !== hooksReqRef.current) return;
      setHooks([]);
      setHooksError(errorMessage(caught));
    } finally {
      if (ticket === hooksReqRef.current) setHooksLoading(false);
    }
  }, [api, cwd]);

  useEffect(() => {
    if (tab !== "hooks") return;
    void loadHooks();
  }, [loadHooks, tab]);

  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    headingRef.current?.focus();
  }, [skills, hooks]);

  const applySwitch = (next: PendingSwitch): void => {
    setPending(undefined);
    setInstructions(undefined);
    if (next.kind === "scope") {
      setScope(next.scope);
    } else {
      setCwd(next.cwd);
      setEditor(undefined);
      setNewSkill(undefined);
    }
  };

  const requestScope = (next: ClaudeScope): void => {
    if (next === scope) return;
    if (dirty) {
      setPending({ kind: "scope", scope: next });
      return;
    }
    applySwitch({ kind: "scope", scope: next });
  };

  const requestCwd = (next: string): void => {
    if (next === cwd) return;
    if (dirty) {
      setPending({ kind: "cwd", cwd: next });
      return;
    }
    applySwitch({ kind: "cwd", cwd: next });
  };

  const saveInstructions = async (): Promise<void> => {
    if (savingInstructions || instructions === undefined) return;
    if (!isDirty(instructions.content, draft) || overLimit(draft)) return;
    setSavingInstructions(true);
    setSaveError(undefined);
    try {
      const payload = await api.putInstructions(scope, draft, projectCwd);
      setInstructions(payload);
      setDraft(payload.content);
    } catch (caught) {
      setSaveError(errorMessage(caught));
    } finally {
      setSavingInstructions(false);
    }
  };

  const onTabKeyDown = (event: KeyboardEvent, index: number): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const next = TABS[(index + delta + TABS.length) % TABS.length]!;
    // Draf CLAUDE.md tetap disimpan di state halaman, jadi pindah tab aman.
    setTab(next.id);
    tabRefs.current[next.id]?.focus();
  };

  const toggleSkill = async (skill: ClaudeSkillItem): Promise<void> => {
    if (skillBusy !== undefined) return;
    setSkillBusy(`${skill.scope}:${skill.name}`);
    setSkillsError(undefined);
    try {
      await api.setSkillEnabled(skill.scope, skill.name, !skill.enabled, cwd);
      invalidateCommands(api);
      pendingFocusRef.current = true;
      await loadSkills();
    } catch (caught) {
      setSkillsError(errorMessage(caught));
    } finally {
      setSkillBusy(undefined);
    }
  };

  const openSkill = async (skill: ClaudeSkillItem): Promise<void> => {
    editorReqRef.current += 1;
    const ticket = editorReqRef.current;
    setEditorError(undefined);
    setNewSkill(undefined);
    try {
      const payload = await api.getSkill(skill.scope, skill.name, cwd);
      if (ticket !== editorReqRef.current) return;
      setEditor({
        scope: skill.scope,
        name: skill.name,
        original: payload.content,
        content: payload.content,
        isNew: false,
      });
    } catch (caught) {
      if (ticket !== editorReqRef.current) return;
      setEditorError(errorMessage(caught));
    }
  };

  const startNewSkill = (): void => {
    setEditorError(undefined);
    setEditor(undefined);
    setNewSkill({ scope: "project", name: "" });
  };

  const openNewSkill = (): void => {
    if (newSkill === undefined) return;
    const name = newSkill.name.trim();
    if (!validSkillName(name)) {
      setEditorError("Nama skill harus huruf kecil, angka, atau tanda hubung (maks 64).");
      return;
    }
    const template = skillTemplate(name);
    setEditor({
      scope: newSkill.scope,
      name,
      original: "",
      content: template,
      isNew: true,
    });
    setNewSkill(undefined);
    setEditorError(undefined);
  };

  const saveSkill = async (): Promise<void> => {
    if (editorBusy || editor === undefined) return;
    if (overLimit(editor.content)) return;
    setEditorBusy(true);
    setEditorError(undefined);
    try {
      await api.putSkill(editor.scope, editor.name, editor.content, cwd);
      invalidateCommands(api);
      pendingFocusRef.current = true;
      setEditor({
        ...editor,
        original: editor.content,
        isNew: false,
      });
      await loadSkills();
    } catch (caught) {
      setEditorError(errorMessage(caught));
    } finally {
      setEditorBusy(false);
    }
  };

  const hookSourceTone = (hook: ClaudeHookItem): string =>
    hook.active ? "jk-badge-muted" : "jk-badge-warning";

  const skillStatusTone = (skill: ClaudeSkillItem): string => {
    if (skill.invalid !== undefined && skill.invalid !== "") return "jk-badge-danger";
    return skill.enabled ? "jk-badge-success" : "jk-badge-muted";
  };

  return (
    <section class="jk-instruksi" aria-labelledby="jk-instruksi-title">
      <header class="jk-settings-head">
        <h2
          id="jk-instruksi-title"
          ref={headingRef}
          tabIndex={-1}
          class="jk-settings-title"
        >
          Instruksi dan skills
        </h2>
        <p class="jk-privacy-note">
          Instruksi, skills, dan hooks mengarahkan agent. Perubahan berlaku di giliran
          berikutnya.
        </p>
      </header>

      {configDisabled ? (
        <p class="jk-note">{DISABLED_NOTE}</p>
      ) : (
        <div class="jk-instruksi-card">
          {configLoading && <p class="jk-note">Memuat…</p>}
          {config !== undefined && (
            <>
              <div class="jk-instruksi-setting">
                <div class="jk-instruksi-setting-text">
                  <span class="jk-label">Muat pengaturan pengguna (~/.claude)</span>
                  <p class="jk-note">
                    Menambah CLAUDE.md pribadi, skills, dan hooks dari ~/.claude ke semua sesi.
                    Hooks menjalankan perintah shell di komputermu.
                  </p>
                </div>
                <div class="jk-instruksi-switch jk-instruksi-switch-wrap">
                  <span class="jk-help" aria-hidden="true">
                    {config.userSettings ? "Aktif" : "Nonaktif"}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    class={`jk-switch${config.userSettings ? " jk-switch-on" : ""}`}
                    aria-checked={config.userSettings ? "true" : "false"}
                    aria-label="Muat pengaturan pengguna"
                    disabled={configBusy}
                    onClick={() =>
                      void updateConfig({ userSettings: !config.userSettings })
                    }
                  />
                </div>
              </div>
              <div class="jk-instruksi-setting">
                <div class="jk-instruksi-setting-text">
                  <span class="jk-label">Jalankan hooks Claude</span>
                  <p class="jk-note">
                    Mematikan semua hooks (proyek dan pengguna); penolak berkas rahasia Jejak
                    tetap aktif.
                  </p>
                </div>
                <div class="jk-instruksi-switch jk-instruksi-switch-wrap">
                  <span class="jk-help" aria-hidden="true">
                    {config.hooksEnabled ? "Aktif" : "Nonaktif"}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    class={`jk-switch${config.hooksEnabled ? " jk-switch-on" : ""}`}
                    aria-checked={config.hooksEnabled ? "true" : "false"}
                    aria-label="Jalankan hooks Claude"
                    disabled={configBusy}
                    onClick={() => void updateConfig({ hooksEnabled: !config.hooksEnabled })}
                  />
                </div>
              </div>
            </>
          )}
          {configError !== undefined && (
            <p class="jk-error-line" role="alert">
              {configError}
            </p>
          )}
        </div>
      )}

      <div class="jk-instruksi-head">
        <div class="jk-panel-tabs" role="tablist" aria-label="Bagian instruksi">
          {TABS.map((entry, index) => (
            <button
              key={entry.id}
              ref={(element) => {
                tabRefs.current[entry.id] = element;
              }}
              type="button"
              role="tab"
              id={`jk-instruksi-tab-${entry.id}`}
              class={`jk-panel-tab${tab === entry.id ? " jk-panel-tab-active" : ""}`}
              aria-selected={tab === entry.id}
              aria-controls={`jk-instruksi-panel-${entry.id}`}
              tabIndex={tab === entry.id ? 0 : -1}
              onClick={() => setTab(entry.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <label class="jk-instruksi-project">
          <span class="jk-label">Proyek</span>
          <Select
            class="jk-instruksi-select"
            ariaLabel="Folder proyek"
            value={cwd}
            placeholder="Belum ada folder proyek"
            options={
              projects.length === 0
                ? [{ value: "", label: "Belum ada folder proyek" }]
                : projects.map((project) => ({ value: project.cwd, label: project.label }))
            }
            onChange={(value) => requestCwd(value)}
          />
        </label>
      </div>

      {tab === "claude" && (
        <div
          class="jk-instruksi-panel"
          role="tabpanel"
          id="jk-instruksi-panel-claude"
          aria-labelledby="jk-instruksi-tab-claude"
        >
          <div class="jk-radio-group jk-instruksi-scope">
            {(["project", "user"] as ClaudeScope[]).map((entry) => (
              <label class="jk-radio" key={entry}>
                <input
                  type="radio"
                  name="jk-instruksi-scope"
                  value={entry}
                  checked={scope === entry}
                  onChange={() => requestScope(entry)}
                />
                <span>{scopeLabel(entry)}</span>
              </label>
            ))}
          </div>

          {pending !== undefined && (
            <div class="jk-instruksi-pending" role="status">
              <span>{PENDING_ACTION_NOTE}</span>
              <button
                type="button"
                class="jk-link-btn"
                onClick={() => applySwitch(pending)}
              >
                Buang
              </button>
              <button
                type="button"
                class="jk-link-btn"
                onClick={() => setPending(undefined)}
              >
                Tetap
              </button>
            </div>
          )}

          {scope === "user" && config?.userSettings === false && (
            <p class="jk-note jk-instruksi-warn">{USER_OFF_NOTE}</p>
          )}

          {instructionsLoading && (
            <p class="jk-note" role="status" aria-live="polite">
              Memuat…
            </p>
          )}

          {!instructionsLoading && instructionsError !== undefined && (
            <div class="jk-panel-error">
              <p class="jk-error-line" role="alert">
                {instructionsError}
              </p>
              <button type="button" class="jk-link-btn" onClick={() => void loadInstructions()}>
                Coba lagi
              </button>
            </div>
          )}

          {!instructionsLoading && instructionsError === undefined && !canLoadInstructions && (
            <p class="jk-note">Pilih folder proyek dulu untuk menyunting CLAUDE.md proyek.</p>
          )}

          {!instructionsLoading && instructionsError === undefined && canLoadInstructions && (
            <>
              <p class="jk-instruksi-path">
                <code>{instructions?.path ?? ""}</code>
                {instructions !== undefined && !instructions.exists && (
                  <span class="jk-note"> (belum ada; dibuat saat disimpan)</span>
                )}
              </p>
              <textarea
                class="jk-textarea jk-instruksi-text"
                rows={16}
                aria-label="Isi CLAUDE.md"
                aria-invalid={overLimit(draft)}
                value={draft}
                onInput={(event) => setDraft(event.currentTarget.value)}
              />
              <div class="jk-instruksi-actions">
                <button
                  type="button"
                  class="jk-button jk-button-primary"
                  disabled={
                    savingInstructions || !dirty || overLimit(draft) || instructions === undefined
                  }
                  onClick={() => void saveInstructions()}
                >
                  {savingInstructions ? "Menyimpan…" : "Simpan"}
                </button>
                <span class="jk-help jk-instruksi-count">{sizeLabel(draft)}</span>
              </div>
              {overLimit(draft) && (
                <p class="jk-error-line" role="alert">
                  Isi melebihi batas 256 KB.
                </p>
              )}
              {saveError !== undefined && (
                <p class="jk-error-line" role="alert">
                  {saveError}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {tab === "skills" && (
        <div
          class="jk-instruksi-panel"
          role="tabpanel"
          id="jk-instruksi-panel-skills"
          aria-labelledby="jk-instruksi-tab-skills"
        >
          <div class="jk-instruksi-panel-head">
            <button
              type="button"
              class="jk-button jk-instruksi-add"
              disabled={cwd === ""}
              aria-expanded={newSkill !== undefined}
              onClick={() => (newSkill === undefined ? startNewSkill() : setNewSkill(undefined))}
            >
              Skill baru
            </button>
          </div>

          {newSkill !== undefined && (
            <div class="jk-instruksi-new">
              <div class="jk-field-row">
                <div class="jk-field">
                  <span class="jk-label">Cakupan</span>
                  <Select
                    ariaLabel="Cakupan skill baru"
                    value={newSkill.scope}
                    options={[
                      { value: "project", label: "Proyek" },
                      { value: "user", label: "Pengguna" },
                    ]}
                    onChange={(value) =>
                      setNewSkill({
                        ...newSkill,
                        scope: value === "user" ? "user" : "project",
                      })
                    }
                  />
                </div>
                <div class="jk-field">
                  <label class="jk-label" for="jk-instruksi-new-name">
                    Nama skill
                  </label>
                  <input
                    id="jk-instruksi-new-name"
                    class="jk-input jk-input-code"
                    type="text"
                    value={newSkill.name}
                    autoComplete="off"
                    placeholder="nama-skill"
                    onInput={(event) =>
                      setNewSkill({ ...newSkill, name: event.currentTarget.value })
                    }
                  />
                </div>
              </div>
              <div class="jk-form-actions">
                <button type="button" class="jk-button" onClick={openNewSkill}>
                  Buka editor
                </button>
                <button type="button" class="jk-button" onClick={() => setNewSkill(undefined)}>
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
                  {editor.isNew ? "Skill baru" : "Sunting skill"}: {editor.name} (
                  {scopeLabel(editor.scope)})
                </span>
              </div>
              <textarea
                class="jk-textarea jk-instruksi-text"
                rows={14}
                aria-label={`Isi SKILL.md ${editor.name}`}
                value={editor.content}
                onInput={(event) =>
                  setEditor({ ...editor, content: event.currentTarget.value })
                }
              />
              <div class="jk-instruksi-actions">
                <button
                  type="button"
                  class="jk-button jk-button-primary"
                  disabled={
                    editorBusy ||
                    !isDirty(editor.original, editor.content) ||
                    overLimit(editor.content)
                  }
                  onClick={() => void saveSkill()}
                >
                  {editorBusy ? "Menyimpan…" : "Simpan"}
                </button>
                <button
                  type="button"
                  class="jk-button"
                  disabled={editorBusy}
                  onClick={() => setEditor(undefined)}
                >
                  Tutup
                </button>
                <span class="jk-help jk-instruksi-count">
                  {sizeLabel(editor.content)}
                </span>
              </div>
            </div>
          )}

          {skillsLoading && (
            <p class="jk-note" role="status" aria-live="polite">
              Memuat…
            </p>
          )}

          {!skillsLoading && skillsError !== undefined && (
            <div class="jk-panel-error">
              <p class="jk-error-line" role="alert">
                {skillsError}
              </p>
              <button type="button" class="jk-link-btn" onClick={() => void loadSkills()}>
                Coba lagi
              </button>
            </div>
          )}

          {!skillsLoading && skillsError === undefined && skills.length === 0 && (
            <p class="jk-note">Belum ada skill.</p>
          )}

          {!skillsLoading && skillsError === undefined && skills.length > 0 && (
            <ul class="jk-instruksi-list">
              {skills.map((skill) => {
                const key = `${skill.scope}:${skill.name}`;
                return (
                  <li class="jk-instruksi-row" key={key}>
                    <button
                      type="button"
                      class="jk-link-btn jk-instruksi-name"
                      onClick={() => void openSkill(skill)}
                    >
                      {skill.name}
                    </button>
                    <span class="jk-instruksi-desc" title={skill.description}>
                      {skill.description}
                    </span>
                    <span class="jk-badge jk-badge-muted">{scopeLabel(skill.scope)}</span>
                    <span class={`jk-badge ${skillStatusTone(skill)}`}>{skillBadge(skill)}</span>
                    <button
                      type="button"
                      class="jk-link-btn jk-instruksi-switch"
                      disabled={skillBusy !== undefined}
                      aria-pressed={skill.enabled}
                      aria-label={`${skill.enabled ? "Nonaktifkan" : "Aktifkan"} skill ${skill.name}`}
                      onClick={() => void toggleSkill(skill)}
                    >
                      {skill.enabled ? "Nonaktifkan" : "Aktifkan"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {config?.userSettings === false && skills.some((skill) => skill.scope === "user") && (
            <p class="jk-note jk-instruksi-warn">{SKILLS_USER_OFF_NOTE}</p>
          )}
          <p class="jk-note jk-instruksi-note">{SKILLS_NOTE}</p>
        </div>
      )}

      {tab === "agents" && <AgentsPanel api={api} cwd={cwd} />}

      {tab === "hooks" && (
        <div
          class="jk-instruksi-panel"
          role="tabpanel"
          id="jk-instruksi-panel-hooks"
          aria-labelledby="jk-instruksi-tab-hooks"
        >
          {hooksLoading && (
            <p class="jk-note" role="status" aria-live="polite">
              Memuat…
            </p>
          )}

          {!hooksLoading && hooksError !== undefined && (
            <div class="jk-panel-error">
              <p class="jk-error-line" role="alert">
                {hooksError}
              </p>
              <button type="button" class="jk-link-btn" onClick={() => void loadHooks()}>
                Coba lagi
              </button>
            </div>
          )}

          {!hooksLoading && hooksError === undefined && hooks.length === 0 && (
            <p class="jk-note">Belum ada hooks.</p>
          )}

          {!hooksLoading && hooksError === undefined && hooks.length > 0 && (
            <ul class="jk-instruksi-list">
              {hooks.map((hook, index) => (
                <li class="jk-instruksi-row" key={`${hook.source}-${index}`}>
                  <span class={`jk-badge ${hookSourceTone(hook)}`}>
                    {hookSourceLabel(hook.source)}
                  </span>
                  <span class="jk-instruksi-event">{hookEventLine(hook)}</span>
                  <code class="jk-instruksi-cmd" title={hook.command}>
                    {hook.command}
                  </code>
                  {!hook.active && <span class="jk-badge jk-badge-warning">tidak aktif</span>}
                </li>
              ))}
            </ul>
          )}

          <p class="jk-note jk-instruksi-note">{HOOKS_NOTE}</p>
        </div>
      )}

      {tab === "plugins" && <PluginsPanel api={api} />}
    </section>
  );
}
