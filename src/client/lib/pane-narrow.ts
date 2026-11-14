import { useEffect, useState } from "preact/hooks";

/**
 * Kueri layar yang sama dengan breakpoint panel overlay pada `styles.css`
 * (`@media (max-width: 959px)`).
 */
export const NARROW_VIEWPORT_QUERY = "(max-width: 959px)";

/**
 * Apakah layar sedang sempit. Bila `matchMedia` tidak tersedia (lingkungan uji
 * tanpa DOM), layar dianggap lebar.
 */
export function isNarrowViewport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
}

/**
 * Ikuti perubahan lebar layar. Nilai awal diambil sekali supaya tampilan
 * sempit langsung berlaku sejak render pertama.
 */
export function useNarrowViewport(): boolean {
  const [sempit, setSempit] = useState(isNarrowViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const kueri = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const onChange = (): void => setSempit(kueri.matches);
    onChange();
    kueri.addEventListener("change", onChange);
    return () => {
      kueri.removeEventListener("change", onChange);
    };
  }, []);

  return sempit;
}
