import type { DirEntry } from "../lib/api";
import { filterRows, flattenTree } from "../lib/file-tree";
import { AddContextButton } from "./AddContextButton";
import { Icon } from "./Icon";

export interface FileTreeProps {
  /** Daftar isi folder yang sudah dimuat, kunci = path folder ("" = akar). */
  listings: Readonly<Record<string, readonly DirEntry[]>>;
  expanded: ReadonlySet<string>;
  /** Berkas yang sedang dibuka. */
  activePath?: string;
  filter: string;
  onFilterChange: (value: string) => void;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  /** Tambah berkas ke konteks; tombol muncul di baris berkas. */
  onAddContext?: (path: string) => void;
}

/** Pohon berkas di sisi kanan penampil berkas. */
export function FileTree({
  listings,
  expanded,
  activePath,
  filter,
  onFilterChange,
  onToggle,
  onOpen,
  onAddContext,
}: FileTreeProps) {
  const rows = filterRows(flattenTree(listings, expanded), filter);
  return (
    <div class="jk-file-tree">
      <input
        type="search"
        class="jk-input jk-file-tree-filter"
        placeholder="Saring berkas"
        aria-label="Saring berkas di pohon"
        value={filter}
        onInput={(event) => onFilterChange((event.currentTarget as HTMLInputElement).value)}
      />
      <div class="jk-file-tree-rows" role="tree" aria-label="Pohon berkas">
        {rows.map((row) => (
          <div class="jk-file-tree-item" key={row.path}>
          <button
            type="button"
            role="treeitem"
            class="jk-file-tree-row"
            aria-expanded={row.isDir ? row.expanded : undefined}
            aria-current={row.path === activePath ? "true" : undefined}
            style={{ paddingLeft: `${6 + row.depth * 14}px` }}
            onClick={() => {
              if (row.isDir) onToggle(row.path);
              else onOpen(row.path);
            }}
          >
            <span class="jk-file-tree-chev" aria-hidden="true">
              {row.isDir && <Icon name={row.expanded ? "chevron-down" : "chevron"} />}
            </span>
            <Icon name={row.isDir ? "folder" : "file"} />
            <span class="jk-file-tree-name">{row.name}</span>
          </button>
          {onAddContext !== undefined && !row.isDir && (
            <AddContextButton path={row.path} onAdd={onAddContext} subtle />
          )}
          </div>
        ))}
      </div>
    </div>
  );
}
