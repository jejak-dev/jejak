import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type BrowseResult } from "../lib/api";
import { shortenPath } from "../lib/folder-picker";
import { Icon } from "./Icon";

export interface FolderPickerProps {
  api: ApiClient;
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Gagal memuat folder.";
}

export function FolderPicker({ api, initialPath, onPick, onClose }: FolderPickerProps) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const sequence = useRef(0);

  const load = async (target?: string, fallback = false): Promise<void> => {
    sequence.current += 1;
    const id = sequence.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await api.browseDirs(target);
      if (sequence.current !== id) return;
      setResult(next);
    } catch (caught) {
      if (sequence.current !== id) return;
      setError(errorMessage(caught));
      if (fallback) {
        try {
          const home = await api.browseDirs();
          if (sequence.current !== id) return;
          setResult(home);
        } catch {
          // Pesan galat pertama dipertahankan; daftar lama tetap tampil.
        }
      }
    } finally {
      if (sequence.current === id) setLoading(false);
    }
  };

  useEffect(() => {
    const opener = document.activeElement;
    const start = initialPath !== undefined && initialPath !== "" ? initialPath : undefined;
    void load(start, start !== undefined);
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target) === true) return;
      if (target instanceof Element && target.closest("[data-folder-opener]") !== null) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  const current = result;
  const pickable = current !== null;

  return (
    <div
      class="jk-picker"
      role="dialog"
      aria-label="Browse folder"
      tabIndex={-1}
      ref={panelRef}
    >
      <div class="jk-picker-head">
        <span class="jk-picker-path" title={current?.path ?? initialPath ?? ""}>
          {shortenPath(current?.path ?? initialPath ?? "", 38)}
        </span>
        <button
          type="button"
          class="jk-icon-btn jk-picker-nav"
          aria-label="Parent folder"
          title="Parent folder"
          disabled={current === null || current.parent === null}
          onClick={() => {
            if (current?.parent != null) void load(current.parent);
          }}
        >
          ↑
        </button>
        <button
          type="button"
          class="jk-link-btn"
          disabled={current === null}
          onClick={() => {
            if (current !== null) void load(current.home);
          }}
        >
          Home
        </button>
      </div>

      {error !== undefined && (
        <p class="jk-error-line" role="alert">
          {error}
        </p>
      )}

      <div class="jk-picker-list" aria-busy={loading}>
        {loading && current === null && <p class="jk-help">Memuat…</p>}
        {current !== null && current.entries.length === 0 && (
          <p class="jk-empty-line">Tidak ada subfolder.</p>
        )}
        {current?.entries.map((entry) => (
          <button
            type="button"
            key={entry.path}
            class="jk-picker-row"
            title={entry.path}
            onClick={() => void load(entry.path)}
          >
            <Icon name="folder" />
            <span class="jk-picker-name">{entry.name}</span>
            {entry.git && <span class="jk-picker-git">git</span>}
          </button>
        ))}
        {current?.truncated === true && (
          <p class="jk-help">Daftar dipotong, ketik path untuk lebih spesifik.</p>
        )}
      </div>

      <div class="jk-picker-foot">
        <button
          type="button"
          class="jk-button jk-button-primary"
          disabled={!pickable}
          onClick={() => {
            if (current !== null) onPick(current.path);
          }}
        >
          Pilih folder ini
        </button>
      </div>
    </div>
  );
}
