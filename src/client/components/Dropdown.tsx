import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon";

export interface DropdownOption {
  value: string;
  label: string;
  /** Keterangan kecil di kanan (mis. nama provider). */
  hint?: string;
  danger?: boolean;
}

export interface DropdownSection {
  title?: string;
  options: DropdownOption[];
  /** Nilai terpilih bagian ini; diberi centang. */
  value?: string;
  onSelect: (value: string) => void;
}

export interface DropdownProps {
  /** Teks chip (nama pilihan sekarang). */
  label: string;
  /** Teks pudar di samping label chip. */
  detail?: string;
  title?: string;
  ariaLabel: string;
  sections: DropdownSection[];
  disabled?: boolean;
}

/** Menu pilihan ala Claude: chip yang membuka daftar dengan centang; tutup saat klik di luar atau Esc. */
export function Dropdown({ label, detail, title, ariaLabel, sections, disabled }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: Event): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div class="jk-dd" ref={rootRef}>
      <button
        type="button"
        class="jk-chip jk-chip-plain jk-dd-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        {detail !== undefined && detail !== "" && <span class="jk-dd-detail">{detail}</span>}
      </button>
      {open && (
        <div class="jk-dd-menu" role="menu" aria-label={ariaLabel}>
          {sections.map((section, index) => (
            <div class="jk-dd-section" key={section.title ?? index}>
              {section.title !== undefined && <div class="jk-dd-title">{section.title}</div>}
              {section.options.map((option) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.value === section.value}
                  class={`jk-dd-item${option.danger === true ? " jk-dd-danger" : ""}`}
                  key={option.value}
                  onClick={() => {
                    setOpen(false);
                    if (option.value !== section.value) section.onSelect(option.value);
                  }}
                >
                  <span class="jk-dd-label">{option.label}</span>
                  {option.hint !== undefined && <span class="jk-dd-hint">{option.hint}</span>}
                  <span class="jk-dd-check">
                    {option.value === section.value && <Icon name="check" />}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
