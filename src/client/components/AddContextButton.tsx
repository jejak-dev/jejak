import { Icon } from "./Icon";

export interface AddContextButtonProps {
  path: string;
  onAdd: (path: string) => void;
  /** Tampil hanya saat baris disorot/difokus (untuk daftar). */
  subtle?: boolean;
}

/** Tombol "Tambah ke konteks": menaruh @jalur berkas di kolom pesan. */
export function AddContextButton({ path, onAdd, subtle = false }: AddContextButtonProps) {
  return (
    <button
      type="button"
      class={`jk-icon-btn jk-panel-tool-btn jk-add-context${subtle ? " jk-add-context-subtle" : ""}`}
      aria-label={`Tambah ${path} ke konteks`}
      title="Tambah ke konteks"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onAdd(path);
      }}
    >
      <Icon name="plus" />
    </button>
  );
}
