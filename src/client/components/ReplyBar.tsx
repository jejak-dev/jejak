import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import type { RegistryView } from "../lib/registry-view";
import { ApiError, type ApiClient, type SandboxMode, type SandboxState } from "../lib/api";
import { secretWarning } from "../lib/secret-warning";
import { canSendToSession } from "../lib/worktree";
import { BYPASS_WARNING } from "../lib/permission-mode";
import { parseBtw } from "../lib/btw";
import { formatTokens, type ContextUsage } from "../lib/context";
import { appendAttachments } from "../lib/attachments";
import { AttachButton, AttachmentTray, DropHint } from "./AttachmentParts";
import { Dropdown, type DropdownSection } from "./Dropdown";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { useAttachments } from "./useAttachments";

export interface ReplyBarProps {
  api: ApiClient;
  session: SessionInfo;
  refresh: () => Promise<void>;
  /** Penggunaan konteks dari hasil terakhir; kosong bila belum diketahui. */
  context?: ContextUsage;
  /** Profil provider untuk pemilih provider/model; tanpa ini pemilih tidak tampil. */
  registry?: RegistryView;
  /** Teks yang ditaruh di kolom input (mis. pesan yang dibuang saat mundur). */
  draft?: { text: string; nonce: number };
}

const MAX_TEXTAREA_PX = 8 * 24;

type LiveMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

const MODE_OPTIONS: { value: LiveMode; label: string }[] = [
  { value: "default", label: "Ask permissions" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Lewati izin (berbahaya)" },
];

/** Kartu pertanyaan sampingan: satu kartu pada satu waktu. */
interface AsideState {
  question: string;
  status: "menjawab" | "selesai";
  answer?: string;
}

function autosize(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_PX)}px`;
}

export function ReplyBar({ api, session, refresh, context, registry, draft }: ReplyBarProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const att = useAttachments(api);
  const ctxRef = useRef<HTMLDetailsElement | null>(null);

  const sessionId = session.id;

  // Kartu pertanyaan sampingan; hilang saat ganti sesi.
  const [aside, setAside] = useState<AsideState | undefined>(undefined);
  const asideSessionRef = useRef(sessionId);

  useEffect(() => {
    asideSessionRef.current = sessionId;
    setAside(undefined);
  }, [sessionId]);

  // Teks hasil mundur percakapan ditaruh di kolom input agar bisa disunting.
  useEffect(() => {
    if (draft === undefined) return;
    setText(draft.text);
    textareaRef.current?.focus();
  }, [draft]);

  // Tinggi kolom input mengikuti isi (termasuk teks yang ditaruh dari luar).
  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    autosize(element);
  }, [text]);

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
        : `Konteks: ${formatTokens(context.tokens)} dari ${formatTokens(context.window)} token (jendela diatur di profil model; bila kosong, tebakan SDK)`;

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

  const [sandboxState, setSandboxState] = useState<SandboxState | undefined>(undefined);

  // Status sandbox hanya untuk menampilkan pilihan; galat/503 berarti pilihan disembunyikan.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await api.getSandbox();
        if (active) setSandboxState(next);
      } catch {
        // Pilihan sandbox tidak tampil; sesi memakai pengaturan server.
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  const sandboxMode: SandboxMode | undefined =
    sandboxState === undefined ? undefined : (session.sandbox ?? sandboxState.config.mode);

  const changeSandbox = async (mode: SandboxMode): Promise<void> => {
    setError(undefined);
    try {
      await api.setSessionSandbox(sessionId, mode);
      void refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "gagal mengganti sandbox");
    }
  };

  const modelSections: DropdownSection[] = [];
  if (modelList.length > 1) {
    modelSections.push({
      title: "Model",
      options: modelList.map((entry) => ({ value: entry.id, label: entry.label ?? entry.id })),
      value: modelId,
      onSelect: (value) => void changeProvider({ profileId: session.profileId, model: value }),
    });
  }
  if (profiles.length > 1) {
    modelSections.push({
      title: "Provider",
      options: profiles.map((profile) => ({ value: profile.id, label: profile.name })),
      value: session.profileId,
      onSelect: (value) => void changeProvider({ profileId: value }),
    });
  }

  /** Pertanyaan sampingan (`/btw`): dijawab dari salinan percakapan. */
  const submitAside = async (question: string): Promise<void> => {
    if (busy) return;
    const asked = sessionId;
    setBusy(true);
    setError(undefined);
    setAside({ question, status: "menjawab" });
    try {
      const result = await api.askSideQuestion(asked, question);
      if (asideSessionRef.current !== asked) return;
      setAside({ question, status: "selesai", answer: result.answer });
      setText("");
      att.clear();
      if (textareaRef.current !== null) {
        autosize(textareaRef.current);
        textareaRef.current.focus();
      }
    } catch (caught) {
      if (asideSessionRef.current !== asked) return;
      setAside(undefined);
      setError(
        caught instanceof ApiError ? caught.message : "gagal menjawab pertanyaan sampingan",
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    const question = parseBtw(text.trim());
    if (question !== undefined) {
      await submitAside(question);
      return;
    }
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
        {aside !== undefined && (
          <div class="jk-btw-card" role="status" aria-label="Jawaban pertanyaan sampingan">
            <div class="jk-btw-head">
              <span class="jk-btw-question">{aside.question}</span>
              <button
                type="button"
                class="jk-link-btn"
                onClick={() => setAside(undefined)}
              >
                Tutup
              </button>
            </div>
            {aside.status === "menjawab" ? (
              <p class="jk-note jk-btw-waiting">Menjawab…</p>
            ) : (
              <div class="jk-btw-answer">
                <Markdown text={aside.answer ?? ""} />
              </div>
            )}
          </div>
        )}
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
          {modelSections.length > 0 ? (
            <Dropdown
              label={modelLabel}
              detail={profiles.length > 1 ? (currentProfile?.name ?? session.profileId) : undefined}
              ariaLabel="Model dan provider sesi"
              title="Model dan provider sesi; berlaku mulai balasan berikutnya"
              sections={modelSections}
            />
          ) : (
            modelId !== "" && <span class="jk-chip jk-chip-plain">{modelLabel}</span>
          )}
          <Dropdown
            label={modeLabel}
            ariaLabel="Mode izin sesi"
            title={running ? "Berlaku mulai balasan berikutnya" : "Mode izin sesi"}
            sections={[
              {
                options: MODE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                  danger: option.value === "bypassPermissions",
                })),
                value: session.permissionMode,
                onSelect: (value) => void changeMode(value as LiveMode),
              },
            ]}
          />
          {sandboxMode !== undefined && (
            <Dropdown
              label={sandboxMode === "mati" ? "Tanpa sandbox" : "Sandbox"}
              ariaLabel="Sandbox sesi"
              title={running ? "Berlaku mulai balasan berikutnya" : "Sandbox sesi"}
              sections={[
                {
                  options: [
                    {
                      value: "standar",
                      label: "Standar",
                      hint: "Bash dibatasi berkas dan jaringan",
                    },
                    {
                      value: "mati",
                      label: "Mati",
                      danger: true,
                      hint: "Bash tanpa batas; dicatat di Audit log",
                    },
                  ],
                  value: sandboxMode,
                  onSelect: (value) => void changeSandbox(value as SandboxMode),
                },
              ]}
            />
          )}
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
