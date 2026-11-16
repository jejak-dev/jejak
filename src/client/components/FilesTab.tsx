import { useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ApiClient,
  type DirEntry,
  type FileContent,
  type SearchResult,
} from "../lib/api";
import { breadcrumbs, formatSize, joinPath, parentPath, splitLines } from "../lib/files";
import {
  describeSaveError,
  segmentByRanges,
  isDirty,
  isEditable,
} from "../lib/editor";
import { formatCount } from "../lib/format";
import { Icon } from "./Icon";

export interface FilesTabProps {
  api: ApiClient;
  sessionId: string;
  open: boolean;
  refreshToken: number;
  /** Nama repo workspace; undefined berarti repo utama (cwd sesi). */
  repo?: string;
  /** Sesi sedang berjalan: penyuntingan dinonaktifkan sampai selesai. */
  sessionRunning?: boolean;
}

interface Listing {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
}

const SEARCH_DEBOUNCE_MS = 300;
const SAVED_NOTE_MS = 2500;

function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "isi folder tidak dapat dimuat";
}

/** "a, b" -> ["a", "b"]; item kosong dibuang. */
function splitGlobs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** Mengelompokkan hasil per berkas, mempertahankan urutan server. */
function groupByFile<T extends { path: string }>(matches: T[]): Array<{ path: string; items: T[] }> {
  const groups: Array<{ path: string; items: T[] }> = [];
  for (const match of matches) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.path === match.path) last.items.push(match);
    else groups.push({ path: match.path, items: [match] });
  }
  return groups;
}

function searchErrorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "pencarian tidak dapat dijalankan";
}

export function FilesTab({
  api,
  sessionId,
  open,
  refreshToken,
  repo,
  sessionRunning = false,
}: FilesTabProps) {
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState<Listing | undefined>(undefined);
  const [file, setFile] = useState<FileContent | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const [searchInput, setSearchInput] = useState("");
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchWord, setSearchWord] = useState(false);
  const [searchInclude, setSearchInclude] = useState("");
  const [searchExclude, setSearchExclude] = useState("");
  const [searchResult, setSearchResult] = useState<SearchResult | undefined>(undefined);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [editDisabled, setEditDisabled] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [highlightLine, setHighlightLine] = useState<number | undefined>(undefined);

  const requestRef = useRef(0);
  const searchRef = useRef(0);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tokenRef = useRef(0);
  const loadedRef = useRef(false);
  const repoRef = useRef(repo);
  const openedRepoRef = useRef(repo);
  const pendingActionRef = useRef<(() => void) | undefined>(undefined);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);

  const original = file?.content ?? "";
  const dirty = file !== undefined && editing && isDirty(original, draft);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const run = async (path: string, kind: "list" | "file", line?: number): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      if (kind === "list") {
        const payload = await api.getFiles(sessionId, path === "" ? undefined : path, repo);
        if (ticket !== requestRef.current) return;
        setListing(payload);
        setFile(undefined);
      } else {
        openedRepoRef.current = repo;
        const payload = await api.getFile(sessionId, path, repo);
        if (ticket !== requestRef.current) return;
        setFile(payload);
        setHighlightLine(line);
      }
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setError(errorMessage(caught));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  };

  const resetEditor = (): void => {
    setEditing(false);
    setDraft("");
    setSaveError(undefined);
    setConflict(false);
    setConfirmReload(false);
  };

  const clearSavedNote = (): void => {
    if (savedTimerRef.current !== undefined) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = undefined;
    setSavedNote(false);
  };

  const showSavedNote = (): void => {
    if (savedTimerRef.current !== undefined) clearTimeout(savedTimerRef.current);
    setSavedNote(true);
    savedTimerRef.current = setTimeout(() => {
      savedTimerRef.current = undefined;
      setSavedNote(false);
    }, SAVED_NOTE_MS);
  };

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== undefined) clearTimeout(savedTimerRef.current);
    };
  }, []);

  /** Jalankan navigasi; tahan dulu bila ada suntingan yang belum disimpan. */
  const leave = (action: () => void): void => {
    if (dirtyRef.current) {
      pendingActionRef.current = action;
      setConfirmDiscard(true);
      return;
    }
    action();
  };

  const discardAndRun = (): void => {
    setConfirmDiscard(false);
    const action = pendingActionRef.current;
    pendingActionRef.current = undefined;
    resetEditor();
    clearSavedNote();
    action?.();
  };

  const keepEditing = (): void => {
    setConfirmDiscard(false);
    pendingActionRef.current = undefined;
  };

  const clearSearch = (): void => {
    searchRef.current += 1;
    setSearchResult(undefined);
    setSearchError(undefined);
    setSearchLoading(false);
  };

  // Muat saat tab dibuka; refresh hanya berlaku untuk tampilan yang sedang aktif.
  // Repo berganti: kembali ke akar pohon dan muat ulang dari awal.
  useEffect(() => {
    if (!open) return;
    const forced = refreshToken !== tokenRef.current;
    const repoChanged = repoRef.current !== repo;
    repoRef.current = repo;
    if (!forced && !repoChanged && loadedRef.current) return;
    if (repoChanged) clearSearch();
    // Draf yang sedang dikerjakan tidak boleh tertimpa muat ulang otomatis.
    if (dirtyRef.current) {
      tokenRef.current = refreshToken;
      if (repoChanged) {
        pendingActionRef.current = () => {
          setDir("");
          setFile(undefined);
          setListing(undefined);
          void run("", "list");
        };
        setConfirmDiscard(true);
      }
      return;
    }
    loadedRef.current = true;
    tokenRef.current = refreshToken;
    if (repoChanged) {
      setDir("");
      setFile(undefined);
      setListing(undefined);
      void run("", "list");
      return;
    }
    void run(file === undefined ? dir : file.path, file === undefined ? "list" : "file");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId, refreshToken, repo]);

  // Pencarian teks: debounce 300 ms; respons lama diabaikan lewat penghitung.
  useEffect(() => {
    if (!open) return;
    const query = searchInput.trim();
    if (query === "") {
      clearSearch();
      return;
    }
    setSearchLoading(true);
    const timer = setTimeout(() => {
      searchTimerRef.current = undefined;
      void runSearch(query);
    }, SEARCH_DEBOUNCE_MS);
    searchTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (searchTimerRef.current === timer) searchTimerRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, searchInput, searchCase, searchRegex, searchWord, searchInclude, searchExclude, repo, sessionId]);

  const runSearch = async (query: string): Promise<void> => {
    searchRef.current += 1;
    const ticket = searchRef.current;
    setSearchLoading(true);
    setSearchError(undefined);
    try {
      const payload = await api.searchFiles(sessionId, query, {
        repo,
        caseSensitive: searchCase,
        regex: searchRegex,
        wholeWord: searchWord,
        include: splitGlobs(searchInclude),
        exclude: splitGlobs(searchExclude),
      });
      if (ticket !== searchRef.current) return;
      setSearchResult(payload);
    } catch (caught) {
      if (ticket !== searchRef.current) return;
      setSearchResult(undefined);
      setSearchError(searchErrorMessage(caught));
    } finally {
      if (ticket === searchRef.current) setSearchLoading(false);
    }
  };

  // Kembali dari penampil: fokus ke daftar; saat membuka berkas: fokus ke "Kembali".
  useEffect(() => {
    if (file !== undefined) backRef.current?.focus();
    else listRef.current?.focus();
  }, [file]);

  // Gulir ke baris hasil pencarian setelah berkas termuat.
  useEffect(() => {
    if (file === undefined || highlightLine === undefined) return;
    const node = codeRef.current?.querySelector(`[data-line="${highlightLine}"]`);
    if (node instanceof HTMLElement) node.scrollIntoView({ block: "center" });
  }, [file, highlightLine]);

  // Peringatan peramban saat ada suntingan yang belum disimpan.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const enterDir = (entry: DirEntry): void => {
    if (entry.type !== "dir") return;
    setDir(joinPath(dir, entry.name));
    void run(joinPath(dir, entry.name), "list");
  };

  const openFile = (path: string, line?: number): void => {
    leave(() => {
      resetEditor();
      setDir(parentPath(path));
      void run(path, "file", line);
    });
  };

  const goBack = (): void => {
    leave(() => {
      resetEditor();
      setDir(dir);
      void run(dir, "list");
    });
  };

  const startEdit = (): void => {
    if (file === undefined || !isEditable(file)) return;
    setEditing(true);
    setDraft(file.content ?? "");
    setSaveError(undefined);
    setConflict(false);
    setConfirmReload(false);
    clearSavedNote();
  };

  const cancelEdit = (): void => {
    if (dirty) {
      pendingActionRef.current = () => {
        resetEditor();
        clearSavedNote();
      };
      setConfirmDiscard(true);
      return;
    }
    resetEditor();
    clearSavedNote();
  };

  const save = async (): Promise<void> => {
    if (file === undefined || file.version === undefined || saving) return;
    setSaving(true);
    setSaveError(undefined);
    setConflict(false);
    setConfirmReload(false);
    try {
      const result = await api.saveFile(sessionId, {
        path: file.path,
        content: draft,
        baseVersion: file.version,
        repo: openedRepoRef.current,
      });
      setFile({
        ...file,
        content: draft,
        size: result.size,
        version: result.version,
      });
      resetEditor();
      showSavedNote();
    } catch (caught) {
      const described = describeSaveError(caught);
      setSaveError(described.message);
      setConflict(described.conflict);
      if (caught instanceof ApiError && caught.status === 403) setEditDisabled(true);
    } finally {
      setSaving(false);
    }
  };

  const reloadFromDisk = async (): Promise<void> => {
    if (file === undefined) return;
    setConfirmReload(false);
    setSaveError(undefined);
    try {
      const payload = await api.getFile(sessionId, file.path, openedRepoRef.current);
      setFile(payload);
      setDraft(payload.content ?? "");
      setConflict(false);
      setHighlightLine(undefined);
    } catch (caught) {
      setSaveError(errorMessage(caught));
    }
  };

  const keepEditingAfterConflict = (): void => {
    setConflict(false);
    setConfirmReload(false);
    setSaveError(undefined);
  };

  const onEditorKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "s" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    }
  };

  const crumbs = breadcrumbs(dir);
  const query = searchInput.trim();
  const showResults = query !== "";

  return (
    <div class="jk-panel-body">
      <nav class="jk-panel-crumbs" aria-label="Lokasi folder">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} class="jk-panel-crumb">
            {index > 0 && <span class="jk-panel-sep" aria-hidden="true">/</span>}
            <button
              type="button"
              class="jk-link-btn"
              aria-current={index === crumbs.length - 1 ? "location" : undefined}
              onClick={() => {
                leave(() => {
                  resetEditor();
                  setDir(crumb.path);
                  void run(crumb.path, "list");
                });
              }}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      {error !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {error}
          </p>
          <button
            type="button"
            class="jk-link-btn"
            onClick={() => void run(file === undefined ? dir : file.path, file === undefined ? "list" : "file")}
          >
            Coba lagi
          </button>
        </div>
      )}

      {confirmDiscard && (
        <div class="jk-panel-note jk-discard-prompt" role="alert">
          <span>Ada perubahan yang belum disimpan. Buang?</span>
          <button type="button" class="jk-link-btn" onClick={discardAndRun}>
            Buang
          </button>
          <button type="button" class="jk-link-btn" onClick={keepEditing}>
            Tetap di sini
          </button>
        </div>
      )}

      {loading && <p class="jk-panel-note">Memuat…</p>}

      {file !== undefined ? (
        <div class="jk-panel-file-view">
          <div class="jk-panel-file-head">
            <button
              ref={backRef}
              type="button"
              class="jk-link-btn"
              onClick={goBack}
            >
              ← Kembali
            </button>
            <span class="jk-panel-name" title={file.path}>
              {file.path}
            </span>
            {dirty && <span class="jk-dirty-mark">Belum disimpan</span>}
            {!dirty && savedNote && <span class="jk-saved-mark" role="status">Tersimpan</span>}
            <span class="jk-panel-size">{formatSize(file.size)}</span>
            {!editing && !editDisabled && isEditable(file) && (
              <button
                type="button"
                class="jk-button jk-button-secondary jk-panel-edit-btn"
                disabled={sessionRunning}
                title={sessionRunning ? "Tunggu sesi selesai" : undefined}
                onClick={startEdit}
              >
                Sunting
              </button>
            )}
            {editing && (
              <>
                <button
                  type="button"
                  class="jk-button jk-button-primary jk-panel-edit-btn"
                  disabled={!dirty || saving}
                  onClick={() => void save()}
                >
                  {saving ? "Menyimpan…" : "Simpan"}
                </button>
                <button
                  type="button"
                  class="jk-button jk-button-secondary jk-panel-edit-btn"
                  onClick={cancelEdit}
                >
                  Batal
                </button>
              </>
            )}
          </div>

          {editDisabled && !editing && (
            <p class="jk-panel-note">Penyuntingan berkas dimatikan di server.</p>
          )}
          {sessionRunning && !editing && !editDisabled && isEditable(file) && (
            <p class="jk-panel-note">Tunggu sesi selesai untuk menyunting berkas ini.</p>
          )}

          {saveError !== undefined && (
            <div class="jk-panel-error">
              <p class="jk-error-line" role="alert">
                {saveError}
              </p>
              {conflict && (
                <div class="jk-save-actions">
                  {confirmReload ? (
                    <>
                      <span class="jk-panel-note">Buang perubahan?</span>
                      <button type="button" class="jk-link-btn" onClick={() => void reloadFromDisk()}>
                        Buang
                      </button>
                      <button type="button" class="jk-link-btn" onClick={() => setConfirmReload(false)}>
                        Tetap di sini
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" class="jk-link-btn" onClick={() => setConfirmReload(true)}>
                        Muat ulang dari disk
                      </button>
                      <button type="button" class="jk-link-btn" onClick={keepEditingAfterConflict}>
                        Tetap sunting
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {file.binary ? (
            <p class="jk-panel-note">Berkas biner tidak ditampilkan.</p>
          ) : editing ? (
            <textarea
              class="jk-editor"
              aria-label={`Sunting ${file.path}`}
              spellcheck={false}
              value={draft}
              onInput={(event) => setDraft((event.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={onEditorKeyDown}
            />
          ) : (
            <>
              <div
                ref={codeRef}
                class="jk-perm-code jk-panel-code"
                tabIndex={0}
                role="region"
                aria-label={`Isi ${file.path}`}
              >
                {splitLines(file.content ?? "").map((line, index) => (
                  <div
                    class={`jk-perm-line${index + 1 === highlightLine ? " jk-line-hit" : ""}`}
                    key={index}
                    data-line={highlightLine === index + 1 ? index + 1 : undefined}
                  >
                    <i aria-hidden="true">{index + 1}</i>
                    <span>{line === "" ? " " : line}</span>
                  </div>
                ))}
              </div>
              {file.truncated && <p class="jk-panel-note">Hanya 256 KB pertama yang ditampilkan.</p>}
            </>
          )}
        </div>
      ) : (
        <>
          <div class="jk-search">
            <input
              type="search"
              class="jk-input jk-search-input"
              placeholder="Cari teks di repo…"
              aria-label="Cari teks di repo"
              maxLength={200}
              value={searchInput}
              onInput={(event) => setSearchInput((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (searchTimerRef.current !== undefined) {
                    clearTimeout(searchTimerRef.current);
                    searchTimerRef.current = undefined;
                  }
                  const text = searchInput.trim();
                  if (text !== "") void runSearch(text);
                }
              }}
            />
            <button
              type="button"
              class={`jk-search-case${searchCase ? " jk-search-case-on" : ""}`}
              aria-pressed={searchCase}
              aria-label="Peka huruf besar-kecil"
              title="Peka huruf besar-kecil"
              onClick={() => setSearchCase((value) => !value)}
            >
              Aa
            </button>
            <button
              type="button"
              class={`jk-search-case${searchWord ? " jk-search-case-on" : ""}`}
              aria-pressed={searchWord}
              aria-label="Kata utuh"
              title="Kata utuh"
              onClick={() => setSearchWord((value) => !value)}
            >
              ab
            </button>
            <button
              type="button"
              class={`jk-search-case${searchRegex ? " jk-search-case-on" : ""}`}
              aria-pressed={searchRegex}
              aria-label="Regex"
              title="Regex (PCRE)"
              onClick={() => setSearchRegex((value) => !value)}
            >
              .*
            </button>
          </div>
          <div class="jk-search-globs">
            <input
              type="text"
              class="jk-input"
              placeholder="Sertakan: *.ts, src/**"
              aria-label="Sertakan berkas (glob, pisah koma)"
              value={searchInclude}
              onInput={(event) => setSearchInclude((event.currentTarget as HTMLInputElement).value)}
            />
            <input
              type="text"
              class="jk-input"
              placeholder="Kecualikan: tests/**"
              aria-label="Kecualikan berkas (glob, pisah koma)"
              value={searchExclude}
              onInput={(event) => setSearchExclude((event.currentTarget as HTMLInputElement).value)}
            />
          </div>

          {searchError !== undefined && (
            <p class="jk-error-line" role="alert">
              {searchError}
            </p>
          )}

          {showResults ? (
            <div class="jk-search-results" aria-live="polite">
              {searchLoading && <p class="jk-panel-note">Mencari…</p>}
              {!searchLoading && searchResult !== undefined && (
                <>
                  {searchResult.matches.length === 0 ? (
                    <p class="jk-panel-note">Tidak ada hasil.</p>
                  ) : (
                    groupByFile(searchResult.matches).map((group) => (
                      <div class="jk-search-group" key={group.path}>
                        <div class="jk-search-file">
                          <span class="jk-search-path">{group.path}</span>
                          <span class="jk-search-count">{group.items.length}</span>
                        </div>
                        {group.items.map((match, index) => {
                          const segments =
                            match.ranges !== undefined
                              ? segmentByRanges(match.text, match.ranges)
                              : undefined;
                          return (
                            <button
                              type="button"
                              class="jk-search-hit"
                              key={`${match.line}\0${index}`}
                              onClick={() => openFile(match.path, match.line)}
                            >
                              <span class="jk-search-line">{match.line}</span>
                              <span class="jk-search-text">
                                {segments === undefined
                                  ? match.text
                                  : segments.map((segment, at) =>
                                      segment.hit ? (
                                        <mark class="jk-search-match" key={at}>
                                          {segment.text}
                                        </mark>
                                      ) : (
                                        segment.text
                                      ),
                                    )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))
                  )}
                  {searchResult.truncated && <p class="jk-panel-note">Hasil dipotong.</p>}
                  <p class="jk-panel-note">
                    {formatCount(searchResult.matches.length)} hasil dari{" "}
                    {formatCount(searchResult.files)} berkas dipindai.
                  </p>
                </>
              )}
            </div>
          ) : (
            listing !== undefined && (
              <div ref={listRef} class="jk-panel-list" tabIndex={-1}>
                {listing.entries.length === 0 && <p class="jk-panel-note">Folder kosong.</p>}
                {listing.entries.map((entry) => {
                  const isLink = entry.type === "link";
                  const isDir = entry.type === "dir";
                  return (
                    <button
                      type="button"
                      class="jk-panel-entry"
                      key={entry.name}
                      disabled={isLink}
                      onClick={() => {
                        if (isDir) enterDir(entry);
                        else openFile(joinPath(dir, entry.name));
                      }}
                    >
                      <Icon name={isDir ? "folder" : "file"} />
                      <span class="jk-panel-entry-name">{entry.name}</span>
                      {isLink ? (
                        <span class="jk-panel-size">tautan simbolik</span>
                      ) : (
                        <span class="jk-panel-size">{isDir ? "" : formatSize(entry.size)}</span>
                      )}
                    </button>
                  );
                })}
                {listing.truncated && (
                  <p class="jk-panel-note">Daftar dipotong; hanya {formatCount(listing.entries.length)} entri yang ditampilkan.</p>
                )}
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
