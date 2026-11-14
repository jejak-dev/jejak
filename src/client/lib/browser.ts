/** Batas jumlah tab browser yang boleh terbuka (sama dengan server). */
export const MAX_BROWSER_TABS = 8;

/** Panjang maksimum label tab di strip. */
const MAX_TAB_LABEL = 24;

/** Panjang maksimum teks bebas yang diterima dari server. */
const MAX_TEXT = 2000;

/** Panjang maksimum judul halaman. */
const MAX_TITLE = 300;

/** Panjang maksimum pesan dialog. */
const MAX_DIALOG = 200;

/** Satu tab browser di state server. */
export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  /** Tab ini tab aktif? */
  active: boolean;
  /** Halaman tab ini sedang dimuat? */
  loading: boolean;
}

/** Ukuran area tampilan halaman. */
export interface BrowserViewportInfo {
  width: number;
  height: number;
}

/** Catatan dialog JavaScript terakhir. */
export interface BrowserDialogInfo {
  type: string;
  message: string;
}

/** Keadaan browser yang dikirim server. */
export interface BrowserStateInfo {
  status: "mati" | "menyala";
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Semua tab yang terbuka (maksimal 8). */
  tabs: BrowserTabInfo[];
  /** Pengenal tab aktif. */
  activeId?: string;
  /** Tab aktif sedang memuat? */
  loading: boolean;
  /** Ukuran area tampilan halaman. */
  viewport: BrowserViewportInfo;
  /** Dialog JavaScript terakhir (hilang sendiri dari state). */
  lastDialog?: BrowserDialogInfo;
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

/** Potong string panjang; string bukan string dibuang. */
function cut(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

/** Baca daftar tab dari state server; tab rusak dibuang, jumlah dibatasi. */
function parseBrowserTabs(raw: unknown): BrowserTabInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: BrowserTabInfo[] = [];
  for (const item of raw) {
    if (out.length >= MAX_BROWSER_TABS) break;
    if (!isRecord(item)) continue;
    const id = cut(item.id, 200);
    if (id === "") continue;
    out.push({
      id,
      title: cut(item.title, MAX_TITLE),
      url: cut(item.url, MAX_TEXT),
      active: item.active === true,
      loading: item.loading === true,
    });
  }
  return out;
}

/** Baca ukuran tampilan; angka rusak menjadi 0. */
function parseBrowserViewport(raw: unknown): BrowserViewportInfo {
  if (!isRecord(raw)) return { width: 0, height: 0 };
  const size = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return { width: size(raw.width), height: size(raw.height) };
}

/** Baca catatan dialog; bentuk asing dibuang. */
function parseBrowserDialog(raw: unknown): BrowserDialogInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const type = cut(raw.type, 50);
  const message = cut(raw.message, MAX_DIALOG);
  if (type === "" && message === "") return undefined;
  return { type, message };
}

/** Baca state browser dari JSON server; bentuk asing ditolak. */
export function parseBrowserState(raw: unknown): BrowserStateInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const status = raw.status;
  if (status !== "mati" && status !== "menyala") return undefined;
  const activeId = cut(raw.activeId, 200);
  return {
    status,
    url: cut(raw.url, MAX_TEXT),
    title: cut(raw.title, MAX_TITLE),
    canGoBack: raw.canGoBack === true,
    canGoForward: raw.canGoForward === true,
    tabs: parseBrowserTabs(raw.tabs),
    activeId: activeId === "" ? undefined : activeId,
    loading: raw.loading === true,
    viewport: parseBrowserViewport(raw.viewport),
    lastDialog: parseBrowserDialog(raw.lastDialog),
  };
}

/** Tab aktif dari state (berdasarkan activeId, lalu penanda active). */
export function activeTab(state: BrowserStateInfo | undefined): BrowserTabInfo | undefined {
  if (state === undefined) return undefined;
  if (state.activeId !== undefined) {
    const found = state.tabs.find((tab) => tab.id === state.activeId);
    if (found !== undefined) return found;
  }
  return state.tabs.find((tab) => tab.active);
}

/** Host dari URL; string bukan URL menghasilkan kosong. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Label tab: judul, atau host URL, atau "Tab baru".
 * Label dipotong 24 karakter agar strip tab tetap rapat.
 */
export function tabLabel(tab: BrowserTabInfo | undefined): string {
  if (tab === undefined) return "Tab baru";
  const judul = tab.title.trim();
  const dasar = judul !== "" ? judul : hostOf(tab.url);
  const teks = dasar !== "" ? dasar : "Tab baru";
  return teks.length > MAX_TAB_LABEL ? `${teks.slice(0, MAX_TAB_LABEL - 1)}…` : teks;
}

/** Catatan dialog untuk ditampilkan sebaris. */
export function dialogLabel(dialog: BrowserDialogInfo | undefined): string {
  if (dialog === undefined) return "";
  if (dialog.message === "") return `Halaman menampilkan dialog: ${dialog.type}`;
  if (dialog.type === "") return `Halaman menampilkan dialog: ${dialog.message}`;
  return `Halaman menampilkan dialog: ${dialog.message} (${dialog.type})`;
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
  if (status === 429) return `Batas ${MAX_BROWSER_TABS} tab browser terlampaui.`;
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

/** Ringkasan state yang menyebut keadaan memuat. */
export function statusLabel(state: BrowserStateInfo | undefined): string {
  if (state === undefined) return "";
  if (state.status === "mati") return "Browser mati";
  if (state.loading) return "Memuat…";
  if (state.title !== "") return state.title;
  return state.url;
}

/* ---------- Aksi browser ---------- */

/** Hasil satu aksi browser: state terbaru atau pesan galat. */
export interface BrowserActionResult {
  /** Aksi berhasil? */
  ok: boolean;
  /** State terbaru dari server (bila ada). */
  state?: BrowserStateInfo;
  /** Pesan galat Bahasa Indonesia (bila gagal). */
  error?: string;
  /** Status HTTP terakhir (bila ada). */
  status?: number;
}

/** Header JSON untuk semua permintaan browser. */
const JSON_HEADERS: Record<string, string> = { "content-type": "application/json" };

/** Baca pesan galat dari body JSON server. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data: unknown = await response.json();
    if (isRecord(data) && typeof data.error === "string") return data.error;
  } catch {
    // Respons tanpa JSON; pesan bawaan dipakai.
  }
  return "";
}

/** Satu permintaan ke rute browser; mengembalikan state atau galat. */
async function browserRequest(
  path: string,
  init: { method: "POST" | "DELETE"; body?: unknown },
  fetchImpl: typeof fetch,
  bacaState: boolean,
): Promise<BrowserActionResult> {
  try {
    const response = await fetchImpl(path, {
      method: init.method,
      headers: { ...JSON_HEADERS },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      const message = await readErrorMessage(response);
      return {
        ok: false,
        status: response.status,
        error: browserErrorText(response.status, message),
      };
    }
    if (!bacaState) return { ok: true, status: response.status };
    const parsed = parseBrowserState(await response.json());
    if (parsed === undefined) {
      return {
        ok: false,
        status: response.status,
        error: "Respons browser tidak dikenali.",
      };
    }
    return { ok: true, status: response.status, state: parsed };
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error ? caught.message : "Permintaan gagal.",
    };
  }
}

/** Buka alamat di tab aktif. */
export function browserNavigate(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserActionResult> {
  return browserRequest(
    "/api/browser/navigate",
    { method: "POST", body: { url } },
    fetchImpl,
    true,
  );
}

/** Buat tab baru (tanpa URL bila tidak diberi). */
export function browserNewTab(
  url: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserActionResult> {
  return browserRequest(
    "/api/browser/tabs",
    { method: "POST", body: url === undefined ? {} : { url } },
    fetchImpl,
    true,
  );
}

/** Aktifkan tab. */
export function browserActivateTab(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserActionResult> {
  return browserRequest(
    `/api/browser/tabs/${encodeURIComponent(id)}/activate`,
    { method: "POST" },
    fetchImpl,
    true,
  );
}

/** Tutup tab. */
export function browserCloseTab(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserActionResult> {
  return browserRequest(
    `/api/browser/tabs/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    fetchImpl,
    true,
  );
}

/** Mundur satu halaman. */
export function browserBack(fetchImpl: typeof fetch = fetch): Promise<BrowserActionResult> {
  return browserRequest("/api/browser/back", { method: "POST" }, fetchImpl, true);
}

/** Maju satu halaman. */
export function browserForward(fetchImpl: typeof fetch = fetch): Promise<BrowserActionResult> {
  return browserRequest("/api/browser/forward", { method: "POST" }, fetchImpl, true);
}

/** Muat ulang halaman. */
export function browserReload(fetchImpl: typeof fetch = fetch): Promise<BrowserActionResult> {
  return browserRequest("/api/browser/reload", { method: "POST" }, fetchImpl, true);
}

/** Hentikan pemuatan halaman. */
export function browserStop(fetchImpl: typeof fetch = fetch): Promise<BrowserActionResult> {
  return browserRequest("/api/browser/stop", { method: "POST" }, fetchImpl, true);
}

/** Tutup browser seluruhnya. */
export function browserClose(fetchImpl: typeof fetch = fetch): Promise<BrowserActionResult> {
  return browserRequest("/api/browser", { method: "DELETE", body: {} }, fetchImpl, false);
}
