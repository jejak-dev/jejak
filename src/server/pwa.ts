/**
 * Aset PWA: manifes web, ikon, dan service worker.
 *
 * Semua isi berkas ini statis dan tidak memuat rahasia. Aset ini disajikan
 * di luar `/api/`, jadi tetap terbuka walau autentikasi aktif; yang boleh
 * disimpan service worker hanyalah cangkang antarmuka, bukan data sesi.
 */

/** Warna latar terang (variabel `--bg` tema terang di styles.css). */
export const LIGHT_BG = "#faf9f6";

/** Warna latar gelap (variabel `--bg` tema gelap di styles.css). */
export const DARK_BG = "#1d1c1a";

/** Warna tinta ikon (variabel `--t1` tema terang). */
export const ICON_INK = "#1f1e1b";

export interface PwaIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

export interface PwaManifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: PwaIcon[];
}

/** Isi manifes web dalam bentuk objek. */
export const MANIFEST_DATA: PwaManifest = {
  name: "Jejak",
  short_name: "Jejak",
  description: "Workbench agent coding dengan memory lintas repo dan analisis dampak.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: LIGHT_BG,
  theme_color: LIGHT_BG,
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
  ],
};

/** Manifes web siap disajikan (JSON). */
export const MANIFEST = JSON.stringify(MANIFEST_DATA, null, 2);

/**
 * Jejak langkah sederhana, digambar sendiri sebagai vektor.
 * Tanpa fon eksternal, tanpa skrip, tanpa referensi jaringan.
 */
const FOOTPRINT = `<ellipse cx="256" cy="286" rx="62" ry="92" transform="rotate(-16 256 286)"/>
    <circle cx="206" cy="162" r="30"/>`;

/** Ikon biasa: latar transparan dengan sudut membulat. */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Jejak">
  <rect width="512" height="512" rx="112" fill="${LIGHT_BG}"/>
  <g fill="${ICON_INK}">
    ${FOOTPRINT}
  </g>
</svg>
`;

/**
 * Ikon maskable: latar penuh tanpa sudut, isi dikecilkan ke 60% (padding aman 20%).
 */
export const ICON_MASKABLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="Jejak">
  <rect width="512" height="512" fill="${LIGHT_BG}"/>
  <g fill="${ICON_INK}" transform="translate(256 256) scale(0.6) translate(-256 -256)">
    ${FOOTPRINT}
  </g>
</svg>
`;

/** Nama cache cangkang antarmuka. */
export const CACHE_NAME = "jejak-shell-v1";

/**
 * Penentu apakah sebuah request boleh ditangani service worker.
 *
 * Hanya GET, hanya same-origin, dan hanya cangkang antarmuka statis.
 * Data sesi (`/api/`) dan endpoint MCP tidak boleh tersimpan di perangkat:
 * isinya memuat cookie, kunci, dan hasil percakapan. Karena itu fungsi ini
 * juga ikut disalin ke dalam skrip service worker agar aturan tidak berbeda.
 */
export function shouldHandle(url: URL, selfOrigin: string = url.origin): boolean {
  const path = url.pathname;
  if (url.origin !== selfOrigin) return false;
  // Pengecualian eksplisit: data sesi dan MCP tidak pernah disentuh cache.
  const excluded = ["/api/", "/mcp"];
  for (const prefix of excluded) {
    if (path === prefix || path.startsWith(prefix)) return false;
  }
  // Skrip service worker sendiri tidak pernah diambil dari cache.
  if (path === "/sw.js") return false;
  if (path === "/") return true;
  if (path === "/app.js" || path === "/app.css") return true;
  if (path === "/manifest.webmanifest" || path === "/icon.svg") return true;
  // Chunk hasil code-splitting di akar, mis. /chunk-abc.js.
  return /^\/[A-Za-z0-9._-]+\.js$/.test(path);
}

/**
 * Skrip service worker.
 *
 * Sifat: network-first untuk cangkang antarmuka, lalu jatuh ke cache bila
 * jaringan gagal. Hanya salinan dengan `response.ok` yang disimpan, dan
 * hanya untuk path yang lolos `shouldHandle`, jadi `/api/` dan `/mcp`
 * tidak pernah tersimpan.
 */
export const SERVICE_WORKER = `// Service worker Jejak: hanya menyimpan cangkang antarmuka.
const CACHE_NAME = ${JSON.stringify(CACHE_NAME)};
const SHELL_URLS = ["/", "/app.js", "/app.css"];
// Pengecualian: data sesi dan endpoint MCP tidak boleh tersimpan di perangkat.
const EXCLUDED_PREFIXES = ["/api/", "/mcp"];

${shouldHandle.toString()}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("jejak-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  for (const prefix of EXCLUDED_PREFIXES) {
    if (url.pathname === prefix || url.pathname.startsWith(prefix)) return;
  }
  if (!shouldHandle(url, self.location.origin)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Hanya simpan salinan yang sukses; sisanya biarkan lewat saja.
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request)
          .then((hit) => hit ?? (request.mode === "navigate" ? caches.match("/") : undefined))
          .then(
            (hit) =>
              hit ??
              new Response("luring", {
                status: 503,
                headers: { "content-type": "text/plain; charset=utf-8" },
              }),
          ),
      ),
  );
});
`;
