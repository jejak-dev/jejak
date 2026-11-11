import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import type { RegistryView } from "../lib/registry-view";
import { ApiError, type ApiClient } from "../lib/api";
import { secretWarning } from "../lib/secret-warning";
import { canSendToSession } from "../lib/worktree";
import { BYPASS_WARNING } from "../lib/permission-mode";
import { formatTokens, type ContextUsage } from "../lib/context";
import { appendAttachments } from "../lib/attachments";
import { AttachButton, AttachmentTray, DropHint } from "./AttachmentParts";
import { Icon } from "./Icon";
import { useAttachments } from "./useAttachments";

export interface ReplyBarProps {
  api: ApiClient;
  session: SessionInfo;
  refresh: () => Promise<void>;
  /** Penggunaan konteks dari hasil terakhir; kosong bila belum diketahui. */
  context?: ContextUsage;
  /** Profil provider untuk pemilih provider/model; tanpa ini pemilih tidak tampil. */
  registry?: RegistryView;
}

const MAX_TEXTAREA_PX = 8 * 24;

type LiveMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

const MODE_OPTIONS: { value: LiveMode; label: string }[] = [
  { value: "default", label: "Ask permissions" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Lewati izin (berbahaya)" },
];

function autosize(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_PX)}px`;
}

export function ReplyBar({ api, session, refresh, context, registry }: ReplyBarProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const att = useAttachments(api);
  const ctxRef = useRef<HTMLDetailsElement | null>(null);

  const sessionId = session.id;

  // Popover konteks menutup saat klik di luar atau tekan Esc.
  useEffect(() => {
    const close = (event: Event) => {
      const pop = ctxRef.current;
      if (pop === null || !pop.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") pop.open = false;
      } else if (!pop.contains(event.target as Node)) {
        pop.open = false;
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  useEffect(() => {
    const element = textareaRef.current;
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

  const running = session.status === "berjalan";
  const usable = canSendToSession(session);
  const canSend =
    !busy &&
    usable.allowed &&
    att.pending === 0 &&
    (text.trim() !== "" || att.items.length > 0);
  const warning = useMemo(() => secretWarning(text), [text]);
  const describedBy = [
    usable.allowed ? undefined : "jk-reply-blocked",
    warning === undefined ? undefined : "jk-reply-secret-warning",
  ]
    .filter((id): id is string => id !== undefined)
    .join(" ");

  const [confirmingBypass, setConfirmingBypass] = useState(false);

  const changeMode = async (mode: LiveMode, confirmBypass?: boolean): Promise<void> => {
    setError(undefined);
    if (mode === "bypassPermissions" && confirmBypass !== true) {
      setConfirmingBypass(true);
      return;
    }
    setConfirmingBypass(false);
    try {
      await api.setSessionPermissionMode(sessionId, mode, confirmBypass);
      void refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "gagal mengganti mode izin");
    }
  };

  const compact = async (): Promise<void> => {
    if (busy || running || !usable.allowed) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.sendMessage(sessionId, "/compact");
      void refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "gagal memadatkan percakapan");
    } finally {
      setBusy(false);
    }
  };

  const contextTitle =
    context === undefined
      ? undefined
      : context.window === undefined
        ? `Konteks: ${formatTokens(context.tokens)} token`
        : `Konteks: ${formatTokens(context.tokens)} dari ${formatTokens(context.window)} token (jendela menurut SDK, perkiraan untuk model non-Claude)`;

  const bypass = session.permissionMode === "bypassPermissions";
  const modeLabel =
    MODE_OPTIONS.find((option) => option.value === session.permissionMode)?.label.replace(
      " (berbahaya)",
      "",
    ) ?? "";

  const profiles = registry?.profiles ?? [];
  const currentProfile = profiles.find((profile) => profile.id === session.profileId);
  const modelList = currentProfile?.models ?? [];
  const modelId = session.model ?? "";
  const modelLabel = modelList.find((entry) => entry.id === modelId)?.label ?? (modelId || "Default model");

  const changeProvider = async (selection: { profileId?: string; model?: string }): Promise<void> => {
    setError(undefined);
    try {
      await api.setSessionProvider(sessionId, selection);
      void refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "gagal mengganti provider");
    }
  };

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const trimmed = appendAttachments(text, att.items);
    setBusy(true);
    setError(undefined);
    try {
      await api.sendMessage(sessionId, trimmed);
      setText("");
      att.clear();
      if (textareaRef.current !== null) {
        autosize(textareaRef.current);
        textareaRef.current.focus();
      }
      void refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "gagal mengirim pesan");
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    void submit();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const onInput = (event: Event): void => {
    const element = event.currentTarget as HTMLTextAreaElement;
    setText(element.value);
    autosize(element);
  };

  return (
    <form class="jk-reply" onSubmit={onSubmit} aria-busy={busy}>
      <div class="jk-reply-inner">
        <div class={`jk-comp-card${att.dragging ? " jk-dropping" : ""}`} {...att.dropProps}>
          {att.dragging && <DropHint />}
          <AttachmentTray items={att.items} pending={att.pending} error={att.error} onRemove={att.remove} />
          <label class="jk-visually-hidden" for="jk-reply">
            Pesan lanjutan
          </label>
          <div class="jk-pill-row">
            <AttachButton onFiles={(files) => void att.add(files)} disabled={!usable.allowed || busy} />
            <textarea
              id="jk-reply"
              ref={textareaRef}
              class="jk-comp-input"
              rows={1}
              placeholder={running ? "Tambahkan ke antrean…" : "Balas…"}
              value={text}
              onInput={onInput}
              onKeyDown={onKeyDown}
              onPaste={att.onPaste}
              disabled={!usable.allowed || busy}
              aria-describedby={describedBy === "" ? undefined : describedBy}
            />
            <button
              type="submit"
              class="jk-send"
              disabled={!canSend}
              aria-label="Kirim pesan"
              title={usable.reason}
            >
              <Icon name="send" />
            </button>
          </div>
        </div>

        <div class="jk-comp-meta jk-meta-end">
          {session.queued > 0 && (
            <span class="jk-reply-queue">{session.queued} pesan menunggu giliran</span>
          )}
          {profiles.length > 1 && (
            <label class="jk-chip jk-chip-plain" title="Provider sesi; berlaku mulai balasan berikutnya">
              <span>{currentProfile?.name ?? session.profileId}</span>
              <select
                class="jk-chip-select"
                aria-label="Provider sesi"
                value={session.profileId}
                onChange={(event) =>
                  void changeProvider({ profileId: (event.currentTarget as HTMLSelectElement).value })
                }
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {modelList.length > 1 && (
            <label class="jk-chip jk-chip-plain" title="Model sesi; berlaku mulai balasan berikutnya">
              <span>{modelLabel}</span>
              <select
                class="jk-chip-select"
                aria-label="Model sesi"
                value={modelId}
                onChange={(event) =>
                  void changeProvider({
                    profileId: session.profileId,
                    model: (event.currentTarget as HTMLSelectElement).value,
                  })
                }
              >
                {modelId !== "" && !modelList.some((entry) => entry.id === modelId) && (
                  <option value={modelId}>{modelId}</option>
                )}
                {modelList.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label ?? entry.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label
            class="jk-chip jk-chip-plain"
            title={running ? "Berlaku mulai balasan berikutnya" : "Mode izin sesi"}
          >
            <span>{modeLabel}</span>
            <select
              class="jk-chip-select"
              aria-label="Mode izin sesi"
              value={session.permissionMode}
              onChange={(event) =>
                void changeMode((event.currentTarget as HTMLSelectElement).value as LiveMode)
              }
            >
              {MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {context !== undefined && (
            <details ref={ctxRef} class={`jk-ctx-pop jk-ctx-${context.level}`}>
              <summary class="jk-ctx-ring" title={contextTitle} aria-label={contextTitle}>
                <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
                  <circle class="jk-ring-bg" cx="10" cy="10" r="7.5" />
                  <circle
                    class="jk-ring-fg"
                    cx="10"
                    cy="10"
                    r="7.5"
                    pathLength="100"
                    stroke-dasharray={`${context.percent ?? 0} 100`}
                    transform="rotate(-90 10 10)"
                  />
                </svg>
              </summary>
              <div class="jk-ctx-card">
                <strong>Konteks</strong>
                <p>
                  {context.percent !== undefined
                    ? `${context.percent}% terpakai`
                    : `${formatTokens(context.tokens)} token`}
                </p>
                <p class="jk-note">{contextTitle}</p>
                <button
                  type="button"
                  class="jk-button"
                  disabled={busy || running || !usable.allowed}
                  onClick={() => void compact()}
                  title="Padatkan percakapan (/compact) agar konteks lebih kecil"
                >
                  Compact
                </button>
              </div>
            </details>
          )}
        </div>

        {confirmingBypass && (
          <div class="jk-bypass-warn" role="alertdialog" aria-label="Konfirmasi lewati izin">
            <p>{BYPASS_WARNING}</p>
            <div class="jk-bypass-actions">
              <button
                type="button"
                class="jk-button jk-button-danger"
                onClick={() => void changeMode("bypassPermissions", true)}
              >
                Aktifkan lewati izin
              </button>
              <button type="button" class="jk-link-btn" onClick={() => setConfirmingBypass(false)}>
                Batal
              </button>
            </div>
          </div>
        )}

        {warning !== undefined && (
          <p class="jk-secret-warning" id="jk-reply-secret-warning" role="status">
            {warning.message}
          </p>
        )}

        {!usable.allowed && usable.reason !== undefined && (
          <p class="jk-note" id="jk-reply-blocked" role="status">
            {usable.reason}
          </p>
        )}

        {error !== undefined && (
          <p class="jk-error-line" role="alert">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
