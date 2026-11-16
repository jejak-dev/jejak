import type { CommandInfo, CommandSource } from "../lib/api";
import type { CommandsStatus } from "../hooks";

export interface SlashMenuProps {
  /** Id listbox; dipakai `aria-controls` pada textarea. */
  id: string;
  /** Perintah yang cocok dengan query. */
  commands: readonly CommandInfo[];
  /** Status pemuatan daftar perintah. */
  status: CommandsStatus;
  /** Asal daftar perintah. */
  source: CommandSource;
  /** Indeks opsi aktif. */
  activeIndex: number;
  /** Dipanggil saat satu perintah dipilih. */
  onPick: (command: CommandInfo) => void;
}

/** Catatan kecil di bawah daftar. */
function Note({ children }: { children: string }) {
  return <div class="jk-slash-note">{children}</div>;
}

/**
 * Menu perintah slash.
 *
 * Daftar ringan di atas kolom input: nama perintah tebal, petunjuk argumen
 * redup, deskripsi satu baris dipotong. Props-nya murni supaya mudah
 * diuji tanpa DOM.
 */
export function SlashMenu({
  id,
  commands,
  status,
  source,
  activeIndex,
  onPick,
}: SlashMenuProps) {
  if (status === "memuat") {
    return (
      <div class="jk-dd-menu jk-slash-menu" role="listbox" id={id} aria-label="Perintah slash">
        <Note>Memuat perintah…</Note>
      </div>
    );
  }

  if (status === "gagal") {
    return (
      <div class="jk-dd-menu jk-slash-menu" role="listbox" id={id} aria-label="Perintah slash">
        <Note>Perintah tak dapat dimuat.</Note>
      </div>
    );
  }

  if (commands.length === 0) {
    return (
      <div class="jk-dd-menu jk-slash-menu" role="listbox" id={id} aria-label="Perintah slash">
        <Note>Tak ada perintah cocok.</Note>
        {source === "bawaan" && <Note>Daftar bawaan</Note>}
      </div>
    );
  }

  return (
    <div class="jk-dd-menu jk-slash-menu" role="listbox" id={id} aria-label="Perintah slash">
      {commands.map((command, index) => (
        <button
          type="button"
          role="option"
          key={command.name}
          id={`${id}-opsi-${index}`}
          class={`jk-dd-item${index === activeIndex ? " jk-dd-item-active" : ""}`}
          aria-selected={index === activeIndex}
          tabIndex={-1}
          onClick={() => onPick(command)}
        >
          <span class="jk-slash-name">{`/${command.name}`}</span>
          {command.argumentHint !== "" && (
            <span class="jk-slash-hint">{command.argumentHint}</span>
          )}
          <span class="jk-slash-desc">{command.description}</span>
        </button>
      ))}
      {source === "bawaan" && <Note>Daftar bawaan</Note>}
    </div>
  );
}
