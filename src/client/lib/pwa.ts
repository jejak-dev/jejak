/**
 * Pendaftaran service worker untuk mode aplikasi (PWA).
 *
 * Modul ini sengaja kecil dan murni: tidak menyentuh DOM dan tidak melempar
 * galat, sehingga aman dipanggil di server (SSR) maupun di browser.
 */

/** Lokasi skrip service worker. */
export const SERVICE_WORKER_PATH = "/sw.js";

export interface ServiceWorkerContainerLike {
  register(path: string): Promise<unknown>;
}

export interface NavigatorLike {
  serviceWorker?: ServiceWorkerContainerLike;
}

export interface WindowLike {
  addEventListener(type: string, listener: () => void): void;
  location?: { search?: string };
}

function report(error: unknown): void {
  try {
    console.debug("gagal mendaftar service worker", error);
  } catch {
    // Diamkan: pasting ke console tidak boleh menggagalkan halaman.
  }
}

/** `?nosw=1` mematikan pendaftaran (dipakai saat menelusuri cache). */
export function isServiceWorkerDisabled(win: WindowLike | undefined): boolean {
  const search = win?.location?.search;
  if (search === undefined || search === "") return false;
  try {
    return new URLSearchParams(search).get("nosw") === "1";
  } catch {
    return false;
  }
}

/**
 * Mendaftarkan service worker setelah halaman selesai dimuat.
 *
 * Tidak melempar galat apa pun: kegagalan pendaftaran hanya dicatat ke
 * console debug, sebab service worker hanyalah peningkatan.
 */
export function registerServiceWorker(
  nav: NavigatorLike | undefined =
    typeof navigator === "undefined" ? undefined : (navigator as NavigatorLike),
  win: WindowLike | undefined =
    typeof window === "undefined" ? undefined : (window as unknown as WindowLike),
): void {
  try {
    if (nav === undefined || !("serviceWorker" in nav)) return;
    if (isServiceWorkerDisabled(win)) return;
    const container = nav.serviceWorker;
    if (container === undefined) return;

    const start = (): void => {
      try {
        const result = container.register(SERVICE_WORKER_PATH);
        if (result !== undefined && typeof result.then === "function") {
          result.then(undefined, (error: unknown) => {
            report(error);
          });
        }
      } catch (error) {
        report(error);
      }
    };

    if (win === undefined) {
      start();
      return;
    }
    win.addEventListener("load", start);
  } catch (error) {
    report(error);
  }
}
