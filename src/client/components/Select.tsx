import type { JSX } from "preact";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  firstEnabledIndex,
  lastEnabledIndex,
  menuPlacement,
  nextEnabledIndex,
  typeAheadIndex,
  type MenuPosition,
  type SelectOption,
} from "../lib/select";
import { Icon } from "./Icon";

export type { SelectOption };

/** Lamanya ketik-huruf-awal dianggap satu kata (ms). */
const TYPE_AHEAD_MS = 600;

export interface SelectProps {
  /** Nilai terpilih sekarang. */
  value: string;
  /** Opsi yang bisa dipilih; nilai kosong sah (mis. "Tanpa cadangan"). */
  options: readonly SelectOption[];
  /** Dipanggil sekali saat opsi lain dipilih. */
  onChange: (value: string) => void;
  /** Id pemicu supaya `<label for>` tetap terhubung. */
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** Id yang menjelaskan pemicu (mis. pesan galat). */
  describedBy?: string;
  disabled?: boolean;
  /** Teks yang tampil bila nilai tak cocok opsi mana pun. */
  placeholder?: string;
  /** Tandai pemicu tak valid (aria-invalid + gaya galat). */
  invalid?: boolean;
  /** Kelas tambahan untuk pemicu. */
  class?: string;
  /** Ukuran pemicu: normal (36px) atau compact (28px). */
  size?: "normal" | "compact";
  /** Sisi menu yang menempel pada pemicu. */
  align?: "start" | "end";
}

export interface SelectTriggerProps {
  id?: string;
  value: string;
  options: readonly SelectOption[];
  placeholder?: string;
  open: boolean;
  disabled?: boolean;
  invalid?: boolean;
  size?: "normal" | "compact";
  class?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  describedBy?: string;
  controlsId?: string;
  onToggle: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  triggerRef?: (element: HTMLButtonElement | null) => void;
}

/** Pemicu selector: bidang berbentuk tombol dengan chevron. */
export function SelectTrigger(props: SelectTriggerProps) {
  const {
    id,
    value,
    options,
    placeholder,
    open,
    disabled,
    invalid,
    size,
    class: className,
    ariaLabel,
    ariaLabelledBy,
    describedBy,
    controlsId,
    onToggle,
    onKeyDown,
    triggerRef,
  } = props;

  const terpilih = options.find((option) => option.value === value);
  const kosong = terpilih === undefined;
  const teks = terpilih?.label ?? (placeholder ?? value);
  const kelas = ["jk-select"];
  if (size === "compact") kelas.push("jk-select-compact");
  if (className !== undefined && className !== "") kelas.push(className);

  return (
    <button
      type="button"
      id={id}
      ref={triggerRef}
      class={kelas.join(" ")}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? controlsId : undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-invalid={invalid === true ? "true" : undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <span class={`jk-select-label${kosong ? " jk-select-placeholder" : ""}`}>{teks}</span>
      <span class="jk-select-chevron">
        <Icon name="chevron-down" />
      </span>
    </button>
  );
}

export interface SelectMenuProps {
  id: string;
  options: readonly SelectOption[];
  value: string;
  activeIndex: number;
  minWidth?: number;
  position?: MenuPosition;
  onPick: (value: string) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onHover: (index: number) => void;
  menuRef?: (element: HTMLDivElement | null) => void;
  itemRef?: (index: number, element: HTMLButtonElement | null) => void;
}

/** Menu pilihan: listbox dengan centang pada opsi terpilih. */
export function SelectMenu(props: SelectMenuProps) {
  const {
    id,
    options,
    value,
    activeIndex,
    minWidth,
    position,
    onPick,
    onKeyDown,
    onHover,
    menuRef,
    itemRef,
  } = props;

  const gaya: JSX.CSSProperties = {};
  if (minWidth !== undefined) gaya.minWidth = `${minWidth}px`;
  if (position !== undefined) {
    gaya.top = `${position.top}px`;
    gaya.left = `${position.left}px`;
    gaya.maxHeight = `${position.maxHeight}px`;
  }

  return (
    <div
      class="jk-dd-menu jk-select-menu"
      role="listbox"
      id={id}
      ref={menuRef}
      style={gaya}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => (
        <button
          type="button"
          role="option"
          key={option.value}
          id={`${id}-opsi-${index}`}
          ref={(element) => itemRef?.(index, element)}
          class={`jk-dd-item${index === activeIndex ? " jk-dd-item-active" : ""}`}
          aria-selected={option.value === value}
          aria-disabled={option.disabled === true ? "true" : undefined}
          tabIndex={-1}
          disabled={option.disabled}
          onClick={() => onPick(option.value)}
          onMouseEnter={() => onHover(index)}
        >
          <span class="jk-dd-label">{option.label}</span>
          {option.hint !== undefined && <span class="jk-dd-hint">{option.hint}</span>}
          <span class="jk-dd-check">{option.value === value && <Icon name="check" />}</span>
        </button>
      ))}
    </div>
  );
}

function posisiSama(a: MenuPosition, b: MenuPosition): boolean {
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.maxHeight === b.maxHeight &&
    a.minWidth === b.minWidth
  );
}

function bisaKetik(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 &&
    event.ctrlKey !== true &&
    event.metaKey !== true &&
    event.altKey !== true
  );
}

/**
 * Pemilih tunggal untuk seluruh Jejak.
 *
 * Menu memakai tampilan yang sama dengan `Dropdown` (kelas `jk-dd-*`), tapi
 * diposisikan tetap di dalam jendela: bila tak muat ke bawah, menu membuka
 * ke atas, dan bila tetap tak muat, isinya di-scroll.
 */
export function Select(props: SelectProps) {
  const {
    value,
    options,
    onChange,
    id,
    ariaLabel,
    ariaLabelledBy,
    describedBy,
    disabled,
    placeholder,
    invalid,
    class: className,
    size,
    align,
  } = props;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | undefined>(undefined);
  const [minWidth, setMinWidth] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef(new Map<number, HTMLButtonElement>());
  const typeAheadRef = useRef({ text: "", at: 0 });
  const baseId = useId();
  const menuId = `${baseId}-menu`;

  function indeksTerpilih(): number {
    const index = options.findIndex((option) => option.value === value);
    if (index >= 0 && options[index]?.disabled !== true) return index;
    return firstEnabledIndex(options);
  }

  function tutup(restoreFocus: boolean): void {
    setOpen(false);
    setPosition(undefined);
    setActiveIndex(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function buka(startIndex: number): void {
    const trigger = triggerRef.current;
    if (trigger !== null) setMinWidth(trigger.getBoundingClientRect().width);
    setOpen(true);
    setActiveIndex(startIndex);
  }

  function pilih(next: string): void {
    if (next !== value) onChange(next);
    tutup(true);
  }

  function queryTypeAhead(event: KeyboardEvent): string {
    const now = Date.now();
    const state = typeAheadRef.current;
    const text = now - state.at > TYPE_AHEAD_MS ? event.key : state.text + event.key;
    typeAheadRef.current = { text, at: now };
    return text;
  }

  function onTriggerKeyDown(event: KeyboardEvent): void {
    if (disabled === true) return;
    const key = event.key;
    if (key === "ArrowDown") {
      event.preventDefault();
      buka(indeksTerpilih());
      return;
    }
    if (key === "ArrowUp") {
      event.preventDefault();
      const start = indeksTerpilih();
      const sebelumnya = nextEnabledIndex(options, start, -1);
      buka(sebelumnya >= 0 ? sebelumnya : start);
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      buka(indeksTerpilih());
      return;
    }
    if (key === "Escape") {
      if (open) {
        event.preventDefault();
        tutup(true);
      }
      return;
    }
    if (bisaKetik(event)) {
      event.preventDefault();
      const index = typeAheadIndex(options, queryTypeAhead(event), activeIndex);
      if (index >= 0) {
        if (open) setActiveIndex(index);
        else buka(index);
      } else if (!open) {
        buka(indeksTerpilih());
      }
    }
  }

  function onMenuKeyDown(event: KeyboardEvent): void {
    const key = event.key;
    if (key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(nextEnabledIndex(options, activeIndex, 1));
      return;
    }
    if (key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(nextEnabledIndex(options, activeIndex, -1));
      return;
    }
    if (key === "Home") {
      event.preventDefault();
      setActiveIndex(firstEnabledIndex(options));
      return;
    }
    if (key === "End") {
      event.preventDefault();
      setActiveIndex(lastEnabledIndex(options));
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option !== undefined && option.disabled !== true) pilih(option.value);
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      tutup(true);
      return;
    }
    if (key === "Tab") {
      tutup(false);
      return;
    }
    if (bisaKetik(event)) {
      event.preventDefault();
      const index = typeAheadIndex(options, queryTypeAhead(event), activeIndex);
      if (index >= 0) setActiveIndex(index);
    }
  }

  // Klik di luar menutup menu.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: Event): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) === true) return;
      if (menuRef.current?.contains(target) === true) return;
      tutup(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  // Menu menempel pada pemicu; hitung ulang saat buka, resize, dan scroll.
  useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (trigger === null || menu === null) return;
      const rect = trigger.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const next = menuPlacement(
        { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom },
        viewport,
        menu.scrollHeight,
        menu.offsetWidth,
        align,
      );
      setPosition((current) =>
        current !== undefined && posisiSama(current, next) ? current : next,
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  // Fokus mengikuti opsi aktif di dalam menu.
  useLayoutEffect(() => {
    if (!open) return;
    itemsRef.current.get(activeIndex)?.focus();
  }, [open, activeIndex]);

  return (
    <>
      <SelectTrigger
        id={id}
        value={value}
        options={options}
        placeholder={placeholder}
        open={open}
        disabled={disabled}
        invalid={invalid}
        size={size}
        class={className}
        ariaLabel={ariaLabel}
        ariaLabelledBy={ariaLabelledBy}
        describedBy={describedBy}
        controlsId={menuId}
        onToggle={() => {
          if (disabled === true) return;
          if (open) tutup(false);
          else buka(indeksTerpilih());
        }}
        onKeyDown={onTriggerKeyDown}
        triggerRef={(element) => {
          triggerRef.current = element;
        }}
      />
      {open && (
        <SelectMenu
          id={menuId}
          options={options}
          value={value}
          activeIndex={activeIndex}
          minWidth={minWidth}
          position={position}
          onPick={pilih}
          onKeyDown={onMenuKeyDown}
          onHover={setActiveIndex}
          menuRef={(element) => {
            menuRef.current = element;
          }}
          itemRef={(index, element) => {
            if (element === null) itemsRef.current.delete(index);
            else itemsRef.current.set(index, element);
          }}
        />
      )}
    </>
  );
}
