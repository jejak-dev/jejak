import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import { ApiError, type ApiClient } from "../lib/api";
import type { RegistryView } from "../lib/registry-view";

export interface ComposerProps {
  api: ApiClient;
  defaultCwd?: string;
  registry?: RegistryView;
  onCreated: (session: SessionInfo) => void;
}

type PermissionMode = "default" | "acceptEdits" | "plan";

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Tanya dulu" },
  { value: "acceptEdits", label: "Setujui edit" },
  { value: "plan", label: "Hanya rencana" },
];

const STORAGE_CWD = "jejak.cwd";
const STORAGE_PROVIDER = "jejak.provider";
const STORAGE_MODE = "jejak.mode";

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
  const stored = readStorage(STORAGE_MODE);
  return stored === "acceptEdits" || stored === "plan" ? stored : "default";
}

export function Composer({ api, defaultCwd, registry, onCreated }: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState(() => readStorage(STORAGE_CWD) ?? defaultCwd ?? "");
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(readStoredMode);
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
    if (element !== null) autosize(element);
  }, []);

  useEffect(() => {
    if (defaultCwd === undefined || defaultCwd === "") return;
    setCwd((current) => (current.trim() === "" ? defaultCwd : current));
  }, [defaultCwd]);

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

    setPromptError(trimmedPrompt === "" ? "Tulis tugasnya dulu" : undefined);
    setCwdError(trimmedCwd === "" ? "Isi folder kerja" : undefined);
    setApiError(undefined);

    if (trimmedPrompt === "" || trimmedCwd === "") {
      if (trimmedPrompt === "") promptRef.current?.focus();
      else cwdRef.current?.focus();
      return;
    }

    setBusy(true);
    try {
      const input: Parameters<ApiClient["createSession"]>[0] = {
        prompt: trimmedPrompt,
        cwd: trimmedCwd,
        permissionMode,
      };
      if (profileId !== "") input.profileId = profileId;
      if (model !== "") input.model = model;

      const session = await api.createSession(input);

      writeStorage(STORAGE_CWD, trimmedCwd);
      writeStorage(STORAGE_PROVIDER, profileId);
      writeStorage(STORAGE_MODE, permissionMode);

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

  return (
    <form class="jk-composer" onSubmit={onSubmit} aria-busy={busy}>
      <div class="jk-field">
        <label class="jk-visually-hidden" for="jk-prompt">
          Tugas
        </label>
        <textarea
          id="jk-prompt"
          ref={promptRef}
          class="jk-textarea"
          rows={3}
          placeholder="Contoh: jelaskan struktur proyek ini"
          value={prompt}
          onInput={onPromptInput}
          onKeyDown={onPromptKeyDown}
          disabled={busy}
          aria-invalid={promptError !== undefined}
          aria-describedby={promptError !== undefined ? "jk-prompt-error" : undefined}
        />
        {promptError !== undefined && (
          <p class="jk-error-line" id="jk-prompt-error" role="alert">
            {promptError}
          </p>
        )}
      </div>

      <div class="jk-composer-row">
        <div class="jk-field jk-field-cwd">
          <label class="jk-label" for="jk-cwd">
            Folder kerja
          </label>
          <input
            id="jk-cwd"
            ref={cwdRef}
            type="text"
            class="jk-input"
            value={cwd}
            onInput={(event) => setCwd((event.currentTarget as HTMLInputElement).value)}
            disabled={busy}
            aria-invalid={cwdError !== undefined}
            aria-describedby={cwdError !== undefined ? "jk-cwd-error" : undefined}
          />
          {cwdError !== undefined && (
            <p class="jk-error-line" id="jk-cwd-error" role="alert">
              {cwdError}
            </p>
          )}
        </div>
      </div>

      <div class="jk-composer-row">
        <div class="jk-field">
          <label class="jk-label" for="jk-provider">
            Provider
          </label>
          <select
            id="jk-provider"
            class="jk-select"
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
        </div>

        <div class="jk-field">
          <label class="jk-label" for="jk-model">
            Model
          </label>
          {hasModelList ? (
            <select
              id="jk-model"
              class="jk-select"
              value={model}
              onChange={(event) => setModel((event.currentTarget as HTMLSelectElement).value)}
              disabled={busy}
            >
              <option value="">Model bawaan profil</option>
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label ?? entry.id}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="jk-model"
              type="text"
              class="jk-input"
              placeholder="Model bawaan profil"
              value={model}
              onInput={(event) => setModel((event.currentTarget as HTMLInputElement).value)}
              disabled={busy}
            />
          )}
        </div>

        <div class="jk-field">
          <label class="jk-label" for="jk-mode">
            Mode izin
          </label>
          <select
            id="jk-mode"
            class="jk-select"
            value={permissionMode}
            onChange={(event) =>
              setPermissionMode((event.currentTarget as HTMLSelectElement).value as PermissionMode)
            }
            disabled={busy}
          >
            {PERMISSION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" class="jk-button jk-button-primary" disabled={busy}>
          {busy ? "Memulai…" : "Mulai sesi"}
        </button>
      </div>

      {apiError !== undefined && (
        <p class="jk-error-line" role="alert">
          {apiError}
        </p>
      )}
    </form>
  );
}
