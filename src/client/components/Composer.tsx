import { buildImpactBriefPrompt, impactBriefTitle } from "../../shared/impact-brief";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import { ApiError, type ApiClient, type HeldPrompt, type SandboxState, type WorkspaceItem } from "../lib/api";
import type { RegistryView } from "../lib/registry-view";
import { folderName } from "../lib/format";
import { parseGoalCommand } from "../lib/goal";
import { placeholderTugas } from "../lib/composer-placeholder";
import { useNarrowViewport } from "../lib/pane-narrow";
import {
  BYPASS_WARNING,
  canSubmitMode,
  storableMode,
  storedModeFrom,
  type ComposerPermissionMode,
} from "../lib/permission-mode";
import { defaultRepoPath, workspaceRepoOptions } from "../lib/workspace";
import { secretWarning } from "../lib/secret-warning";
import { caretOf } from "../lib/slash";
import { FolderPicker } from "./FolderPicker";
import { appendAttachments } from "../lib/attachments";
import { AttachButton, AttachmentTray, DropHint } from "./AttachmentParts";
import { DictationButton } from "./DictationButton";
import { Dropdown } from "./Dropdown";
import { Icon } from "./Icon";
import { useAttachments } from "./useAttachments";
import { useDictation } from "../lib/use-dictation";
import { useSlashMenu } from "../hooks";
import { Select } from "./Select";
import { SlashMenu } from "./SlashMenu";

export interface ComposerProps {
  api: ApiClient;
  defaultCwd?: string;
  registry?: RegistryView;
  recentCwds?: string[];
  workspaces?: WorkspaceItem[];
  onCreated: (session: SessionInfo) => void;
  /** Sesi yang sedang berjalan; dipakai untuk memilih sesi yang ditunggu. */
  runningSessions?: { id: string; title: string }[];
  /** Dipanggil setelah prompt berhasil ditahan di server. */
  onHeld?: () => void;
  /** Draf yang dipulihkan (mis. tahanan yang dibatalkan); diisi ulang saat id berubah. */
  restoreDraft?: { id: string; input: HeldPrompt["input"] };
  /** Folder kerja yang dipasang dari sidebar; diisi ulang saat id berubah. */
  presetCwd?: { id: number; cwd: string };
  /** Layar ponsel: kontrol folder/profil/model/izin di balik tombol "Opsi". */
  mobile?: boolean;
}

type PermissionMode = ComposerPermissionMode;

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Tanya izin" },
  { value: "acceptEdits", label: "Terima perubahan" },
  { value: "plan", label: "Rencana" },
  { value: "bypassPermissions", label: "Lewati izin (berbahaya)" },
];

const STORAGE_CWD = "jejak.cwd";
const STORAGE_PROVIDER = "jejak.provider";
const STORAGE_MODE = "jejak.mode";
const STORAGE_WORKSPACE = "jejak.workspace";
const STORAGE_WORKTREE = "jejak.worktree";

const WORKTREE_NOTE =
  "Sesi bekerja di cabang baru jejak/… dalam folder terpisah; repo asli tidak tersentuh. " +
  "Perubahan yang belum di-commit tidak ikut.";

const SANDBOX_OFF_NOTE = "Bash agent berjalan tanpa batas berkas dan jaringan. Tercatat di Log audit.";

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
  runningSessions = [],
  onHeld,
  restoreDraft,
  presetCwd,
  mobile = false,
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
  /** Id sesi yang ditunggu; "" berarti prompt langsung dibuat. */
  const [waitFor, setWaitFor] = useState("");
  /** Ponsel: area opsi (folder, profil, model, izin) terbuka dari pill. */
  const [opsiOpen, setOpsiOpen] = useState(false);

  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  /** Layar sempit: placeholder komposer dibuat pendek. */
  const sempit = useNarrowViewport();
  /** Kursor yang mau dipasang setelah render berikutnya. */
  const caretRef = useRef<number | undefined>(undefined);
  /** Id tahanan terakhir yang dipulihkan; draf tak diisi ulang dua kali. */
  const restoredIdRef = useRef<string | undefined>(undefined);
  /** Id preset folder terakhir yang dipasang; klik ulang di folder sama tetap berlaku. */
  const presetIdRef = useRef<number | undefined>(undefined);
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

  // Menu perintah slash: hanya aktif bila folder kerja sudah ada.
  const slashCwd = selectedWorkspace === undefined ? cwd.trim() : repoPath.trim();
  const slash = useSlashMenu({
    api,
    cwd: slashCwd === "" ? undefined : slashCwd,
    onApply: (next) => {
      setPrompt(next.text);
      caretRef.current = next.caret;
    },
  });

  // Kursor baru (mis. setelah memilih perintah) dipasang setelah teks dirender.
  useEffect(() => {
    const element = promptRef.current;
    if (element === null) return;
    const caret = caretRef.current;
    if (caret === undefined) return;
    caretRef.current = undefined;
    if (typeof element.setSelectionRange === "function") {
      element.setSelectionRange(caret, caret);
    }
  });

  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const models = useMemo(() => selectedProfile?.models ?? [], [selectedProfile]);
  const hasModelList = models.length > 0;

  useEffect(() => {
    setModel((current) =>
      current !== "" && models.some((entry) => entry.id === current) ? current : "",
    );
  }, [profileId, models]);

  // Sesi yang ditunggu sudah selesai: pilihan kembali ke "Langsung mulai".
  useEffect(() => {
    setWaitFor((current) => {
      if (current === "") return current;
      return runningSessions.some((session) => session.id === current) ? current : "";
    });
  }, [runningSessions]);

  // Draf dipulihkan dari tahanan yang dibatalkan: isi prompt dan folder kerja.
  useEffect(() => {
    if (restoreDraft === undefined) return;
    if (restoredIdRef.current === restoreDraft.id) return;
    restoredIdRef.current = restoreDraft.id;
    const teks = restoreDraft.input.prompt;
    setPrompt(typeof teks === "string" ? teks : "");
    const folder = restoreDraft.input.cwd;
    if (folder !== undefined && folder !== "" && restoreDraft.input.workspaceId === undefined) {
      setCwd(folder);
    }
    promptRef.current?.focus();
  }, [restoreDraft]);

  // Folder dipasang dari tombol grup sidebar: isi folder kerja, kembali ke mode
  // folder biasa, dan fokuskan prompt tanpa menimpa teks yang sedang diketik.
  useEffect(() => {
    if (presetCwd === undefined) return;
    if (presetIdRef.current === presetCwd.id) return;
    presetIdRef.current = presetCwd.id;
    setCwd(presetCwd.cwd);
    setWorkspaceId("");
    setRepoPath("");
    setCwdError(undefined);
    promptRef.current?.focus();
  }, [presetCwd]);

  const submit = async (): Promise<void> => {
    if (busy) return;

    // Sesi yang ditunggu; string kosong berarti prompt langsung dibuat.
    const waitForId = waitFor;

    // Kirim pesan menghentikan dikte lebih dulu.
    dict.stop();

    const trimmedPrompt = prompt.trim();
    const trimmedCwd = cwd.trim();
    const usingWorkspace = selectedWorkspace !== undefined;

    // `/goal` butuh sesi yang sudah ada; beranda belum punya sesi.
    if (parseGoalCommand(trimmedPrompt) !== undefined) {
      setPromptError(undefined);
      setApiError(undefined);
      return;
    }

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
      // Ponsel: kolom folder ada di balik pill Opsi; buka supaya bisa diisi.
      setOpsiOpen(true);
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

      // Prompt ditahan di server sampai sesi yang dipilih benar-benar selesai.
      const ditahan = waitForId !== "";
      const session = ditahan ? undefined : await api.createSession(input);
      if (ditahan) await api.holdPrompt(input, waitForId);

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
      if (ditahan) {
        setWaitFor("");
        onHeld?.();
      } else if (session !== undefined) {
        onCreated(session);
      }
    } catch (caught) {
      setApiError(
        caught instanceof ApiError
          ? caught.message
          : waitForId !== ""
            ? "gagal menahan prompt"
            : "gagal memulai sesi",
      );
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    void submit();
  };

  const onPromptKeyDown = (event: KeyboardEvent): void => {
    // Menu perintah slash lebih dulu: Enter saat menu terbuka memilih perintah.
    if (slash.onKeyDown(event)) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  const onPromptInput = (event: Event): void => {
    const element = event.currentTarget as HTMLTextAreaElement;
    setPrompt(element.value);
    autosize(element);
    slash.sync(element.value, caretOf(element));
  };

  const providerLabel = selectedProfile?.name ?? "Belum ada profil";
  const modelEntry = models.find((entry) => entry.id === model);
  const modelLabel = hasModelList
    ? model === ""
      ? "Model bawaan"
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
  // Perintah `/goal` di beranda: server hanya bisa memulai Goal pada sesi
  // yang sudah ada, jadi arahkan pengguna ke kolom balasan.
  const goalCommand = parseGoalCommand(prompt.trim());
  const promptDescribedBy = [
    promptError === undefined ? undefined : "jk-prompt-error",
    warning === undefined ? undefined : "jk-prompt-secret-warning",
  ]
    .filter((id): id is string => id !== undefined)
    .join(" ");

  return (
    <form
      class={`jk-composer${mobile ? " jk-composer-mobile" : ""}${mobile && opsiOpen ? " jk-opsi-open" : ""}`}
      onSubmit={onSubmit}
      aria-busy={busy}
    >
      {mobile && (
        <div class="jk-mobile-opsi-bar">
          <button
            type="button"
            class="jk-chip jk-chip-btn jk-mobile-opsi-btn"
            aria-expanded={opsiOpen}
            aria-controls="jk-mobile-opsi"
            title="Opsi folder, profil, model, dan izin"
            onClick={() => setOpsiOpen((open) => !open)}
          >
            <Icon name="gear" />
            <span class="jk-mobile-opsi-folder">
              Folder:{" "}
              {selectedWorkspace === undefined
                ? folderName(cwd.trim()) === "/"
                  ? "belum dipilih"
                  : folderName(cwd.trim())
                : selectedWorkspace.name}
            </span>
            <span class="jk-mobile-opsi-label">Opsi</span>
          </button>
        </div>
      )}
      <div class={`jk-comp-card${att.dragging ? " jk-dropping" : ""}`} {...att.dropProps}>
        {att.dragging && <DropHint />}
        <AttachmentTray items={att.items} pending={att.pending} error={att.error} onRemove={att.remove} />
        <label class="jk-visually-hidden" for="jk-prompt">
          Tugas
        </label>
        {slash.open && (
          <SlashMenu
            id={slash.listboxId}
            commands={slash.options}
            status={slash.status}
            source={slash.source}
            activeIndex={slash.activeIndex}
            onPick={slash.pick}
          />
        )}
        <div class="jk-pill-row">
          <AttachButton onFiles={(files) => void att.add(files)} disabled={busy} />
        <textarea
          id="jk-prompt"
          ref={promptRef}
          class="jk-comp-input"
          rows={1}
          placeholder={placeholderTugas(sempit)}
          value={prompt}
          onInput={onPromptInput}
          onKeyDown={onPromptKeyDown}
          onPaste={att.onPaste}
          disabled={busy}
          role="combobox"
          aria-expanded={slash.open}
          aria-controls={slash.open ? slash.listboxId : undefined}
          aria-activedescendant={slash.activeId}
          aria-autocomplete="list"
          aria-invalid={promptError !== undefined}
          aria-describedby={promptDescribedBy === "" ? undefined : promptDescribedBy}
        />
          <DictationButton dict={dict} />
          <button
            type="submit"
            class="jk-send"
            disabled={!canSend}
            aria-label={
              busy
                ? waitFor !== ""
                  ? "Menahan…"
                  : "Memulai…"
                : waitFor !== ""
                  ? "Tahan prompt"
                  : "Mulai sesi"
            }
          >
            <Icon name="send" />
          </button>
        </div>
      </div>

      <div class="jk-comp-meta" id={mobile ? "jk-mobile-opsi" : undefined}>
          {workspaces.length > 0 && (
            <label class="jk-chip" title="Workspace">
              <Icon name="workspace" />
              <span>{selectedWorkspace?.name ?? "Tanpa workspace"}</span>
              <Select
                id="jk-workspace"
                class="jk-chip-select"
                ariaLabel="Workspace"
                value={workspaceId}
                options={[
                  { value: "", label: "Tanpa workspace" },
                  ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name })),
                ]}
                onChange={(value) => setWorkspaceId(value)}
                disabled={busy}
              />
            </label>
          )}

          {selectedWorkspace !== undefined ? (
            <label class="jk-chip" title="Repo">
              <Icon name="folder" />
              <span>{repoLabel}</span>
              <Select
                id="jk-repo"
                class="jk-chip-select"
                ariaLabel="Repo"
                value={repoPath}
                options={repoOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                  disabled: option.missing,
                }))}
                onChange={(value) => setRepoPath(value)}
                disabled={busy}
                invalid={cwdError !== undefined}
                describedBy={cwdError !== undefined ? "jk-cwd-error" : undefined}
              />
            </label>
          ) : (
            <>
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
                  title={cwd}
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
                aria-label="Pilih folder"
                title={nativePicker ? "Pilih folder (dialog sistem)" : "Browse…"}
                data-folder-opener
                disabled={busy || picking}
                onClick={() => {
                  if (nativePicker) void pickNative();
                  else setPickerOpen((open) => !open);
                }}
              >
                Pilih folder
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
              label={modelLabel ?? "Model bawaan"}
              ariaLabel="Model"
              placement="down"
              align="start"
              disabled={busy}
              sections={[
                {
                  options: [
                    { value: "", label: "Model bawaan" },
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
                placeholder="Model bawaan"
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

          {runningSessions.length > 0 && (
            <label class="jk-chip" title="Tunggu sesi">
              <Icon name="clock" />
              <span>Tunggu sesi</span>
              <Select
                id="jk-wait-for"
                class="jk-chip-select"
                ariaLabel="Tunggu sesi"
                value={waitFor}
                options={[
                  { value: "", label: "Langsung mulai" },
                  ...runningSessions.map((session) => ({
                    value: session.id,
                    label:
                      session.title.length > 40
                        ? `${session.title.slice(0, 39)}…`
                        : session.title,
                  })),
                ]}
                onChange={(value) => setWaitFor(value)}
                disabled={busy}
              />
            </label>
          )}

      </div>

      {warning !== undefined && (
        <p class="jk-secret-warning" id="jk-prompt-secret-warning" role="status">
          {warning.message}
        </p>
      )}

      {goalCommand !== undefined && (
        <p class="jk-note jk-goal-note" role="status">
          Mulai sesi dulu, lalu ketik /goal di kolom balasan.
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
