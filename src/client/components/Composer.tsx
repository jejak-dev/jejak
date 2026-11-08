import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import { ApiError, type ApiClient, type WorkspaceItem } from "../lib/api";
import type { RegistryView } from "../lib/registry-view";
import { folderName } from "../lib/format";
import {
  BYPASS_WARNING,
  canSubmitMode,
  storableMode,
  storedModeFrom,
  type ComposerPermissionMode,
} from "../lib/permission-mode";
import { defaultRepoPath, workspaceRepoOptions } from "../lib/workspace";
import { Icon } from "./Icon";

export interface ComposerProps {
  api: ApiClient;
  defaultCwd?: string;
  registry?: RegistryView;
  recentCwds?: string[];
  workspaces?: WorkspaceItem[];
  onCreated: (session: SessionInfo) => void;
}

type PermissionMode = ComposerPermissionMode;

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Tanya dulu" },
  { value: "acceptEdits", label: "Setujui edit" },
  { value: "plan", label: "Hanya rencana" },
  { value: "bypassPermissions", label: "Tanpa izin (berbahaya)" },
];

const STORAGE_CWD = "jejak.cwd";
const STORAGE_PROVIDER = "jejak.provider";
const STORAGE_MODE = "jejak.mode";
const STORAGE_WORKSPACE = "jejak.workspace";

const MAX_TEXTAREA_PX = 8 * 24;

function readStorage(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Penyimpanan opsional; kegagalan diabaikan.
  }
}

function autosize(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_PX)}px`;
}

function readStoredMode(): PermissionMode {
  return storedModeFrom(readStorage(STORAGE_MODE));
}

export function Composer({
  api,
  defaultCwd,
  registry,
  recentCwds = [],
  workspaces = [],
  onCreated,
}: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState(() => readStorage(STORAGE_CWD) ?? defaultCwd ?? "");
  const [workspaceId, setWorkspaceId] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(readStoredMode);
  const [bypassAcknowledged, setBypassAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [promptError, setPromptError] = useState<string | undefined>(undefined);
  const [cwdError, setCwdError] = useState<string | undefined>(undefined);
  const [apiError, setApiError] = useState<string | undefined>(undefined);

  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const cwdRef = useRef<HTMLInputElement | null>(null);

  const profiles = useMemo(() => registry?.profiles ?? [], [registry]);
  const activeProfileId = registry?.activeProfileId;

  useEffect(() => {
    const stored = readStorage(STORAGE_PROVIDER);
    setProfileId((current) => {
      const isValid = (id: string): boolean =>
        profiles.some((profile) => profile.id === id);
      if (current !== "" && (profiles.length === 0 || isValid(current))) {
        return current;
      }
      if (stored !== undefined && isValid(stored)) {
        return stored;
      }
      return activeProfileId ?? profiles[0]?.id ?? "";
    });
  }, [activeProfileId, profiles]);

  useEffect(() => {
    const element = promptRef.current;
    if (element === null) return;
    autosize(element);
    // Ukur ulang saat lebarnya berubah (mis. stylesheet baru selesai dimuat).
    let lastWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === lastWidth) return;
      lastWidth = element.clientWidth;
      autosize(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (defaultCwd === undefined || defaultCwd === "") return;
    setCwd((current) => (current.trim() === "" ? defaultCwd : current));
  }, [defaultCwd]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);

  useEffect(() => {
    if (workspaces.length === 0) return;
    setWorkspaceId((current) => {
      if (current !== "") {
        return workspaces.some((workspace) => workspace.id === current) ? current : "";
      }
      const stored = readStorage(STORAGE_WORKSPACE);
      return stored !== undefined && workspaces.some((workspace) => workspace.id === stored)
        ? stored
        : "";
    });
  }, [workspaces]);

  const repoOptions = useMemo(
    () => (selectedWorkspace === undefined ? [] : workspaceRepoOptions(selectedWorkspace)),
    [selectedWorkspace],
  );

  useEffect(() => {
    if (selectedWorkspace === undefined) {
      setRepoPath("");
      return;
    }
    const fallback = defaultRepoPath(selectedWorkspace) ?? "";
    setRepoPath((current) =>
      repoOptions.some((option) => option.value === current && !option.missing) ? current : fallback,
    );
  }, [selectedWorkspace, repoOptions]);

  const repoLabel = repoOptions.find((option) => option.value === repoPath)?.label ?? "Repo";

  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const models = useMemo(() => selectedProfile?.models ?? [], [selectedProfile]);
  const hasModelList = models.length > 0;

  useEffect(() => {
    setModel((current) =>
      current !== "" && models.some((entry) => entry.id === current) ? current : "",
    );
  }, [profileId, models]);

  const submit = async (): Promise<void> => {
    if (busy) return;

    const trimmedPrompt = prompt.trim();
    const trimmedCwd = cwd.trim();
    const usingWorkspace = selectedWorkspace !== undefined;

    setPromptError(trimmedPrompt === "" ? "Tulis tugasnya dulu" : undefined);
    setCwdError(!usingWorkspace && trimmedCwd === "" ? "Isi folder kerja" : undefined);
    setApiError(undefined);

    if (trimmedPrompt === "") {
      promptRef.current?.focus();
      return;
    }
    if (!usingWorkspace && trimmedCwd === "") {
      cwdRef.current?.focus();
      return;
    }
    if (!canSubmitMode(permissionMode, bypassAcknowledged)) {
      setApiError("Centang pernyataan risiko dulu untuk memakai mode tanpa izin.");
      return;
    }

    setBusy(true);
    try {
      const input: Parameters<ApiClient["createSession"]>[0] = {
        prompt: trimmedPrompt,
        permissionMode,
      };
      if (usingWorkspace) {
        input.workspaceId = selectedWorkspace.id;
        if (repoPath !== "") input.cwd = repoPath;
      } else {
        input.cwd = trimmedCwd;
      }
      if (profileId !== "") input.profileId = profileId;
      if (model !== "") input.model = model;
      if (permissionMode === "bypassPermissions") input.confirmBypass = true;

      const session = await api.createSession(input);

      if (!usingWorkspace) writeStorage(STORAGE_CWD, trimmedCwd);
      writeStorage(STORAGE_WORKSPACE, usingWorkspace ? selectedWorkspace.id : "");
      writeStorage(STORAGE_PROVIDER, profileId);
      const remembered = storableMode(permissionMode);
      if (remembered !== undefined) writeStorage(STORAGE_MODE, remembered);

      setPrompt("");
      if (promptRef.current !== null) autosize(promptRef.current);
      onCreated(session);
    } catch (caught) {
      setApiError(caught instanceof ApiError ? caught.message : "gagal memulai sesi");
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    void submit();
  };

  const onPromptKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const onPromptInput = (event: Event): void => {
    const element = event.currentTarget as HTMLTextAreaElement;
    setPrompt(element.value);
    autosize(element);
  };

  const providerLabel = selectedProfile?.name ?? "Belum ada profil";
  const modelEntry = models.find((entry) => entry.id === model);
  const modelLabel = hasModelList
    ? model === ""
      ? "Model bawaan"
      : (modelEntry?.label ?? model)
    : undefined;
  const modeLabel = PERMISSION_OPTIONS.find((option) => option.value === permissionMode)?.label ?? "";
  const bypassSelected = permissionMode === "bypassPermissions";
  const canSend =
    !busy &&
    prompt.trim() !== "" &&
    canSubmitMode(permissionMode, bypassAcknowledged);
  const suggestions = selectedWorkspace === undefined
    ? recentCwds.filter((path) => path !== cwd.trim()).slice(0, 4)
    : [];

  return (
    <form class="jk-composer" onSubmit={onSubmit} aria-busy={busy}>
      <div class="jk-comp-card">
        <label class="jk-visually-hidden" for="jk-prompt">
          Tugas
        </label>
        <textarea
          id="jk-prompt"
          ref={promptRef}
          class="jk-comp-input"
          rows={2}
          placeholder="Tulis tugas, mis. “jelaskan struktur proyek ini”"
          value={prompt}
          onInput={onPromptInput}
          onKeyDown={onPromptKeyDown}
          disabled={busy}
          aria-invalid={promptError !== undefined}
          aria-describedby={promptError !== undefined ? "jk-prompt-error" : undefined}
        />

        <div class="jk-comp-bar">
          {workspaces.length > 0 && (
            <label class="jk-chip" title="Workspace">
              <Icon name="workspace" />
              <span>{selectedWorkspace?.name ?? "Tanpa workspace"}</span>
              <select
                id="jk-workspace"
                class="jk-chip-select"
                aria-label="Workspace"
                value={workspaceId}
                onChange={(event) => setWorkspaceId((event.currentTarget as HTMLSelectElement).value)}
                disabled={busy}
              >
                <option value="">Tanpa workspace</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {selectedWorkspace !== undefined ? (
            <label class="jk-chip" title="Repo">
              <Icon name="folder" />
              <span>{repoLabel}</span>
              <select
                id="jk-repo"
                class="jk-chip-select"
                aria-label="Repo"
                value={repoPath}
                onChange={(event) => setRepoPath((event.currentTarget as HTMLSelectElement).value)}
                disabled={busy}
                aria-invalid={cwdError !== undefined}
                aria-describedby={cwdError !== undefined ? "jk-cwd-error" : undefined}
              >
                {repoOptions.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.missing}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label class="jk-chip jk-chip-cwd" title="Folder kerja">
              <Icon name="folder" />
              <span class="jk-visually-hidden">Folder kerja</span>
              <input
                id="jk-cwd"
                ref={cwdRef}
                type="text"
                class="jk-chip-input"
                value={cwd}
                size={Math.min(Math.max(cwd.length, 12), 34)}
                spellcheck={false}
                onInput={(event) => setCwd((event.currentTarget as HTMLInputElement).value)}
                disabled={busy}
                aria-invalid={cwdError !== undefined}
                aria-describedby={cwdError !== undefined ? "jk-cwd-error" : undefined}
              />
            </label>
          )}

          <label class="jk-chip">
            <Icon name="cube" />
            <span>{providerLabel}</span>
            <select
              id="jk-provider"
              class="jk-chip-select"
              aria-label="Provider"
              value={profileId}
              onChange={(event) => setProfileId((event.currentTarget as HTMLSelectElement).value)}
              disabled={busy || profiles.length === 0}
            >
              {profiles.length === 0 && <option value="">Belum ada profil</option>}
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>

          {hasModelList ? (
            <label class="jk-chip">
              <span>{modelLabel}</span>
              <select
                id="jk-model"
                class="jk-chip-select"
                aria-label="Model"
                value={model}
                onChange={(event) => setModel((event.currentTarget as HTMLSelectElement).value)}
                disabled={busy}
              >
                <option value="">Model bawaan</option>
                {models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label ?? entry.id}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label class="jk-chip">
              <span class="jk-visually-hidden">Model</span>
              <input
                id="jk-model"
                type="text"
                class="jk-chip-input"
                placeholder="Model bawaan"
                size={14}
                value={model}
                onInput={(event) => setModel((event.currentTarget as HTMLInputElement).value)}
                disabled={busy}
              />
            </label>
          )}

          <label class="jk-chip">
            <Icon name="eye" />
            <span>{modeLabel}</span>
            <select
              id="jk-mode"
              class="jk-chip-select"
              aria-label="Mode izin"
              value={permissionMode}
              onChange={(event) => {
                setPermissionMode((event.currentTarget as HTMLSelectElement).value as PermissionMode);
                setBypassAcknowledged(false);
              }}
              disabled={busy}
            >
              {PERMISSION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" class="jk-send" disabled={!canSend} aria-label={busy ? "Memulai…" : "Mulai sesi"}>
            <Icon name="send" />
          </button>
        </div>
      </div>

      {bypassSelected && (
        <div class="jk-bypass-warn" role="note">
          <p>{BYPASS_WARNING}</p>
          <label class="jk-bypass-check">
            <input
              type="checkbox"
              checked={bypassAcknowledged}
              onChange={(event) =>
                setBypassAcknowledged((event.currentTarget as HTMLInputElement).checked)
              }
              disabled={busy}
            />
            <span>Saya mengerti risikonya</span>
          </label>
        </div>
      )}

      {promptError !== undefined && (
        <p class="jk-error-line" id="jk-prompt-error" role="alert">
          {promptError}
        </p>
      )}
      {cwdError !== undefined && (
        <p class="jk-error-line" id="jk-cwd-error" role="alert">
          {cwdError}
        </p>
      )}
      {apiError !== undefined && (
        <p class="jk-error-line" role="alert">
          {apiError}
        </p>
      )}

      {selectedWorkspace !== undefined && (
        <p class="jk-note">
          Agent dapat membaca repo lain di workspace; panel berkas dan titik hanya untuk repo ini.
        </p>
      )}

      {suggestions.length > 0 && (
        <div class="jk-recent">
          <span>Folder terakhir:</span>
          {suggestions.map((path) => (
            <button type="button" key={path} title={path} onClick={() => setCwd(path)} disabled={busy}>
              {folderName(path)}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
