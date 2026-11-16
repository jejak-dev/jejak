import { SETTINGS_SECTIONS, settingsHash, type SettingsSection } from "../lib/format";

export interface SettingsNavProps {
  /** Bagian yang sedang aktif. */
  section: SettingsSection;
}

/** Navigasi antarbagian halaman Pengaturan; tiap tautan memakai hash bagiannya. */
export function SettingsNav({ section }: SettingsNavProps) {
  return (
    <nav aria-label="Bagian pengaturan" class="jk-settings-nav">
      {SETTINGS_SECTIONS.map((item) => {
        const active = item.id === section;
        return (
          <a
            key={item.id}
            href={settingsHash(item.id)}
            class={`jk-settings-nav-link${active ? " jk-settings-nav-link-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
