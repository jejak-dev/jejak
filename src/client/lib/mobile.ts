import { useEffect, useState } from "preact/hooks";

/**
 * Kueri layar ponsel. Batasnya sama dengan blok
 * `@media (max-width: 640px)` di akhir `styles.css`.
 */
export const MOBILE_QUERY = "(max-width: 640px)";

/**
 * Apakah layar sedang selebar ponsel. Bila `matchMedia` tidak tersedia
 * (lingkungan uji tanpa DOM), layar dianggap lebar.
 */
export function isMobile(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

/**
 * Ikuti perubahan lebar layar. Nilai awal diambil sekali supaya tampilan
 * ponsel langsung berlaku sejak render pertama.
 */
/** Layar yang tampil di ponsel; `desktop` berarti tata letak biasa. */
export type MobileScreen = "desktop" | "halaman" | "chat" | "sesi";

/**
 * Pilih layar ponsel: halaman lain (pengaturan, memory, dst.) menang atas
 * sesi, sesi terpilih berarti layar chat, sisanya layar daftar sesi.
 */
export function mobileScreen(input: {
  mobile: boolean;
  hasSession: boolean;
  hasPage: boolean;
}): MobileScreen {
  if (!input.mobile) return "desktop";
  if (input.hasPage) return "halaman";
  if (input.hasSession) return "chat";
  return "sesi";
}

/**
 * Urutan daftar sesi di ponsel: sesi yang menunggu izin lebih dulu, lalu
 * yang paling baru diperbarui (sama dengan urutan sidebar).
 */
export function sortMobileSessions<
  T extends { updatedAt: string; pendingPermissions: number },
>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => {
    const aMenunggu = a.pendingPermissions > 0 ? 1 : 0;
    const bMenunggu = b.pendingPermissions > 0 ? 1 : 0;
    if (aMenunggu !== bMenunggu) return bMenunggu - aMenunggu;
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });
}

export function useMobile(): boolean {
  const [ponsel, setPonsel] = useState(isMobile);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const kueri = window.matchMedia(MOBILE_QUERY);
    const onChange = (): void => setPonsel(kueri.matches);
    onChange();
    kueri.addEventListener("change", onChange);
    return () => {
      kueri.removeEventListener("change", onChange);
    };
  }, []);

  return ponsel;
}
