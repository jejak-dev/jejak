import { buildImpactBriefPrompt, impactBriefTitle } from "../../shared/impact-brief";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import { ApiError, type ApiClient, type SandboxState, type WorkspaceItem } from "../lib/api";
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
import { secretWarning } from "../lib/secret-warning";
import { FolderPicker } from "./FolderPicker";
import { appendAttachments } from "../lib/attachments";
import { AttachButton, AttachmentTray, DropHint } from "./AttachmentParts";
import { DictationButton } from "./DictationButton";
import { Dropdown } from "./Dropdown";
import { Icon } from "./Icon";
import { useAttachments } from "./useAttachments";
import { useDictation } from "../lib/use-dictation";

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
  { value: "default", label: "Ask permissions" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Bypass permissions (dangerous)" },
];

const STORAGE_CWD = "jejak.cwd";
const STORAGE_PROVIDER = "jejak.provider";
const STORAGE_MODE = "jejak.mode";
const STORAGE_WORKSPACE = "jejak.workspace";
const STORAGE_WORKTREE = "jejak.worktree";

const WORKTREE_NOTE =
  "Sesi bekerja di cabang baru jejak/… dalam folder terpisah; repo asli tidak tersentuh. " +
  "Perubahan yang belum di-commit tidak ikut.";

const SANDBOX_OFF_NOTE = "Bash agent berjalan tanpa batas berkas dan jaringan. Tercatat di Audit log.";

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
  const [briefMode, setBriefMode] = useState(false);
  const [bypassAcknowledged, setBypassAcknowledged] = useState(false);
  const [useWorktree, setUseWorktree] = useState(() => readStorage(STORAGE_WORKTREE) === "1");
  const [sandboxState, setSandboxState] = useState<SandboxState | undefined>(undefined);
  const [noSandbox, setNoSandbox] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nativePicker, setNativePicker] = useState(false);
  const [picking, setPicking] = useState(false);
  const [promptError, setPromptError] = useState<string | undefined>(undefined);
  const [cwdError, setCwdError] = useState<string | undefined>(undefined);
  const [apiError, setApiError] = useState<string | undefined>(undefined);

  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const att = useAttachments(api);
  const cwdRef = useRef<HTMLInputElement | null>(null);
  const dict = useDictation({ draft: prompt, setDraft: setPrompt, disabled: busy });

  const profiles = useMemo(() => registry?.profiles ?? [], [registry]);
  const activeProfileId = registry?.activeProfileId;

  useEffect(() => {
    let cancelled = false;
    api
      .nativePickerAvailable()
      .then((available) => {
        if (!cancelled) setNativePicker(available);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  const pickNative = async (): Promise<void> => {
    if (picking) return;
    setPicking(true);
    try {
      const start = cwd.trim() === "" ? undefined : cwd.trim();
      const path = await api.pickFolderNative(start);
      if (path !== undefined) setCwd(path);
    } catch {
      // Dialog native gagal: pakai penelusur bawaan.
      setNativePicker(false);
      setPickerOpen(true);
    } finally {
      setPicking(false);
    }
  };

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

  // Tinggi kolom mengikuti isi terbaru (mis. teks hasil dikte).
  useEffect(() => {
    const element = promptRef.current;
    if (element === null) return;
    autosize(element);
  }, [prompt]);

  // Status sandbox hanya untuk menampilkan opsi; galat/503 berarti opsi disembunyikan.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await api.getSandbox();
        if (active) setSandboxState(next);
      } catch {
        // Opsi sandbox tidak tampil; sesi memakai default server.
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);

  useEffect(() => {
    if (selectedWorkspace !== undefined || busy) setPickerOpen(false);
  }, [selectedWorkspace, busy]);

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

    // Kirim pesan menghentikan dikte lebih dulu.
    dict.stop();

    const trimmedPrompt = prompt.trim();
    const trimmedCwd = cwd.trim();
    const usingWorkspace = selectedWorkspace !== undefined;

    const hasAttachments = att.items.length > 0;
    if (att.pending > 0) {
      setApiError("Tunggu lampiran selesai diunggah.");
      return;
    }
    setPromptError(trimmedPrompt === "" && !hasAttachments ? "Tulis tugasnya dulu" : undefined);
    setCwdError(!usingWorkspace && trimmedCwd === "" ? "Isi folder kerja" : undefined);
    setApiError(undefined);

    if (trimmedPrompt === "" && !hasAttachments) {
      promptRef.current?.focus();
      return;
    }
    if (!usingWorkspace && trimmedCwd === "") {
      cwdRef.current?.focus();
      return;
    }
    const effectiveMode: PermissionMode = briefMode ? "plan" : permissionMode;
    if (!canSubmitMode(effectiveMode, bypassAcknowledged)) {
      setApiError("Centang pernyataan risiko dulu untuk memakai mode tanpa izin.");
      return;
    }

    setBusy(true);
    try {
      const input: Parameters<ApiClient["createSession"]>[0] = {
        prompt: appendAttachments(
          briefMode ? buildImpactBriefPrompt(trimmedPrompt) : trimmedPrompt,
          att.items,
        ),
        permissionMode: effectiveMode,
      };
      if (briefMode) input.title = impactBriefTitle(trimmedPrompt);
      else if (hasAttachments) input.title = (trimmedPrompt === "" ? "Lampiran" : trimmedPrompt).slice(0, 60);
      if (usingWorkspace) {
        input.workspaceId = selectedWorkspace.id;
        if (repoPath !== "") input.cwd = repoPath;
      } else {
        input.cwd = trimmedCwd;
      }
      if (profileId !== "") input.profileId = profileId;
      if (model !== "") input.model = model;
      if (effectiveMode === "bypassPermissions") input.confirmBypass = true;
      if (!usingWorkspace && useWorktree) input.worktree = true;
      if (noSandbox && sandboxState?.config.mode === "standar") input.sandbox = "mati";

      const session = await api.createSession(input);

      if (!usingWorkspace) writeStorage(STORAGE_CWD, trimmedCwd);
      writeStorage(STORAGE_WORKSPACE, usingWorkspace ? selectedWorkspace.id : "");
      writeStorage(STORAGE_WORKTREE, useWorktree ? "1" : "0");
      writeStorage(STORAGE_PROVIDER, profileId);
      // Mode rencana paksaan brief tidak menjadi pilihan awal berikutnya.
      const remembered = briefMode ? undefined : storableMode(permissionMode);
      if (remembered !== undefined) writeStorage(STORAGE_MODE, remembered);

      setPrompt("");
      att.clear();
      setBriefMode(false);
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
      ? "Default model"
      : (modelEntry?.label ?? model)
    : undefined;
  const modeLabel =
    PERMISSION_OPTIONS.find((option) => option.value === (briefMode ? "plan" : permissionMode))?.label ?? "";
  const bypassSelected = !briefMode && permissionMode === "bypassPermissions";
  const canSend =
    !busy &&
    att.pending === 0 &&
    (prompt.trim() !== "" || att.items.length > 0) &&
    canSubmitMode(briefMode ? "plan" : permissionMode, bypassAcknowledged);
  const suggestions = selectedWorkspace === undefined
    ? recentCwds.filter((path) => path !== cwd.trim()).slice(0, 4)
    : [];
  const warning = useMemo(() => secretWarning(prompt), [prompt]);
  const promptDescribedBy = [
    promptError === undefined ? undefined : "jk-prompt-error",
    warning === undefined ? undefined : "jk-prompt-secret-warning",
  ]
    .filter((id): id is string => id !== undefined)
    .join(" ");

  return (
    <form class="jk-composer" onSubmit={onSubmit} aria-busy={busy}>
      <div class={`jk-comp-card${att.dragging ? " jk-dropping" : ""}`} {...att.dropProps}>
        {att.dragging && <DropHint />}
        <AttachmentTray items={att.items} pending={att.pending} error={att.error} onRemove={att.remove} />
        <label class="jk-visually-hidden" for="jk-prompt">
          Tugas
        </label>
        <div class="jk-pill-row">
          <AttachButton onFiles={(files) => void att.add(files)} disabled={busy} />
        <textarea
          id="jk-prompt"
          ref={promptRef}
          class="jk-comp-input"
          rows={1}
          placeholder="Tulis tugas, mis. “jelaskan struktur proyek ini”"
          value={prompt}
          onInput={onPromptInput}
          onKeyDown={onPromptKeyDown}
          onPaste={att.onPaste}
          disabled={busy}
          aria-invalid={promptError !== undefined}
          aria-describedby={promptDescribedBy === "" ? undefined : promptDescribedBy}
        />
          <DictationButton dict={dict} />
          <button type="submit" class="jk-send" disabled={!canSend} aria-label={busy ? "Memulai…" : "Mulai sesi"}>
            <Icon name="send" />
          </button>
        </div>
      </div>

      <div class="jk-comp-meta">
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
            <>
              <label class="jk-chip jk-chip-cwd" title="Working directory">
                <Icon name="folder" />
                <span class="jk-visually-hidden">Working directory</span>
                <input
                  id="jk-cwd"
                  ref={cwdRef}
                  type="text"
                  class="jk-chip-input"
                  value={cwd}
                  size={Math.min(Math.max(cwd.length, 12), 26)}
                  spellcheck={false}
                  onInput={(event) => setCwd((event.currentTarget as HTMLInputElement).value)}
                  disabled={busy}
                  aria-invalid={cwdError !== undefined}
                  aria-describedby={cwdError !== undefined ? "jk-cwd-error" : undefined}
                />
              </label>
              <button
                type="button"
                class="jk-chip jk-chip-btn"
                aria-label="Browse folder"
                title={nativePicker ? "Pilih folder (Finder)" : "Browse…"}
                data-folder-opener
                disabled={busy || picking}
                onClick={() => {
                  if (nativePicker) void pickNative();
                  else setPickerOpen((open) => !open);
                }}
              >
                Pilih…
              </button>
              {pickerOpen && (
                <FolderPicker
                  api={api}
                  initialPath={cwd.trim() === "" ? undefined : cwd.trim()}
                  onPick={(path) => {
                    setCwd(path);
                    setPickerOpen(false);
                  }}
                  onClose={() => setPickerOpen(false)}
                />
              )}
            </>
          )}

          <Dropdown
            icon={<Icon name="cube" />}
            label={providerLabel}
            ariaLabel="Provider"
            placement="down"
            align="start"
            disabled={busy || profiles.length === 0}
            sections={[
              {
                options: profiles.map((profile) => ({ value: profile.id, label: profile.name })),
                value: profileId,
                onSelect: setProfileId,
              },
            ]}
          />

          {hasModelList ? (
            <Dropdown
              label={modelLabel ?? "Default model"}
              ariaLabel="Model"
              placement="down"
              align="start"
              disabled={busy}
              sections={[
                {
                  options: [
                    { value: "", label: "Default model" },
                    ...models.map((entry) => ({ value: entry.id, label: entry.label ?? entry.id })),
                  ],
                  value: model,
                  onSelect: setModel,
                },
              ]}
            />
          ) : (
            <label class="jk-chip">
              <span class="jk-visually-hidden">Model</span>
              <input
                id="jk-model"
                type="text"
                class="jk-chip-input"
                placeholder="Default model"
                size={14}
                value={model}
                onInput={(event) => setModel((event.currentTarget as HTMLInputElement).value)}
                disabled={busy}
              />
            </label>
          )}

          <Dropdown
            icon={<Icon name="eye" />}
            label={modeLabel}
            ariaLabel="Mode izin"
            placement="down"
            align="start"
            disabled={busy || briefMode}
            sections={[
              {
                options: PERMISSION_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                  danger: option.value === "bypassPermissions",
                })),
                value: briefMode ? "plan" : permissionMode,
                onSelect: (value) => {
                  setPermissionMode(value as PermissionMode);
                  setBypassAcknowledged(false);
                },
              },
            ]}
          />

      </div>

      {warning !== undefined && (
        <p class="jk-secret-warning" id="jk-prompt-secret-warning" role="status">
          {warning.message}
        </p>
      )}

      <details class="jk-advanced" open={useWorktree || briefMode || noSandbox}>
        <summary>Opsi lanjutan</summary>
      {selectedWorkspace === undefined && (
        <div class="jk-worktree-option">
          <label class="jk-bypass-check">
            <input
              id="jk-worktree"
              type="checkbox"
              checked={useWorktree}
              aria-describedby="jk-worktree-note"
              onChange={(event) =>
                setUseWorktree((event.currentTarget as HTMLInputElement).checked)
              }
              disabled={busy}
            />
            <span>Isolated worktree</span>
          </label>
          <p class="jk-note" id="jk-worktree-note">
            {WORKTREE_NOTE}
          </p>
        </div>
      )}

      <div class="jk-worktree-option jk-brief-option">
        <label class="jk-bypass-check">
          <input
            id="jk-brief"
            type="checkbox"
            checked={briefMode}
            aria-describedby="jk-brief-note"
            onChange={(event) => setBriefMode((event.currentTarget as HTMLInputElement).checked)}
            disabled={busy}
          />
          <span>Impact brief first</span>
        </label>
        <p class="jk-note" id="jk-brief-note">
          {briefMode
            ? "Agent hanya menyelidiki (mode rencana, tanpa mengubah berkas) dan menyusun daftar service, tabel, dan queue yang terdampak, lalu mengajukan pertanyaan terbuka. Tugasmu dibungkus templat brief."
            : "Untuk tugas lintas repo: minta daftar dampak dulu sebelum mengerjakan."}
        </p>
      </div>

      {sandboxState !== undefined && sandboxState.config.mode === "mati" && (
        <p class="jk-note">Sandbox mati secara global (lihat Pengaturan).</p>
      )}

      {sandboxState !== undefined && sandboxState.config.mode === "standar" && (
        <div class="jk-sandbox-option">
          <label class="jk-bypass-check">
            <input
              id="jk-no-sandbox"
              type="checkbox"
              checked={noSandbox}
              aria-describedby={noSandbox ? "jk-sandbox-off-note" : undefined}
              onChange={(event) =>
                setNoSandbox((event.currentTarget as HTMLInputElement).checked)
              }
              disabled={busy}
            />
            <span>Tanpa sandbox untuk sesi ini</span>
          </label>
          {!sandboxState.available.ok && (
            <p class="jk-secret-warning" id="jk-sandbox-unavailable" role="status">
              Sandbox belum tersedia; sesi baru akan gagal. Lihat Pengaturan atau jalankan jejak
              doctor.
            </p>
          )}
          {noSandbox && (
            <p class="jk-secret-warning" id="jk-sandbox-off-note" role="status">
              {SANDBOX_OFF_NOTE}
            </p>
          )}
        </div>
      )}

      </details>

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
