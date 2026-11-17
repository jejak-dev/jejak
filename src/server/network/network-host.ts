/**
 * Host yang boleh muncul pada listener jaringan: hanya IP privat, nama
 * `.local`/`.ts.net`, dan loopback untuk pendatang dari localhost.
 */
import { VIA_HEADER } from "./network-fetch";


/** Awalan nama host jaringan lokal (mdns/bonjour). */
const LOCAL_SUFFIX = ".local";
/** Awalan nama host Tailscale (MagicDNS). */
const TAILSCALE_SUFFIX = ".ts.net";

/** True bila host adalah loopback (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHostname(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === "localhost") return true;
  const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  return Number(parts[0]) === 127;
}

/** Ubah IPv4 menjadi empat byte; `undefined` bila bukan IPv4 sah. */
function ipv4Bytes(value: string): number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const byte = Number(part);
    if (byte > 255) return undefined;
    bytes.push(byte);
  }
  return bytes;
}

/** Ubah IPv6 (tanpa kurung) menjadi 16 byte; `undefined` bila tak sah. */
function ipv6Bytes(value: string): number[] | undefined {
  if (!/^[0-9a-f:.]+$/i.test(value)) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;

  const toWords = (text: string): number[] | undefined => {
    if (text === "") return [];
    const words: number[] = [];
    for (const group of text.split(":")) {
      if (group === "") return undefined;
      if (group.includes(".")) {
        const bytes = ipv4Bytes(group);
        if (bytes === undefined) return undefined;
        words.push((bytes[0] ?? 0) * 256 + (bytes[1] ?? 0));
        words.push((bytes[2] ?? 0) * 256 + (bytes[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      words.push(Number.parseInt(group, 16));
    }
    return words;
  };

  const head = toWords(halves[0] ?? "");
  if (head === undefined) return undefined;
  if (halves.length === 1) {
    if (head.length !== 8) return undefined;
    const bytes: number[] = [];
    for (const word of head) bytes.push(word >> 8, word & 0xff);
    return bytes;
  }
  const tail = toWords(halves[1] ?? "");
  if (tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  const words = [...head, ...new Array<number>(missing).fill(0), ...tail];
  if (words.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const word of words) bytes.push(word >> 8, word & 0xff);
  return bytes;
}

/** True bila alamat IPv4 berada di jaringan privat. */
function isPrivateIpv4(value: string): boolean {
  const bytes = ipv4Bytes(value);
  if (bytes === undefined) return false;
  const [a = 0, b = 0] = bytes;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // CGNAT Tailscale: 100.64.0.0/10.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** True bila alamat IPv6 berada di jaringan privat (link-local atau ULA). */
function isPrivateIpv6(value: string): boolean {
  const bytes = ipv6Bytes(value);
  if (bytes === undefined) return false;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  // fc00::/7 (ULA).
  if ((first & 0xfe) === 0xfc) return true;
  // fe80::/10 (link-local): byte pertama fe, dua bit atas byte kedua 10.
  if (first === 0xfe && (second & 0xc0) === 0x80) return true;
  return false;
}

/**
 * True bila nama host boleh dipakai pada listener jaringan: IP privat
 * (termasuk CGNAT Tailscale), IP loopback, atau nama `.local`/`.ts.net`.
 * IP publik dan nama lain tetap ditolak.
 */
export function isPrivateNetworkHostname(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  if (value === "") return false;
  if (value.endsWith(LOCAL_SUFFIX) || value.endsWith(TAILSCALE_SUFFIX)) return true;
  if (value.startsWith("[") && value.endsWith("]")) {
    return isPrivateIpv6(value.slice(1, -1));
  }
  if (isPrivateIpv4(value)) return true;
  if (value.includes(":")) return isPrivateIpv6(value);
  return false;
}

/** True bila nilai adalah alamat IP (IPv4 atau IPv6) yang sah. */
export function isValidIpAddress(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  const bare =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (ipv4Bytes(bare) !== undefined) return true;
  return ipv6Bytes(bare) !== undefined;
}

/**
 * True bila permintaan boleh dilayani penjaga Host/Origin lewat listener
 * jaringan: header penanda harus datang dari server sendiri dan host harus
 * privat atau persis sama dengan hostname publik tunnel tersimpan. Header tak
 * bisa dipalsukan klien karena pembungkus fetch membuangnya lebih dulu.
 */
export function isAllowedNetworkHost(
  hostname: string,
  request: Request,
  publicHost?: () => string | undefined,
): boolean {
  if (request.headers.get(VIA_HEADER) !== "net") return false;
  if (isPrivateNetworkHostname(hostname)) return true;
  const publik = publicHost?.()?.trim().toLowerCase();
  if (publik === undefined || publik === "") return false;
  return hostname.trim().toLowerCase() === publik;
}
