import { useEffect, useRef, useState } from "preact/hooks";
import {
  filterCommands,
  type Command,
  type CommandId,
} from "../lib/commands";
import { folderName } from "../lib/format";

export interface CommandPaletteProps {
  commands: readonly Command[];
  onRun: (run: CommandId | { session: string }) => void;
  onClose: () => void;
}

interface Row {
  command: Command;
  index: number;
}

function statusLabel(status: string | undefined): string | undefined {
  if (status === "berjalan") return "Berjalan";
  if (status === "gagal") return "Gagal";
  if (status === "dibatalkan") return "Dihentikan";
  if (status === "selesai") return "Selesai";
  return undefined;
}

export function CommandPalette({ commands, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const results = filterCommands(commands, query, commands.length);
  const rows: Row[] = results.map((command, index) => ({ command, index }));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Sorotan tidak boleh melewati hasil yang baru.
  useEffect(() => {
    setActive((current) => (current < results.length ? current : Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const row = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  // Pengaman: Escape menutup overlay meski fokus berada di luar dialog.
  useEffect(() => {
    const onDocKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.isComposing) onClose();
    };
    document.addEventListener("keydown", onDocKey);
    return () => document.removeEventListener("keydown", onDocKey);
  }, [onClose]);

  const run = (command: Command | undefined): void => {
    if (command === undefined) return;
    onClose();
    onRun(command.run);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      if (rows.length === 0) return;
      setActive((current) => (current + 1) % rows.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (rows.length === 0) return;
      setActive((current) => (current - 1 + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      run(rows[active]?.command);
      return;
    }
    if (event.key === "Tab") {
      // Jebakan fokus sederhana: hanya kolom ketik yang dapat difokus.
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div
      class="jk-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        class="jk-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Palette perintah"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          class="jk-palette-input"
          type="text"
          placeholder="Ketik perintah atau nama sesi…"
          aria-label="Ketik perintah"
          aria-controls="jk-palette-list"
          aria-activedescendant={
            rows[active] === undefined ? undefined : `jk-palette-row-${rows[active]!.index}`
          }
          value={query}
          onInput={(event) => {
            setQuery((event.currentTarget as HTMLInputElement).value);
            setActive(0);
          }}
        />

        <div class="jk-palette-list" id="jk-palette-list" role="listbox" ref={listRef} aria-label="Hasil">
          {rows.length === 0 ? (
            <p class="jk-palette-empty">Tidak ada hasil.</p>
          ) : (
            rows.map((row) => (
              <div
                key={row.command.id}
                id={`jk-palette-row-${row.index}`}
                data-index={row.index}
                role="option"
                aria-selected={row.index === active}
                class={`jk-palette-row${row.index === active ? " jk-palette-row-active" : ""}`}
                onPointerMove={() => setActive(row.index)}
                onPointerDown={(event) => {
                  event.preventDefault();
                  run(row.command);
                }}
              >
                <span class="jk-palette-label">{row.command.label}</span>
                {row.command.group === "sesi" && row.command.folder !== undefined && (
                  <span class="jk-palette-folder">{folderName(row.command.folder)}</span>
                )}
                {row.command.group === "sesi" && row.command.status !== undefined && (
                  <span class="jk-palette-status">{statusLabel(row.command.status)}</span>
                )}
                {row.command.hint !== undefined && (
                  <span class="jk-palette-hint">{row.command.hint}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
