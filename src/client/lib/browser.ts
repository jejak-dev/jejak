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

/** Panjang maksimum label aktivitas agent. */
const MAX_AGENT_ACTION = 60;

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

/** Aktivitas agent yang sedang berjalan di browser. */
export interface BrowserAgentInfo {
  /** Label aksi singkat (mis. "membuka alamat"); tanpa isi halaman. */
  action: string;
  /** Waktu pencatatan (ms). */
  at: number;
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
  /** Aktivitas agent terakhir (hilang sendiri dari state). */
  agent?: BrowserAgentInfo;
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

/** Baca catatan aktivitas agent; bentuk asing dibuang. */
function parseBrowserAgent(raw: unknown): BrowserAgentInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const action = cut(raw.action, MAX_AGENT_ACTION);
  const at = raw.at;
  if (action === "") return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return { action, at };
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
    agent: parseBrowserAgent(raw.agent),
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

/**
 * Label chip aktivitas agent.
 *
 * String kosong berarti tak ada aktivitas agent; chip lalu tak ditampilkan.
 */
export function agentChipLabel(agent: BrowserAgentInfo | undefined): string {
  if (agent === undefined) return "";
  const action = agent.action.trim();
  if (action === "") return "";
  return `Agent sedang ${action}`;
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

/** Ukuran kotak wadah area layar (px CSS). */
export interface BrowserBoxSize {
  width: number;
  height: number;
}

/**
 * Kotak gambar frame di dalam kanvas (piksel bitmap kanvas).
 *
 * Piksel bitmap = piksel CSS dikali rasio piksel layar, supaya gambar yang
 * digambar tetap tajam di layar Retina.
 */
export interface BrowserDrawRect {
  /** Offset gambar dari tepi kiri kanvas. */
  offsetX: number;
  /** Offset gambar dari tepi atas kanvas. */
  offsetY: number;
  /** Lebar gambar yang digambar. */
  width: number;
  /** Tinggi gambar yang digambar. */
  height: number;
}

/** Rencana gambar frame di dalam area layar. */
export interface BrowserRenderPlan {
  /** Ukuran tampilan yang diminta ke server (sudah diklem). */
  viewport: BrowserViewportInfo;
  /** Ukuran halaman yang dipetakan ke koordinat (px halaman). */
  page: BrowserViewportInfo;
  /** Rasio piksel layar yang dipakai saat rencana ini dibuat. */
  dpr: number;
  /** Kotak gambar frame di dalam kanvas (piksel bitmap). */
  draw: BrowserDrawRect;
}

/**
 * Rasio piksel layar yang aman.
 *
 * Nilai aneh (tak hingga, nol, negatif, atau tak ada) jadi 1.
 */
export function devicePixelRatioOf(dpr: number | undefined): number {
  if (dpr === undefined || !Number.isFinite(dpr) || dpr <= 0) return 1;
  return dpr;
}

/**
 * Ukuran bitmap kanvas dari ukuran area layar (piksel CSS).
 *
 * Bitmap kanvas memakai piksel CSS dikali rasio piksel layar supaya isi
 * kanvas tetap tajam di layar Retina. Ukuran tampil (CSS) kanvas tetap
 * mengikuti area layar.
 */
export function browserBitmapSize(
  box: BrowserBoxSize,
  dpr = 1,
): { width: number; height: number } {
  const rasio = devicePixelRatioOf(dpr);
  const lebar = box.width > 0 ? Math.round(box.width * rasio) : 1;
  const tinggi = box.height > 0 ? Math.round(box.height * rasio) : 1;
  return {
    width: Math.max(1, lebar),
    height: Math.max(1, tinggi),
  };
}

/**
 * Rencana gambar frame di dalam area layar.
 *
 * Ukuran tampilan sama dengan ukuran area layar (dibulatkan lalu diklem ke
 * batas server) sehingga halaman dirender 1:1 dan memenuhi seluruh area.
 * Bila klem server membuat tampilan lebih kecil dari area, gambar digambar
 * dengan skala `contain` dan terpusat (tak meregang); kotak gambarnya ikut
 * dipakai untuk memetakan koordinat klik.
 *
 * `dpr` adalah rasio piksel layar. Ukuran gambar dalam kanvas dihitung dalam
 * piksel bitmap (piksel CSS dikali `dpr`) supaya isi kanvas tetap tajam di
 * layar Retina; ukuran halaman tetap memakai piksel CSS halaman.
 */
export function browserRenderPlan(
  frame: { width: number; height: number },
  box: BrowserBoxSize,
  dpr = 1,
): BrowserRenderPlan {
  const rasio = devicePixelRatioOf(dpr);
  const viewport = clampViewportSize(box.width, box.height);
  const pageWidth = frame.width > 0 ? frame.width : viewport.width;
  const pageHeight = frame.height > 0 ? frame.height : viewport.height;
  const boxWidth = box.width > 0 ? box.width : pageWidth;
  const boxHeight = box.height > 0 ? box.height : pageHeight;
  // Skala contain: seluruh gambar muat di dalam area dan proporsinya terjaga.
  const skala = Math.min(
    pageWidth > 0 ? boxWidth / pageWidth : 1,
    pageHeight > 0 ? boxHeight / pageHeight : 1,
  );
  const width = Math.max(1, Math.round(pageWidth * skala));
  const height = Math.max(1, Math.round(pageHeight * skala));
  // Huruf (sisa ruang) dihitung dalam piksel CSS lalu dibulatkan.
  const offsetX = Math.round((boxWidth - width) / 2);
  const offsetY = Math.round((boxHeight - height) / 2);
  return {
    viewport,
    page: { width: pageWidth, height: pageHeight },
    dpr: rasio,
    draw: {
      // Piksel bitmap: ukuran CSS dikali rasio piksel layar. Nilai dikali
      // persis (tak dibulatkan) supaya kotak gambar bisa dikembalikan ke
      // piksel CSS tanpa selisih saat memetakan koordinat mouse.
      offsetX: offsetX * rasio,
      offsetY: offsetY * rasio,
      width: width * rasio,
      height: height * rasio,
    },
  };
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

/* ---------- Layar penuh ---------- */

/** Hasil percobaan masuk layar penuh. */
export type FullscreenOutcome = "berhasil" | "ditolak" | "takTersedia";

/** Jalur tombol layar penuh: layar penuh asli atau perbesaran jendela panel. */
export type FullscreenPath = "layarPenuh" | "perbesar";

/** Permukaan API layar penuh yang dipakai tab browser. */
export interface FullscreenApi {
  /** Meminta elemen jadi layar penuh. */
  requestFullscreen?: () => Promise<void>;
}

/**
 * Coba masuk layar penuh lalu laporkan hasilnya.
 *
 * API yang tak tersedia memberi "takTersedia"; permintaan yang ditolak
 * (mis. pane tertanam atau WKWebView) memberi "ditolak". Keduanya membuat
 * pemanggil jatuh ke jalur cadangan.
 */
export async function cobaLayarPenuh(
  api: FullscreenApi | undefined,
): Promise<FullscreenOutcome> {
  if (api === undefined || typeof api.requestFullscreen !== "function") return "takTersedia";
  try {
    await api.requestFullscreen();
    return "berhasil";
  } catch {
    return "ditolak";
  }
}

/**
 * Pilih jalur tombol layar penuh.
 *
 * Layar penuh asli hanya dipakai bila permintaannya berhasil; ditolak atau
 * tak tersedia membuat tombol memperbesar jendela panel.
 */
export function fullscreenPath(outcome: FullscreenOutcome): FullscreenPath {
  return outcome === "berhasil" ? "layarPenuh" : "perbesar";
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

/* ---------- Input browser ---------- */

/** Bitmask modifier CDP: alt=1, ctrl=2, meta=4, shift=8. */
export const MODIFIER_ALT = 1;
export const MODIFIER_CTRL = 2;
export const MODIFIER_META = 4;
export const MODIFIER_SHIFT = 8;

/** Tombol mouse yang dikenali server. */
export type BrowserMouseButton = "left" | "middle" | "right" | "none";

/** Jenis gerakan mouse. */
export type BrowserMouseType = "move" | "down" | "up" | "wheel";

/** Jenis event keyboard (tahan atau lepas). */
export type BrowserKeyType = "down" | "up";

/** Event mouse untuk tab aktif. */
export interface BrowserMouseEvent {
  kind: "mouse";
  type: BrowserMouseType;
  /** X dalam koordinat halaman (sudah diklem ke ukuran tampilan). */
  x: number;
  /** Y dalam koordinat halaman (sudah diklem ke ukuran tampilan). */
  y: number;
  button?: BrowserMouseButton;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  /** Bitmask modifier CDP. */
  modifiers: number;
}

/** Event keyboard untuk tab aktif. */
export interface BrowserKeyEvent {
  kind: "key";
  type: BrowserKeyType;
  key: string;
  code: string;
  /** Teks yang dicetak (hanya tombol cetak tunggal). */
  text?: string;
  /** Bitmask modifier CDP. */
  modifiers: number;
  /** Kode numerik tombol (untuk CDP). */
  keyCode: number;
}

/** Tempel teks (misalnya hasil IME atau Cmd/Ctrl+V). */
export interface BrowserTextEvent {
  kind: "text";
  text: string;
}

/** Seluruh bentuk event input yang dikirim ke server. */
export type BrowserInputEvent = BrowserMouseEvent | BrowserKeyEvent | BrowserTextEvent;

/** Kotak kanvas dalam piksel CSS (hasil getBoundingClientRect). */
export interface BrowserCanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Sumber event mouse (MouseEvent atau objek mirip). */
export interface BrowserMouseSource {
  clientX: number;
  clientY: number;
  /** 0 kiri, 1 tengah, 2 kanan. */
  button?: number;
  /** Bitmask tombol yang sedang ditekan. */
  buttons?: number;
  deltaX?: number;
  deltaY?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** Sumber event keyboard (KeyboardEvent atau objek mirip). */
export interface BrowserKeySource {
  type: string;
  key: string;
  code: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  keyCode?: number;
}

/**
 * Koordinat halaman dari koordinat CSS pada kanvas.
 *
 * Kanvas digambar mengikuti rasio frame, jadi piksel CSS kanvas tak selalu
 * sama dengan piksel halaman. Koordinat diskalakan ke ukuran tampilan lalu
 * dibulatkan dan diklem ke area tampilan. Bila gambar tak mengisi kanvas
 * seluruhnya (skala contain), `gambar` memberi kotak gambar supaya huruf di
 * tepi tak ikut dihitung sebagai koordinat halaman.
 *
 * `gambar` memakai piksel bitmap kanvas, jadi nilainya dibagi `dpr` dulu
 * supaya kembali ke piksel CSS. `dpr` harus sama dengan rasio yang dipakai
 * saat kanvas digambar (lihat `browserRenderPlan`).
 */
export function canvasToPage(
  clientX: number,
  clientY: number,
  rect: BrowserCanvasRect,
  viewport: BrowserViewportInfo,
  gambar?: BrowserDrawRect,
  dpr = 1,
): { x: number; y: number } {
  const rasio = devicePixelRatioOf(dpr);
  let offsetX = 0;
  let offsetY = 0;
  let lebar = 0;
  let tinggi = 0;
  if (gambar !== undefined && gambar.width > 0 && gambar.height > 0) {
    offsetX = gambar.offsetX / rasio;
    offsetY = gambar.offsetY / rasio;
    lebar = gambar.width / rasio;
    tinggi = gambar.height / rasio;
  }
  if (lebar <= 0) lebar = rect.width > 0 ? rect.width : viewport.width;
  if (tinggi <= 0) tinggi = rect.height > 0 ? rect.height : viewport.height;
  const skalaX = lebar > 0 ? viewport.width / lebar : 1;
  const skalaY = tinggi > 0 ? viewport.height / tinggi : 1;
  const x = Math.round((clientX - rect.left - offsetX) * skalaX);
  const y = Math.round((clientY - rect.top - offsetY) * skalaY);
  return {
    x: Math.min(viewport.width, Math.max(0, x)),
    y: Math.min(viewport.height, Math.max(0, y)),
  };
}

/** Bitmask modifier dari event (alt=1, ctrl=2, meta=4, shift=8). */
export function modifiersOf(event: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): number {
  let bitmask = 0;
  if (event.altKey === true) bitmask |= MODIFIER_ALT;
  if (event.ctrlKey === true) bitmask |= MODIFIER_CTRL;
  if (event.metaKey === true) bitmask |= MODIFIER_META;
  if (event.shiftKey === true) bitmask |= MODIFIER_SHIFT;
  return bitmask;
}

/** Tombol mouse dari sumber event; gerakan tanpa tombol ditekan berarti "none". */
function tombolDari(event: BrowserMouseSource, type: BrowserMouseType): BrowserMouseButton {
  if (type === "wheel") return "none";
  if (type === "move") {
    const buttons = event.buttons ?? 0;
    if ((buttons & 1) !== 0) return "left";
    if ((buttons & 4) !== 0) return "middle";
    if ((buttons & 2) !== 0) return "right";
    return "none";
  }
  const button = event.button ?? 0;
  if (button === 1) return "middle";
  if (button === 2) return "right";
  if (button === 0) return "left";
  return "none";
}

/**
 * Terjemahkan event keyboard menjadi event input server.
 *
 * Cmd/Ctrl+C dan Cmd/Ctrl+V tidak diteruskan sebagai tombol karena keduanya
 * ditangani Jejak (salin dan tempel). `undefined` berarti tak ada tombol yang
 * boleh dikirim.
 */
export function keyEventFrom(event: BrowserKeySource): BrowserKeyEvent | undefined {
  const type = event.type === "keydown" ? "down" : event.type === "keyup" ? "up" : undefined;
  if (type === undefined) return undefined;
  const key = event.key ?? "";
  const code = event.code ?? "";
  if (key === "" || code === "") return undefined;
  if (event.ctrlKey === true || event.metaKey === true) {
    const lower = key.toLowerCase();
    if (lower === "c" || lower === "v") return undefined;
  }
  const out: BrowserKeyEvent = {
    kind: "key",
    type,
    key,
    code,
    modifiers: modifiersOf(event),
    keyCode: typeof event.keyCode === "number" ? event.keyCode : 0,
  };
  // Teks hanya untuk tombol cetak tunggal; ctrl/meta berarti pintasan.
  if (type === "down" && key.length === 1 && event.ctrlKey !== true && event.metaKey !== true) {
    out.text = key;
  }
  return out;
}

/**
 * Terjemahkan event mouse menjadi event input server.
 *
 * Koordinat diubah ke koordinat halaman memakai kotak kanvas, ukuran
 * tampilan halaman, dan (bila ada) kotak gambar frame di dalam kanvas.
 * `dpr` adalah rasio piksel layar yang dipakai saat kanvas digambar.
 */
export function mouseEventFrom(
  type: BrowserMouseType,
  event: BrowserMouseSource,
  rect: BrowserCanvasRect,
  viewport: BrowserViewportInfo,
  clickCount?: number,
  gambar?: BrowserDrawRect,
  dpr = 1,
): BrowserMouseEvent {
  const point = canvasToPage(event.clientX, event.clientY, rect, viewport, gambar, dpr);
  const out: BrowserMouseEvent = {
    kind: "mouse",
    type,
    x: point.x,
    y: point.y,
    button: tombolDari(event, type),
    modifiers: modifiersOf(event),
  };
  if (clickCount !== undefined && clickCount > 0) out.clickCount = clickCount;
  if (type === "wheel") {
    out.deltaX = event.deltaX ?? 0;
    out.deltaY = event.deltaY ?? 0;
  }
  return out;
}

/** Event tempel teks; teks kosong diabaikan. */
export function textEvent(text: string): BrowserTextEvent | undefined {
  return text === "" ? undefined : { kind: "text", text };
}

/** Opsi batcher input browser. */
export interface InputBatcherOptions {
  /** Fungsi kirim satu batch event (tanpa awaited). */
  send: (events: BrowserInputEvent[]) => void;
  /** Sumber waktu (ms) untuk penghitung laju. */
  now?: () => number;
  /** Penjadwac tunda; mengembalikan fungsi pembatal. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  /** Jeda antar batch (ms). */
  intervalMs?: number;
  /** Batas event per batch. */
  maxBatch?: number;
  /** Batas event per detik. */
  maxPerSecond?: number;
}

/** Jeda antar batch (ms). */
const INPUT_INTERVAL_MS = 16;
/** Batas event per batch (sama dengan server). */
const INPUT_MAX_BATCH = 100;
/** Batas event per detik (sama dengan server). */
const INPUT_MAX_PER_SECOND = 200;

/** Penjadwac tunda bawaan. */
function jadwalBawaan(callback: () => void, delayMs: number): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

/** Apakah event ini gerakan mouse (boleh dibuang saat laju terlampaui)? */
function isMoveEvent(event: BrowserInputEvent): boolean {
  return event.kind === "mouse" && event.type === "move";
}

/**
 * Pengumpul event input browser.
 *
 * Event ditumpuk dan dikirim per batch (default 16 ms, maksimal 100 event).
 * Gerak mouse berturut-turut digabung menjadi satu (yang terakhir). Saat laju
 * 200 event/detik terlampaui, gerakan mouse dibuang lebih dulu; tombol dan
 * teks tak pernah dibuang.
 */
export class InputBatcher {
  private readonly kirim: (events: BrowserInputEvent[]) => void;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;
  private readonly intervalMs: number;
  private readonly maxBatch: number;
  private readonly maxPerSecond: number;
  private antrean: BrowserInputEvent[] = [];
  private waktuKirim: number[] = [];
  private batal: (() => void) | undefined;
  private berhenti = false;

  constructor(options: InputBatcherOptions) {
    this.kirim = options.send;
    this.now = options.now ?? ((): number => Date.now());
    this.schedule = options.schedule ?? jadwalBawaan;
    this.intervalMs = options.intervalMs ?? INPUT_INTERVAL_MS;
    this.maxBatch = options.maxBatch ?? INPUT_MAX_BATCH;
    this.maxPerSecond = options.maxPerSecond ?? INPUT_MAX_PER_SECOND;
  }

  /** Tambah satu event ke antrean. */
  push(event: BrowserInputEvent): void {
    if (this.berhenti) return;
    const terakhir = this.antrean[this.antrean.length - 1];
    if (terakhir !== undefined && isMoveEvent(terakhir) && isMoveEvent(event)) {
      // Gerak berturut-turut digabung; yang terakhir yang dipakai.
      this.antrean[this.antrean.length - 1] = event;
    } else {
      this.antrean.push(event);
    }
    this.jadwal();
  }

  /** Jumlah event yang menunggu dikirim. */
  get panjang(): number {
    return this.antrean.length;
  }

  /** Kirim semua antrean yang ada sekarang (batch maksimal 100 event). */
  flush(): void {
    if (this.berhenti) return;
    this.batal?.();
    this.batal = undefined;
    while (this.antrean.length > 0) {
      const batch = this.ambilBatch();
      if (batch.length === 0) break;
      this.kirim(batch);
    }
  }

  /** Buang antrean dan hentikan penjadwac. */
  dispose(): void {
    this.berhenti = true;
    this.batal?.();
    this.batal = undefined;
    this.antrean = [];
  }

  /** Jadwalkan tick berikutnya bila ada antrean. */
  private jadwal(): void {
    if (this.batal !== undefined || this.antrean.length === 0) return;
    this.batal = this.schedule(() => {
      this.batal = undefined;
      this.tick();
    }, this.intervalMs);
  }

  /** Satu tick: kirim satu batch lalu jadwalkan lagi bila masih ada sisa. */
  private tick(): void {
    if (this.berhenti) return;
    const batch = this.ambilBatch();
    if (batch.length > 0) this.kirim(batch);
    if (this.antrean.length > 0) this.jadwal();
  }

  /** Ambil batch berikutnya; buang gerakan mouse bila laju terlampaui. */
  private ambilBatch(): BrowserInputEvent[] {
    const diambil = this.antrean.splice(0, this.maxBatch);
    if (diambil.length === 0) return [];
    const sekarang = this.now();
    this.waktuKirim = this.waktuKirim.filter((waktu) => sekarang - waktu < 1000);
    const kelebihan = this.waktuKirim.length + diambil.length - this.maxPerSecond;
    let hasil = diambil;
    if (kelebihan > 0) {
      // Buang gerakan mouse terlama dulu; tombol dan teks tak pernah dibuang.
      const indeksGerak: number[] = [];
      diambil.forEach((event, index) => {
        if (isMoveEvent(event)) indeksGerak.push(index);
      });
      const buang = new Set(indeksGerak.slice(0, Math.min(kelebihan, indeksGerak.length)));
      hasil = diambil.filter((_, index) => !buang.has(index));
    }
    for (let index = 0; index < hasil.length; index += 1) this.waktuKirim.push(sekarang);
    return hasil;
  }
}

/** Clipboard pengguna (dipalsukan pada tes). */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/**
 * Salin teks pilihan halaman ke clipboard pengguna.
 *
 * Kegagalan diabaikan (galat tak boleh memuat isi halaman).
 */
export async function copySelectionToClipboard(
  fetchImpl: typeof fetch = fetch,
  clipboard: ClipboardLike | undefined = undefined,
): Promise<boolean> {
  const target =
    clipboard ??
    (typeof navigator === "undefined" ? undefined : (navigator.clipboard as ClipboardLike | undefined));
  try {
    const response = await fetchImpl("/api/browser/copy", {
      method: "POST",
      headers: { ...JSON_HEADERS },
    });
    if (!response.ok) return false;
    const data: unknown = await response.json();
    const text = isRecord(data) && typeof data.text === "string" ? data.text : "";
    if (text === "" || target === undefined) return false;
    await target.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kirim daftar event input ke server.
 *
 * Galat tak pernah memuat isi input; pemanggil cukup tahu berhasil atau tidak.
 */
export async function browserSendInput(
  events: BrowserInputEvent[],
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/browser/input", {
      method: "POST",
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ events }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Ubah ukuran tampilan halaman di server.
 *
 * Server menglem ukuran; pemanggil cukup tahu berhasil atau tidak.
 */
export async function browserSetViewport(
  width: number,
  height: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/browser/viewport", {
      method: "POST",
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ width, height }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Batas ukuran tampilan (sama dengan server). */
export const VIEWPORT_MIN_WIDTH = 320;
export const VIEWPORT_MAX_WIDTH = 1920;
export const VIEWPORT_MIN_HEIGHT = 240;
export const VIEWPORT_MAX_HEIGHT = 1200;

/**
 * Klem ukuran tampilan ke batas yang diizinkan server.
 *
 * Klem di sisi klien supaya ukuran yang dikirim sama dengan ukuran yang
 * dipakai server; koordinat klik tetap pas.
 */
export function clampViewportSize(width: number, height: number): BrowserViewportInfo {
  const w = Math.min(VIEWPORT_MAX_WIDTH, Math.max(VIEWPORT_MIN_WIDTH, Math.round(width)));
  const h = Math.min(VIEWPORT_MAX_HEIGHT, Math.max(VIEWPORT_MIN_HEIGHT, Math.round(height)));
  return { width: w, height: h };
}
