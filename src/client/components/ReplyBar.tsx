import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import { ApiError, type ApiClient } from "../lib/api";
import { secretWarning } from "../lib/secret-warning";
import { canSendToSession } from "../lib/worktree";
import { Icon } from "./Icon";

export interface ReplyBarProps {
  api: ApiClient;
  session: SessionInfo;
  refresh: () => Promise<void>;
}

const MAX_TEXTAREA_PX = 8 * 24;

const MODE_OPTIONS: { value: "default" | "acceptEdits" | "plan"; label: string }[] = [
  { value: "default", label: "Ask permissions" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
];

function autosize(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_PX)}px`;
}

export function ReplyBar({ api, session, refresh }: ReplyBarProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const sessionId = session.id;

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
  const canSend = !busy && usable.allowed && text.trim() !== "";
  const warning = useMemo(() => secretWarning(text), [text]);
  const describedBy = [
    usable.allowed ? undefined : "jk-reply-blocked",
    warning === undefined ? undefined : "jk-reply-secret-warning",
  ]
    .filter((id): id is string => id !== undefined)
    .join(" ");

  const changeMode = async (mode: "default" | "acceptEdits" | "plan"): Promise<void> => {
    setError(undefined);
    try {
      await api.setSessionPermissionMode(sessionId, mode);
      void refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "gagal mengganti mode izin");
    }
  };

  const bypass = session.permissionMode === "bypassPermissions";
  const modeLabel = bypass
    ? "Bypass permissions"
    : (MODE_OPTIONS.find((option) => option.value === session.permissionMode)?.label ?? "");

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const trimmed = text.trim();
    setBusy(true);
    setError(undefined);
    try {
      await api.sendMessage(sessionId, trimmed);
      setText("");
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
        <div class="jk-comp-card">
          <label class="jk-visually-hidden" for="jk-reply">
            Pesan lanjutan
          </label>
          <textarea
            id="jk-reply"
            ref={textareaRef}
            class="jk-comp-input"
            rows={1}
            placeholder={running ? "Tambahkan ke antrean…" : "Balas…"}
            value={text}
            onInput={onInput}
            onKeyDown={onKeyDown}
            disabled={!usable.allowed || busy}
            aria-describedby={describedBy === "" ? undefined : describedBy}
          />

          <div class="jk-comp-bar">
            <label
              class="jk-chip"
              title={running ? "Berlaku mulai balasan berikutnya" : "Mode izin sesi"}
            >
              <Icon name="eye" />
              <span>{modeLabel}</span>
              <select
                class="jk-chip-select"
                aria-label="Mode izin sesi"
                value={session.permissionMode}
                disabled={bypass}
                onChange={(event) =>
                  void changeMode(
                    (event.currentTarget as HTMLSelectElement).value as
                      | "default"
                      | "acceptEdits"
                      | "plan",
                  )
                }
              >
                {MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                {bypass && <option value="bypassPermissions">Bypass permissions</option>}
              </select>
            </label>
            {session.queued > 0 && (
              <span class="jk-reply-queue">{session.queued} pesan menunggu giliran</span>
            )}
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
