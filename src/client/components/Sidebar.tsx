import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { SessionInfo } from "../../server/sessions/session-manager";
import { formatAgo, groupSessions } from "../lib/format";
import { showsBypassMarker } from "../lib/permission-mode";
import { canMutate, filterSessions, splitArchived, validateTitle } from "../lib/sessions";
import { notificationSupport, type NotifyPrefs } from "../lib/notify";
import { applyTheme, loadTheme, nextTheme, saveTheme, themeLabel, type ThemePref } from "../lib/theme";
import { Icon } from "./Icon";

export interface SidebarProps {
  info?: { name: string; version: string; mock: boolean };
  sessions: SessionInfo[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
  activeProfileLabel?: string;
  providersActive?: boolean;
  memoryActive?: boolean;
  workspacesActive?: boolean;
  mcpActive?: boolean;
  auditActive?: boolean;
  instruksiActive?: boolean;
  /** Jumlah usulan memory terbuka; angka kecil ditampilkan bila > 0. */
  memoryProposed?: number;
  onRename: (id: string, title: string) => Promise<void>;
  onArchive: (id: string, archived: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  notifyPrefs: NotifyPrefs;
  onNotifyPrefsChange: (prefs: NotifyPrefs) => void;
  onOpenPalette?: () => void;
  /** True bila autentikasi aktif; tombol "Keluar" hanya tampil bila true. */
  authRequired?: boolean;
  /** Aksi keluar (hapus sesi di server). */
  onLogout?: () => void;
}

function dotClass(session: SessionInfo): string {
  if (session.pendingPermissions > 0) return "jk-dot jk-dot-warn";
  if (session.status === "berjalan") return "jk-dot jk-dot-run";
  if (session.status === "gagal") return "jk-dot jk-dot-bad";
  return "jk-dot";
}

function dotLabel(session: SessionInfo): string | undefined {
  if (session.pendingPermissions > 0) return "Menunggu izin";
  if (session.status === "berjalan") return "Berjalan";
  if (session.status === "gagal") return "Gagal";
  return undefined;
}

function errorMessage(caught: unknown): string {
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "terjadi kesalahan";
}

type RowMode = "menu" | "rename" | "delete";

export function Sidebar({
  info,
  sessions,
  selectedId,
  onSelect,
  onNew,
  onClose,
  activeProfileLabel,
  providersActive = false,
  memoryActive = false,
  workspacesActive = false,
  mcpActive = false,
  auditActive = false,
  instruksiActive = false,
  memoryProposed,
  onRename,
  onArchive,
  onDelete,
  notifyPrefs,
  onNotifyPrefsChange,
  onOpenPalette,
  authRequired = false,
  onLogout,
}: SidebarProps) {
  const now = new Date();
  const [query, setQuery] = useState("");
  const [openRowId, setOpenRowId] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<RowMode>("menu");
  const [draft, setDraft] = useState("");
  const [rowError, setRowError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(() => {
    try {
      return loadTheme(window.localStorage);
    } catch {
      return "system";
    }
  });
  const cycleTheme = (): void => {
    const next = nextTheme(theme);
    setTheme(next);
    applyTheme(document.documentElement, next);
    try {
      saveTheme(window.localStorage, next);
    } catch {
      // penyimpanan tidak tersedia
    }
  };
  const [notifyError, setNotifyError] = useState<string | undefined>(undefined);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  /** `undefined` = tidak ada, `null` = kolom cari, id = baris sesi. */
  const pendingFocusRef = useRef<string | null | undefined>(undefined);

  const visible = filterSessions(sessions, query, false);
  const archivedVisible = filterSessions(splitArchived(sessions).archived, query, true);
  const groups = groupSessions(visible);
  const orderedIds = [...visible.map((session) => session.id), ...archivedVisible.map((session) => session.id)];

  const closeRow = useCallback((): void => {
    setOpenRowId(undefined);
    setMode("menu");
    setRowError(undefined);
  }, []);

  // Fokus pindah ke baris berikutnya (atau kolom cari) setelah daftar dimuat ulang
  // dan aksi baris ditutup. Ditunggu sampai baris kembali berbentuk tombol.
  useEffect(() => {
    if (openRowId !== undefined) return;
    const pending = pendingFocusRef.current;
    if (pending === undefined) return;
    pendingFocusRef.current = undefined;
    const target = pending === null ? undefined : rowRefs.current.get(pending);
    (target ?? searchRef.current)?.focus();
  }, [openRowId, sessions]);

  useEffect(() => {
    if (openRowId === undefined || mode !== "rename") return;
    renameRef.current?.focus();
    renameRef.current?.select();
  }, [mode, openRowId]);

  useEffect(() => {
    if (openRowId === undefined || mode !== "delete") return;
    deleteCancelRef.current?.focus();
  }, [mode, openRowId]);

  useEffect(() => {
    if (openRowId === undefined) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || busy) return;
      event.preventDefault();
      closeRow();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, closeRow, openRowId]);

  const nextFocusId = (id: string): string | null => {
    const index = orderedIds.indexOf(id);
    const remaining = orderedIds.filter((entry) => entry !== id);
    if (remaining.length === 0) return null;
    return remaining[Math.min(index < 0 ? 0 : index, remaining.length - 1)] ?? null;
  };

  const toggleRow = (session: SessionInfo): void => {
    setRowError(undefined);
    if (openRowId === session.id) {
      closeRow();
      return;
    }
    setOpenRowId(session.id);
    setMode("menu");
  };

  const startRename = (session: SessionInfo): void => {
    setOpenRowId(session.id);
    setMode("rename");
    setDraft(session.title);
    setRowError(undefined);
  };

  const askDelete = (session: SessionInfo): void => {
    setOpenRowId(session.id);
    setMode("delete");
    setRowError(undefined);
  };

  const submitRename = async (session: SessionInfo): Promise<void> => {
    if (busy) return;
    const message = validateTitle(draft);
    if (message !== undefined) {
      setRowError(message);
      return;
    }
    setBusy(true);
    setRowError(undefined);
    pendingFocusRef.current = session.id;
    try {
      await onRename(session.id, draft.trim());
      closeRow();
    } catch (caught) {
      pendingFocusRef.current = undefined;
      setRowError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (session: SessionInfo): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setRowError(undefined);
    pendingFocusRef.current = nextFocusId(session.id);
    try {
      await onArchive(session.id, true);
      closeRow();
    } catch (caught) {
      pendingFocusRef.current = undefined;
      setRowError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (session: SessionInfo): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setRowError(undefined);
    pendingFocusRef.current = session.id;
    try {
      await onArchive(session.id, false);
      closeRow();
    } catch (caught) {
      pendingFocusRef.current = undefined;
      setRowError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (session: SessionInfo): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setRowError(undefined);
    pendingFocusRef.current = nextFocusId(session.id);
    try {
      await onDelete(session.id);
      closeRow();
    } catch (caught) {
      // Baris tetap terbuka; fokus kembali ke tombol Batal agar keputusan tetap terjangkau.
      pendingFocusRef.current = undefined;
      setRowError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const renderRow = (session: SessionInfo, archived: boolean) => {
    const open = openRowId === session.id;
    const renaming = open && mode === "rename";
    const confirmingDelete = open && mode === "delete";
    const error = open ? rowError : undefined;
    const label = dotLabel(session);
    const mutable = canMutate(session);
    const errorId = `jk-session-rename-error-${session.id}`;

    return (
      <li class={`jk-session-item${open ? " jk-session-item-open" : ""}`} key={session.id}>
        {renaming ? (
          <form
            class="jk-session-edit"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename(session);
            }}
          >
            <label class="jk-visually-hidden" for={`jk-session-rename-${session.id}`}>
              Judul sesi
            </label>
            <input
              ref={renameRef}
              id={`jk-session-rename-${session.id}`}
              class="jk-input"
              type="text"
              value={draft}
              aria-invalid={error !== undefined}
              aria-describedby={error !== undefined ? errorId : undefined}
              onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  event.preventDefault();
                  closeRow();
                }
              }}
            />
            <div class="jk-session-edit-actions">
              <button type="submit" class="jk-link-btn" disabled={busy}>
                {busy ? "Menyimpan…" : "Simpan"}
              </button>
              <button
                type="button"
                class="jk-link-btn"
                disabled={busy}
                onClick={() => closeRow()}
              >
                Batal
              </button>
            </div>
          </form>
        ) : (
          <div class="jk-session-line">
            <button
              ref={(element) => {
                if (element === null) rowRefs.current.delete(session.id);
                else rowRefs.current.set(session.id, element);
              }}
              type="button"
              class={`jk-session-row${session.id === selectedId ? " jk-session-row-active" : ""}`}
              onClick={() => onSelect(session.id)}
              aria-current={session.id === selectedId ? "page" : undefined}
            >
              <span
                class={dotClass(session)}
                title={label}
                role={label === undefined ? undefined : "img"}
                aria-label={label}
                aria-hidden={label === undefined ? "true" : undefined}
              />
              <span class="jk-session-title">{session.title}</span>
              {showsBypassMarker(session.permissionMode) && (
                <span class="jk-session-bypass">Bypass</span>
              )}
              <time class="jk-session-time" dateTime={session.updatedAt}>
                {formatAgo(session.updatedAt, now)}
              </time>
            </button>
            {archived ? (
              !confirmingDelete && (
                <span class="jk-session-inline">
                  <button
                    type="button"
                    class="jk-link-btn"
                    disabled={busy}
                    aria-label={`Pulihkan sesi ${session.title}`}
                    onClick={() => void restore(session)}
                  >
                    Pulihkan
                  </button>
                  <button
                    type="button"
                    class="jk-link-btn jk-session-danger"
                    disabled={busy}
                    aria-label={`Hapus sesi ${session.title}`}
                    onClick={() => askDelete(session)}
                  >
                    Hapus
                  </button>
                </span>
              )
            ) : (
              <button
                type="button"
                class="jk-session-more"
                aria-label={`Aksi sesi ${session.title}`}
                aria-expanded={open}
                onClick={() => toggleRow(session)}
              >
                ⋯
              </button>
            )}
          </div>
        )}

        {open && !renaming && confirmingDelete && (
          <div class="jk-session-actions">
            <div class="jk-panel-confirm">
              <p>Hapus sesi ini? Tidak bisa diurungkan.</p>
              <div class="jk-panel-confirm-actions">
                <button
                  type="button"
                  class="jk-button jk-button-caution"
                  disabled={busy}
                  aria-label={`Konfirmasi hapus sesi ${session.title}`}
                  onClick={() => void confirmDelete(session)}
                >
                  {busy ? "Menghapus…" : "Hapus"}
                </button>
                <button
                  ref={deleteCancelRef}
                  type="button"
                  class="jk-button"
                  disabled={busy}
                  onClick={() => closeRow()}
                >
                  Batal
                </button>
              </div>
            </div>
          </div>
        )}

        {open && mode === "menu" && !archived && (
          <div class="jk-session-actions">
            <button
              type="button"
              class="jk-link-btn"
              disabled={busy}
              aria-label={`Ganti nama sesi ${session.title}`}
              onClick={() => startRename(session)}
            >
              Ganti nama
            </button>
            <button
              type="button"
              class="jk-link-btn"
              disabled={busy || !mutable}
              title={mutable ? undefined : "Hentikan sesi dulu."}
              aria-label={`Arsipkan sesi ${session.title}`}
              onClick={() => void archive(session)}
            >
              Arsipkan
            </button>
            <button
              type="button"
              class="jk-link-btn jk-session-danger"
              disabled={busy || !mutable}
              title={mutable ? undefined : "Hentikan sesi dulu."}
              aria-label={`Hapus sesi ${session.title}`}
              onClick={() => askDelete(session)}
            >
              Hapus
            </button>
          </div>
        )}

        {error !== undefined && (
          <p class="jk-error-line jk-session-error" role="alert" id={renaming ? errorId : undefined}>
            {error}
          </p>
        )}
      </li>
    );
  };

  const toggleNotify = async (): Promise<void> => {
    setNotifyError(undefined);
    if (notifyPrefs.enabled) {
      onNotifyPrefsChange({ enabled: false, sound: false });
      return;
    }
    const support = notificationSupport();
    if (support === "tidak-ada") {
      setNotifyError("Browser ini tidak mendukung notifikasi.");
      return;
    }
    let permission = support;
    if (permission === "belum") {
      try {
        permission = (await Notification.requestPermission()) === "granted" ? "diizinkan" : "ditolak";
      } catch {
        permission = "ditolak";
      }
    }
    if (permission !== "diizinkan") {
      setNotifyError("Browser memblokir notifikasi. Izinkan di pengaturan situs.");
      onNotifyPrefsChange({ enabled: false, sound: false });
      return;
    }
    onNotifyPrefsChange({ ...notifyPrefs, enabled: true });
  };

  const toggleSound = (): void => {
    if (!notifyPrefs.enabled) return;
    onNotifyPrefsChange({ ...notifyPrefs, sound: !notifyPrefs.sound });
  };

  // Teks pintasan sesuai platform (Mac: ⌘K, lain: Ctrl K).
  const paletteKeys = () => {
    const isMac =
      typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
    return isMac ? "⌘K" : "Ctrl K";
  };

  return (
    <aside class="jk-sidebar" aria-label="Navigasi">
      <header class="jk-brand">
        <h1 class="jk-brand-title">Jejak</h1>
        {info?.mock === true && <span class="jk-brand-tag">mock</span>}
        <button type="button" class="jk-icon-btn jk-drawer-close" onClick={onClose} aria-label="Tutup sidebar">
          <Icon name="menu" />
        </button>
      </header>

      <button type="button" class="jk-button jk-button-primary jk-new" onClick={onNew}>
        <Icon name="plus" />
        New session
      </button>

      <nav class="jk-groups" aria-label="Daftar sesi">
        {sessions.length >= 1 && (
          <div class="jk-session-search">
            <input
              ref={searchRef}
              id="jk-session-search"
              class="jk-input"
              type="search"
              placeholder="Cari sesi"
              aria-label="Cari sesi"
              value={query}
              onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setQuery("");
                }
              }}
            />
          </div>
        )}

        {sessions.length === 0 ? (
          <p class="jk-empty-line">Belum ada sesi.</p>
        ) : groups.length === 0 ? (
          archivedVisible.length === 0 && <p class="jk-empty-line">Tidak ada sesi yang cocok.</p>
        ) : (
          groups.map((group) => (
            <section class="jk-group" key={group.cwd}>
              <h2 class="jk-group-label" title={group.cwd}>
                <Icon name="folder" />
                <span>{group.label}</span>
              </h2>
              <ul class="jk-session-items">
                {group.items.map((session) => renderRow(session, false))}
              </ul>
            </section>
          ))
        )}

        {archivedVisible.length > 0 && (
          <details class="jk-archived">
            <summary>Diarsipkan ({archivedVisible.length})</summary>
            <ul class="jk-session-items">{archivedVisible.map((session) => renderRow(session, true))}</ul>
          </details>
        )}
      </nav>

      <footer class="jk-sidebar-foot">
        {onOpenPalette !== undefined && (
          <button type="button" class="jk-foot-link jk-foot-btn" onClick={onOpenPalette}>
            <span class="jk-foot-text">Perintah</span>
            <span class="jk-foot-count">{paletteKeys()}</span>
          </button>
        )}
        <a
          class={`jk-foot-link${workspacesActive ? " jk-foot-link-active" : ""}`}
          href="#/workspaces"
          aria-current={workspacesActive ? "page" : undefined}
        >
          <Icon name="workspace" />
          <span class="jk-foot-text">Workspace</span>
        </a>
        <a
          class={`jk-foot-link${memoryActive ? " jk-foot-link-active" : ""}`}
          href="#/memory"
          aria-current={memoryActive ? "page" : undefined}
        >
          <Icon name="memory" />
          <span class="jk-foot-text">Memory</span>
          {memoryProposed !== undefined && memoryProposed > 0 && (
            <span class="jk-foot-count">{memoryProposed}</span>
          )}
        </a>
        <a
          class={`jk-foot-link${mcpActive ? " jk-foot-link-active" : ""}`}
          href="#/mcp"
          aria-current={mcpActive ? "page" : undefined}
        >
          <Icon name="cube" />
          <span class="jk-foot-text">Server MCP</span>
        </a>
        <a
          class={`jk-foot-link${instruksiActive ? " jk-foot-link-active" : ""}`}
          href="#/instruksi"
          aria-current={instruksiActive ? "page" : undefined}
        >
          <Icon name="doc" />
          <span class="jk-foot-text">Instructions</span>
        </a>
        <a
          class={`jk-foot-link${auditActive ? " jk-foot-link-active" : ""}`}
          href="#/audit"
          aria-current={auditActive ? "page" : undefined}
        >
          <Icon name="audit" />
          <span class="jk-foot-text">Audit log</span>
        </a>
        <a
          class={`jk-foot-link${providersActive ? " jk-foot-link-active" : ""}`}
          href="#/providers"
          aria-current={providersActive ? "page" : undefined}
        >
          <Icon name="cube" />
          <span class="jk-foot-text">{activeProfileLabel ?? "Set up provider"}</span>
        </a>
        <button
          type="button"
          class="jk-foot-link jk-foot-btn"
          aria-label={`Tema: ${themeLabel(theme)}. Klik untuk mengganti.`}
          onClick={cycleTheme}
        >
          <Icon name={theme === "light" ? "sun" : theme === "dark" ? "moon" : "monitor"} />
          <span class="jk-foot-text">Tema</span>
          <span class="jk-foot-count">{themeLabel(theme)}</span>
        </button>
        <button
          type="button"
          class={`jk-foot-link jk-foot-btn${notifyPrefs.enabled ? " jk-foot-link-active" : ""}`}
          aria-expanded={notifyOpen}
          onClick={() => {
            setNotifyOpen((open) => !open);
            setNotifyError(undefined);
          }}
        >
          <Icon name="bell" />
          <span class="jk-foot-text">Notifications</span>
          <span class="jk-foot-count">{notifyPrefs.enabled ? "Aktif" : "Mati"}</span>
        </button>
        {notifyOpen && (
          <div class="jk-notify-menu">
            <button type="button" class="jk-link-btn" onClick={() => void toggleNotify()}>
              Notifikasi desktop: {notifyPrefs.enabled ? "aktif" : "mati"}
            </button>
            <button
              type="button"
              class="jk-link-btn"
              disabled={!notifyPrefs.enabled}
              onClick={toggleSound}
            >
              Bunyi: {notifyPrefs.sound ? "aktif" : "mati"}
            </button>
            {notifyError !== undefined && <p class="jk-error-line">{notifyError}</p>}
          </div>
        )}
        {authRequired && onLogout !== undefined && (
          <button
            type="button"
            class="jk-foot-link jk-foot-btn"
            onClick={() => onLogout()}
            aria-label="Keluar dari Jejak"
          >
            <span class="jk-foot-text">Keluar</span>
          </button>
        )}
      </footer>
    </aside>
  );
}
