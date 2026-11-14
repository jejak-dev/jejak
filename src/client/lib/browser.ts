/** Keadaan browser yang dikirim server. */
export interface BrowserStateInfo {
  status: "mati" | "menyala";
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Satu frame screencast (JPEG base64). */
export interface BrowserFrameInfo {
  data: string;
  width: number;
  height: number;
}

/** Peristiwa dari aliran SSE browser. */
export type BrowserStreamEvent =
  | { kind: "state"; state: BrowserStateInfo }
  | { kind: "frame"; frame: BrowserFrameInfo };

/** Pesan baku saat browser dimatikan lewat env. */
export const BROWSER_DISABLED_MESSAGE =
  "Browser dimatikan. Jalankan Jejak dengan JEJAK_BROWSER=1 untuk menyalakannya.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Baca state browser dari JSON server; bentuk asing ditolak. */
export function parseBrowserState(raw: unknown): BrowserStateInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const status = raw.status;
  if (status !== "mati" && status !== "menyala") return undefined;
  return {
    status,
    url: typeof raw.url === "string" ? raw.url : "",
    title: typeof raw.title === "string" ? raw.title : "",
    canGoBack: raw.canGoBack === true,
    canGoForward: raw.canGoForward === true,
  };
}

/** Baca frame screencast dari JSON server; bentuk asing ditolak. */
export function parseBrowserFrame(raw: unknown): BrowserFrameInfo | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.data !== "string" || raw.data === "") return undefined;
  return {
    data: raw.data,
    width: typeof raw.width === "number" ? raw.width : 0,
    height: typeof raw.height === "number" ? raw.height : 0,
  };
}

/**
 * Terjemahkan satu peristiwa SSE browser.
 * Peristiwa lain atau data rusak diabaikan (dikembalikan `undefined`).
 */
export function parseBrowserEvent(event: string, data: string): BrowserStreamEvent | undefined {
  if (event !== "state" && event !== "frame") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (event === "state") {
    const state = parseBrowserState(parsed);
    return state === undefined ? undefined : { kind: "state", state };
  }
  const frame = parseBrowserFrame(parsed);
  return frame === undefined ? undefined : { kind: "frame", frame };
}

/** URL gambar untuk `<img>`/`<canvas>` dari isi JPEG base64. */
export function browserFrameUrl(data: string): string {
  return `data:image/jpeg;base64,${data}`;
}

/**
 * Ukuran kanvas: lebar menyesuaikan panel, tinggi mengikuti rasio frame.
 * Bila panel punya batas tinggi, gambar diperkecil dengan rasio tetap.
 */
export function fitFrameSize(
  frame: { width: number; height: number },
  box: { width: number; height: number },
): { width: number; height: number } {
  const frameWidth = frame.width > 0 ? frame.width : 1280;
  const frameHeight = frame.height > 0 ? frame.height : 800;
  const boxWidth = box.width > 0 ? box.width : frameWidth;
  let width = Math.max(1, Math.round(boxWidth));
  let height = Math.max(1, Math.round((width * frameHeight) / frameWidth));
  if (box.height > 0 && height > box.height) {
    const scale = box.height / height;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(box.height));
  }
  return { width, height };
}

/** Normalisasi pesan galat dari server (Bahasa Indonesia). */
export function browserErrorText(
  status: number | undefined,
  message: string | undefined,
): string {
  if (status === 503) return BROWSER_DISABLED_MESSAGE;
  const trimmed = (message ?? "").trim();
  if (trimmed !== "") return trimmed;
  if (status === 404) return "Chrome atau Chromium tidak ditemukan.";
  if (status === 409) return "Browser sudah mati.";
  return "Permintaan gagal.";
}

/** Bentuk tampilan tab browser (murni, tanpa hook). */
export type BrowserViewKind = "mati" | "galat" | "menunggu" | "siap";

export interface BrowserView {
  kind: BrowserViewKind;
  /** Pesan yang ditampilkan ke pengguna. */
  pesan: string;
  /** Apakah kontrol URL ditampilkan. */
  kontrol: boolean;
}

export interface BrowserViewInput {
  /** Status HTTP terakhir; 503 berarti browser dimatikan. */
  status?: number;
  /** Pesan galat terakhir (bila ada). */
  message?: string;
  /** Sudah ada frame yang masuk? */
  adaFrame: boolean;
  /** State terakhir dari server. */
  state?: BrowserStateInfo;
}

/**
 * Bentuk tampilan tab browser.
 * - `mati`: server menjawab 503 (JEJAK_BROWSER tak disalakan);
 * - `galat`: ada pesan galat;
 * - `menunggu`: aliran berjalan tapi frame belum datang;
 * - `siap`: frame tersedia.
 */
export function browserView(input: BrowserViewInput): BrowserView {
  if (input.status === 503) {
    return { kind: "mati", pesan: BROWSER_DISABLED_MESSAGE, kontrol: false };
  }
  const message = (input.message ?? "").trim();
  if (message !== "") {
    return {
      kind: "galat",
      pesan: browserErrorText(input.status, message),
      kontrol: true,
    };
  }
  if (!input.adaFrame) {
    return { kind: "menunggu", pesan: "Menunggu frame pertama…", kontrol: true };
  }
  return { kind: "siap", pesan: "", kontrol: true };
}

/** Ringkasan state untuk baris status di bawah kanvas. */
export function browserStatusText(state: BrowserStateInfo | undefined): string {
  if (state === undefined) return "";
  if (state.status === "mati") return "Browser mati";
  if (state.title !== "") return state.title;
  return state.url;
}
