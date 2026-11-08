import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type DirEntry, type FileContent } from "../lib/api";
import { breadcrumbs, formatSize, joinPath, splitLines } from "../lib/files";
import { formatCount } from "../lib/format";
import { Icon } from "./Icon";

export interface FilesTabProps {
  api: ApiClient;
  sessionId: string;
  open: boolean;
  refreshToken: number;
  /** Nama repo workspace; undefined berarti repo utama (cwd sesi). */
  repo?: string;
}

interface Listing {
  path: string;
  entries: DirEntry[];
  truncated: boolean;
}

function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "isi folder tidak dapat dimuat";
}

export function FilesTab({ api, sessionId, open, refreshToken, repo }: FilesTabProps) {
  const [dir, setDir] = useState("");
  const [listing, setListing] = useState<Listing | undefined>(undefined);
  const [file, setFile] = useState<FileContent | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const requestRef = useRef(0);
  const tokenRef = useRef(0);
  const loadedRef = useRef(false);
  const repoRef = useRef(repo);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const run = async (path: string, kind: "list" | "file"): Promise<void> => {
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
        const payload = await api.getFile(sessionId, path, repo);
        if (ticket !== requestRef.current) return;
        setFile(payload);
      }
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setError(errorMessage(caught));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  };

  // Muat saat tab dibuka; refresh hanya berlaku untuk tampilan yang sedang aktif.
  // Repo berganti: kembali ke akar pohon dan muat ulang dari awal.
  useEffect(() => {
    if (!open) return;
    const forced = refreshToken !== tokenRef.current;
    const repoChanged = repoRef.current !== repo;
    repoRef.current = repo;
    if (!forced && !repoChanged && loadedRef.current) return;
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

  // Kembali dari penampil: fokus ke daftar; saat membuka berkas: fokus ke "Kembali".
  useEffect(() => {
    if (file !== undefined) backRef.current?.focus();
    else listRef.current?.focus();
  }, [file]);

  const enterDir = (entry: DirEntry): void => {
    if (entry.type !== "dir") return;
    setDir(joinPath(dir, entry.name));
    void run(joinPath(dir, entry.name), "list");
  };

  const goBack = (): void => {
    void run(dir, "list");
  };

  const crumbs = breadcrumbs(dir);

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
                setDir(crumb.path);
                void run(crumb.path, "list");
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

      {loading && <p class="jk-panel-note">Memuat…</p>}

      {file !== undefined ? (
        <div class="jk-panel-file-view">
          <div class="jk-panel-file-head">
            <button
              ref={backRef}
              type="button"
              class="jk-link-btn"
              onClick={() => {
                setFile(undefined);
                goBack();
              }}
            >
              ← Kembali
            </button>
            <span class="jk-panel-name" title={file.path}>
              {file.path}
            </span>
            <span class="jk-panel-size">{formatSize(file.size)}</span>
          </div>
          {file.binary ? (
            <p class="jk-panel-note">Berkas biner tidak ditampilkan.</p>
          ) : (
            <>
              <div class="jk-perm-code jk-panel-code" tabIndex={0} role="region" aria-label={`Isi ${file.path}`}>
                {splitLines(file.content ?? "").map((line, index) => (
                  <div class="jk-perm-line" key={index}>
                    <i>{index + 1}</i>
                    <span>{line === "" ? " " : line}</span>
                  </div>
                ))}
              </div>
              {file.truncated && <p class="jk-panel-note">Hanya 256 KB pertama yang ditampilkan.</p>}
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
                    else void run(joinPath(dir, entry.name), "file");
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
    </div>
  );
}
