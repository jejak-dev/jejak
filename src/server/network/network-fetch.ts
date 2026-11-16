/**
 * Pembungkus `fetch` untuk listener Jejak.
 *
 * Dua aturan yang dipegang di sini:
 * 1. Header penanda tak boleh datang dari klien. Klien bisa memalsukan
 *    `x-jejak-via`/`x-jejak-peer`; kedua listener membuangnya lebih dulu dan
 *    listener jaringan baru menulisnya sendiri dari alamat socket.
 * 2. Listener jaringan tak boleh melayani jalur desktop: token masuk sekali
 *    pakai harus tak terjangkau dari jaringan.
 */

/** Header penanda listener (bukan nilai klien). */
export const VIA_HEADER = "x-jejak-via";
/** Header alamat socket klien. */
export const PEER_HEADER = "x-jejak-peer";
/** Nilai `x-jejak-via` untuk permintaan dari listener jaringan. */
export const VIA_NETWORK = "net";
/** Awalan path yang tak boleh terjangkau dari jaringan. */
export const DESKTOP_PATH_PREFIX = "/__desktop/";

/** Peladen yang bisa memberi alamat socket klien. */
export interface SocketLike {
  requestIP?(request: Request): { address: string } | null;
}

/** Ambil alamat socket klien; `undefined` bila tak diketahui. */
export type PeerResolver = (
  request: Request,
  server: SocketLike | undefined,
) => string | undefined;

/** Penangan permintaan aplikasi Jejak. */
export type AppHandler = (request: Request) => Response | Promise<Response>;

/** Salin header permintaan lalu buang header penanda dari klien. */
function cleanHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete(VIA_HEADER);
  headers.delete(PEER_HEADER);
  return headers;
}

/**Buat permintaan baru dengan header yang sudah dibersihkan dan ditandai. */
function marked(
  request: Request,
  headers: Headers,
): Request {
  return new Request(request, { headers });
}

/**
 * Pembungkus listener utama (loopback). Header penanda dari klien dibuang
 * dan `x-jejak-peer` diisi dari socket sendiri. `x-jejak-via` tak pernah
 * disetel di sini: hanya listener jaringan yang boleh menandai dirinya.
 */
export function mainFetch(
  handle: AppHandler,
  peerOf: PeerResolver,
): (request: Request, server: SocketLike | undefined) => Promise<Response> {
  return async (request, server) => {
    const headers = cleanHeaders(request);
    const peer = peerOf(request, server);
    if (peer !== undefined && peer !== "") headers.set(PEER_HEADER, peer);
    return handle(marked(request, headers));
  };
}

/**
 * Pembungkus listener jaringan. Menolak path `/__desktop/` dengan 404,
 * membuang header penanda dari klien, lalu menyetel `x-jejak-via: net` dan
 * `x-jejak-peer` dari alamat socket.
 */
export function networkFetch(
  handle: AppHandler,
  peerOf: PeerResolver,
): (request: Request, server: SocketLike | undefined) => Promise<Response> {
  return async (request, server) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith(DESKTOP_PATH_PREFIX)) {
      return new Response(JSON.stringify({ error: "tidak ditemukan" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const headers = cleanHeaders(request);
    headers.set(VIA_HEADER, VIA_NETWORK);
    const peer = peerOf(request, server);
    if (peer !== undefined && peer !== "") headers.set(PEER_HEADER, peer);
    return handle(marked(request, headers));
  };
}
