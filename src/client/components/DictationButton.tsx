import { DICTATION_LANG_OPTIONS } from "../lib/dictation";
import type { DictationState } from "../lib/use-dictation";
import { Dropdown } from "./Dropdown";
import { Icon } from "./Icon";

export interface DictationButtonProps {
  /** Status dikte dari `useDictation`. */
  dict: DictationState;
}

const CONSENT_TEXT =
  "Dikte memakai pengenal suara peramban Anda. Di Chrome dan Safari audio dikirim ke " +
  "server Google/Apple. Jejak sendiri tidak menyimpan audio.";

/** Posisi kursor di kolom pesan; `undefined` bila kolom tidak ditemukan. */
function caretAt(element: Element | null): number | undefined {
  const form = element?.closest("form");
  const textarea = form?.querySelector("textarea");
  if (textarea === null || textarea === undefined) return undefined;
  const start = (textarea as HTMLTextAreaElement).selectionStart;
  return typeof start === "number" ? start : undefined;
}

/**
 * Tombol dikte di kolom pesan.
 *
 * Sengaja tanpa hook: status dikte datang dari `useDictation` sehingga
 * komponen ini bisa ditelusuri tes VNode tanpa DOM (pola `CopyButton`).
 */
export function DictationButton({ dict }: DictationButtonProps) {
  if (!dict.supported) return null;

  const onClick = (event: MouseEvent): void => {
    dict.toggle(caretAt(event.currentTarget as Element | null));
  };

  return (
    <div class="jk-dictation">
      {(dict.askingConsent || dict.note !== undefined) && (
        <div class="jk-dictation-pop">
          {dict.askingConsent && !dict.consented && (
            <div class="jk-dictation-consent" role="note">
              <p class="jk-dictation-text">{CONSENT_TEXT}</p>
              <div class="jk-dictation-actions">
                <button
                  type="button"
                  class="jk-button jk-button-primary"
                  onClick={() => dict.acceptConsent()}
                >
                  Mengerti, aktifkan
                </button>
                <button type="button" class="jk-link-btn" onClick={() => dict.cancelConsent()}>
                  Batal
                </button>
              </div>
            </div>
          )}
          {dict.note !== undefined && (
            <p class="jk-note jk-dictation-note" role="status">
              {dict.note}
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        class="jk-dictation-btn"
        aria-pressed={dict.active}
        aria-label={dict.active ? "Hentikan dikte" : "Mulai dikte"}
        title={dict.active ? "Hentikan dikte" : "Mulai dikte"}
        disabled={dict.disabled}
        onClick={onClick}
      >
        <Icon name={dict.active ? "mic-off" : "mic"} />
        {dict.active && <span class="jk-dictation-dot" aria-hidden="true" />}
      </button>

      <Dropdown
        label={dict.lang}
        ariaLabel="Bahasa dikte"
        title="Bahasa dikte"
        placement="up"
        align="end"
        disabled={dict.disabled}
        sections={[
          {
            options: DICTATION_LANG_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            })),
            value: dict.lang,
            onSelect: (value) => dict.changeLang(value),
          },
        ]}
      />
    </div>
  );
}
