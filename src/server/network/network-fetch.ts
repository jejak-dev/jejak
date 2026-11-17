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
import { isLoopbackHostname, isValidIpAddress } from "./network-host";

/** Header penanda listener (bukan nilai klien). */
export const VIA_HEADER = "x-jejak-via";
/** Header alamat socket klien. */
export const PEER_HEADER = "x-jejak-peer";
/** Header penanda permintaan tiba lewat HTTPS (diisi server, bukan klien). */
export const SECURE_HEADER = "x-jejak-secure";
/** Header IP klien dari Cloudflare; hanya dipercaya dari peer loopback. */
export const CF_CONNECTING_IP_HEADER = "cf-connecting-ip";
/** Header skema asli dari proksi; hanya dipercaya dari peer loopback. */
export const FORWARDED_PROTO_HEADER = "x-forwarded-proto";
/** Header skema kunjungan Cloudflare; hanya dipercaya dari peer loopback. */
export const CF_VISITOR_HEADER = "cf-visitor";
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
  headers.delete(SECURE_HEADER);
  // Header proksi hanya boleh diisi server sendiri (lihat `networkFetch`).
  headers.delete(CF_CONNECTING_IP_HEADER);
  headers.delete(FORWARDED_PROTO_HEADER);
  headers.delete(CF_VISITOR_HEADER);
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

/** Opsi pembungkus listener jaringan. */
export interface NetworkFetchOptions {
  /** Hostname publik tunnel; hanya host ini yang boleh memakai header proksi. */
  publicHost?: () => string | undefined;
}

/** True bila nilai `cf-visitor` menyatakan skema https. */
function cfVisitorIsHttps(value: string | null): boolean {
  if (value === null) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return false;
    return (parsed as { scheme?: unknown }).scheme === "https";
  } catch {
    return false;
  }
}

/**
 * Pembungkus listener jaringan. Menolak path `/__desktop/` dengan 404,
 * membuang header penanda dari klien, lalu menyetel `x-jejak-via: net` dan
 * `x-jejak-peer` dari alamat socket.
 *
 * Di balik Cloudflare Tunnel semua permintaan datang dari socket loopback.
 * Hanya bila peer loopback DAN Host persis hostname publik tersimpan, header
 * `cf-connecting-ip` (IP sah) dipakai sebagai peer dan skema https dari
 * `x-forwarded-proto`/`cf-visitor` dipercaya. `x-forwarded-for` tak pernah
 * dipercaya.
 */
export function networkFetch(
  handle: AppHandler,
  peerOf: PeerResolver,
  options: NetworkFetchOptions = {},
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

    // Header proksi hanya dipercaya dari peer loopback pada host publik.
    const publik = options.publicHost?.()?.trim().toLowerCase();
    const host = (request.headers.get("host") ?? "").trim().toLowerCase();
    const hostname = host.startsWith("[")
      ? host.slice(0, host.indexOf("]") + 1)
      : (host.split(":")[0] ?? "");
    const dariLoopback = peer !== undefined && isLoopbackHostname(peer);
    if (publik !== undefined && publik !== "" && dariLoopback && hostname === publik) {
      const cfIp = request.headers.get(CF_CONNECTING_IP_HEADER)?.trim();
      if (cfIp !== undefined && cfIp !== "" && isValidIpAddress(cfIp)) {
        headers.set(PEER_HEADER, cfIp);
      }
      const proto = request.headers.get(FORWARDED_PROTO_HEADER)?.trim().toLowerCase();
      if (proto === "https" || cfVisitorIsHttps(request.headers.get(CF_VISITOR_HEADER))) {
        headers.set(SECURE_HEADER, "1");
      }
    }
    return handle(marked(request, headers));
  };
}
