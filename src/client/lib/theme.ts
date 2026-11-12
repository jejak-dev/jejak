/** Preferensi tema: ikut sistem, terang, atau gelap. */
export type ThemePref = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "jejak.theme";

const ORDER: ThemePref[] = ["system", "light", "dark"];

export function parseTheme(value: unknown): ThemePref {
  return value === "light" || value === "dark" ? value : "system";
}

/** Urutan putar tombol: Sistem -> Terang -> Gelap -> Sistem. */
export function nextTheme(current: ThemePref): ThemePref {
  const index = ORDER.indexOf(current);
  return ORDER[(index + 1) % ORDER.length] ?? "system";
}

export function themeLabel(pref: ThemePref): string {
  return pref === "light" ? "Terang" : pref === "dark" ? "Gelap" : "Sistem";
}

/** `data-theme` hanya dipasang untuk pilihan eksplisit; "system" mengikuti media query. */
export function themeAttribute(pref: ThemePref): string | undefined {
  return pref === "system" ? undefined : pref;
}

export function applyTheme(root: { setAttribute(n: string, v: string): void; removeAttribute(n: string): void }, pref: ThemePref): void {
  const attribute = themeAttribute(pref);
  if (attribute === undefined) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", attribute);
}

export function loadTheme(storage: Pick<Storage, "getItem"> | undefined): ThemePref {
  try {
    return parseTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/**
 * Tema gelap efektif: pilihan eksplisit (atribut `data-theme`) menang,
 * selain itu ikut media query sistem.
 */
export function isDarkTheme(
  root: Pick<Element, "getAttribute"> | undefined,
  media: Pick<MediaQueryList, "matches"> | undefined,
): boolean {
  const attribute = root?.getAttribute("data-theme") ?? null;
  if (attribute === "dark") return true;
  if (attribute === "light") return false;
  return media?.matches ?? false;
}

export function saveTheme(storage: Pick<Storage, "setItem"> | undefined, pref: ThemePref): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // penyimpanan diblokir: pilihan berlaku untuk sesi ini saja
  }
}
