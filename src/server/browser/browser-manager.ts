import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserError } from "./browser-error";
import { locateChrome, type ChromeExists } from "./chrome-locator";
import { CdpClient, type CdpConnection } from "./cdp-client";
import { jejakHome } from "../provider-store";

export { BrowserError } from "./browser-error";
export type { BrowserErrorCode } from "./browser-error";

/** Status browser yang terlihat pengguna. */
export type BrowserStatus = "mati" | "menyala";

/** Satu tab halaman di browser. */
export interface BrowserTab {
  /** TargetId CDP; dipakai sebagai pengenal tab. */
  id: string;
  title: string;
  url: string;
  /** Tab ini tab aktif? */
  active: boolean;
  /** Halaman sedang dimuat? */
  loading: boolean;
}

/** Ukuran area tampilan halaman. */
export interface BrowserViewport {
  width: number;
  height: number;
}

/** Catatan dialog JavaScript terakhir (hilang setelah 5 detik). */
export interface BrowserDialogInfo {
  type: string;
  /** Pesan dialog, dibatasi 200 karakter. */
  message: string;
}

/**
 * Catatan aktivitas agent yang sedang berjalan (hilang setelah 4 detik).
 *
 * `action` hanya berisi label aksi singkat (mis. "membuka alamat"); isi
 * halaman dan teks yang diketik tak pernah masuk ke sini.
 */
export interface BrowserAgentActivity {
  /** Label aksi singkat; dibatasi 60 karakter. */
  action: string;
  /** Waktu pencatatan (ms). */
  at: number;
}

export interface BrowserState {
  status: BrowserStatus;
  /** Semua tab yang terbuka. */
  tabs: BrowserTab[];
  /** TargetId tab aktif. */
  activeId?: string;
  /** URL tab aktif. */
  url: string;
  /** Judul tab aktif. */
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Tab aktif sedang memuat? */
  loading: boolean;
  viewport: BrowserViewport;
  /** Dialog JavaScript terakhir (hilang dalam 5 detik). */
  lastDialog?: BrowserDialogInfo;
  /** Aktivitas agent terakhir (hilang dalam 4 detik). */
  agent?: BrowserAgentActivity;
}

/** Satu frame screencast (JPEG base64). */
export interface BrowserFrame {
  /** Isi JPEG dalam base64 (tanpa prefiks data URL). */
  data: string;
  width: number;
  height: number;
  ts: number;
}

/** Pendengar frame screencast. */
export type BrowserFrameListener = (frame: BrowserFrame) => void;

/** Pendeling perubahan state browser (dikirim lewat SSE). */
export type BrowserStateListener = (state: BrowserState) => void;

/** Tombol mouse yang dikenali. */
export type BrowserMouseButton = "left" | "middle" | "right" | "none";

/** Jenis gerakan mouse. */
export type BrowserMouseType = "move" | "down" | "up" | "wheel";

/** Event mouse untuk tab aktif. */
export interface BrowserMouseInput {
  kind: "mouse";
  type: BrowserMouseType;
  x: number;
  y: number;
  button?: BrowserMouseButton;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  /** Bitmask modifier CDP: alt=1, ctrl=2, meta=4, shift=8. */
  modifiers?: number;
}

/** Event keyboard untuk tab aktif. */
export interface BrowserKeyInput {
  kind: "key";
  type: "down" | "up";
  key: string;
  code: string;
  /** Teks yang dicetak (hanya untuk tombol yang bisa mengetik). */
  text?: string;
  /** Bitmask modifier CDP: alt=1, ctrl=2, meta=4, shift=8. */
  modifiers?: number;
  keyCode?: number;
}

/** Tempel teks panjang (misalnya hasil IME). */
export interface BrowserTextInput {
  kind: "text";
  text: string;
}

/** Satu elemen interaktif yang terlihat di halaman. */
export interface PageElement {
  /** Nomor acuan elemen (1..n) dari snapshot terakhir. */
  ref: number;
  /** Nama tag HTML (huruf kecil). */
  tag: string;
  /** Peran elemen (atribut `role` atau peran bawaan). */
  role?: string;
  /** Nama yang dilihat pengguna; sudah dipotong. */
  name: string;
  /** Jenis input (hanya untuk `input`). */
  type?: string;
  /** Isi input; tak pernah diisi untuk input kata sandi. */
  value?: string;
  /** Alamat tautan (hanya untuk `a[href]`). */
  href?: string;
  /** Titik tengah elemen dalam piksel viewport. */
  x: number;
  /** Titik tengah elemen dalam piksel viewport. */
  y: number;
  /** Elemen tak bisa dipakai? */
  disabled?: boolean;
}

/** Cuplikan halaman aktif untuk agent. */
export interface PageSnapshot {
  /** URL halaman. */
  url: string;
  /** Judul halaman. */
  title: string;
  /** Teks halaman; dipotong bila terlalu panjang. */
  text: string;
  /** Elemen interaktif yang terlihat di viewport. */
  elements: PageElement[];
}

/** Seluruh bentuk event input yang diterima. */
export type BrowserInputEvent = BrowserMouseInput | BrowserKeyInput | BrowserTextInput;

/** Proses Chrome yang dijalankan Jejak (bisa dipalsukan pada tes). */
export interface BrowserProcess {
  pid: number;
  kill(signal?: number | NodeJS.Signals): void;
  exited: Promise<number>;
}

/** Isi berkas `DevToolsActivePort`: port dan jalur WebSocket. */
export interface DevToolsEndpoint {
  port: number;
  path: string;
}

/** Pembaca baris perintah proses; undefined bila proses tak ada. */
export type ReadCommandLine = (pid: number) => string | undefined;

/** Pembunuh proses; tak ada yang ditunggu. */
export type KillProcess = (pid: number, signal?: number | NodeJS.Signals) => void;

/** Pemeriksa proses masih hidup. */
export type IsProcessAlive = (pid: number) => boolean;

export interface BrowserManagerOptions {
  /** Env; dipakai `JEJAK_CHROME_PATH` dan `JEJAK_HOME`. */
  env?: Record<string, string | undefined>;
  /** Platform untuk Pencarian Chrome; bawaan `process.platform`. */
  platform?: NodeJS.Platform;
  /** Pemeriksa keberadaan berkas; diinjeksi supaya bisa diuji. */
  exists?: ChromeExists;
  /** Peluncur proses Chrome; diinjeksi supaya bisa diuji. */
  spawn?: (command: string, args: string[]) => BrowserProcess;
  /** Penghubung CDP; diinjeksi supaya bisa diuji. */
  connect?: (wsUrl: string) => Promise<CdpConnection>;
  /** Pembaca port DevTools dari profil; diinjeksi supaya bisa diuji. */
  readDevToolsPort?: (profileDir: string) => DevToolsEndpoint | undefined;
  /** Sumber waktu (ms); diinjeksi supaya bisa diuji. */
  now?: () => number;
  /** Penjadwac tunda; diinjeksi supaya detak bisa dipicu manual pada tes. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  /** Lamanya halaman diam (ms) sebelum diambil screenshot lagi; bawaan 2 detik. */
  idleScreenshotMs?: number;
  /** Batas menunggu port DevTools (ms); bawaan 10 detik. */
  portTimeoutMs?: number;
  /** Batas menunggu proses Chrome keluar (ms); bawaan 3 detik. */
  closeTimeoutMs?: number;
  /** Pembaca baris perintah proses; diinjeksi agar bisa diuji. */
  readCommandLine?: ReadCommandLine;
  /** Pembunuh proses; diinjeksi agar bisa diuji. */
  killProcess?: KillProcess;
  /** Pemeriksa proses masih hidup; diinjeksi agar bisa diuji. */
  isProcessAlive?: IsProcessAlive;
  /** Nama berkas pid di dalam profil; bawaan `jejak-chrome.pid`. */
  pidFileName?: string;
  /** Umur catatan dialog di state (ms); bawaan 5 detik. */
  dialogTtlMs?: number;
  /** Umur catatan aktivitas agent di state (ms); bawaan 4 detik. */
  agentTtlMs?: number;
}

const DEFAULT_PORT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const PORT_POLL_MS = 100;
const DEFAULT_IDLE_SCREENSHOT_MS = 2_000;
const SCREENSHOT_QUALITY = 60;
const DEFAULT_PID_FILE_NAME = "jejak-chrome.pid";
const ORPHAN_POLL_MS = 100;

/** Batas jumlah tab yang boleh dibuka bersamaan. */
const MAX_TABS = 8;
/** Batas jumlah event input dalam satu permintaan. */
const MAX_INPUT_EVENTS = 100;
/** Batas laju input per detik (per manajer). */
const MAX_INPUT_RATE = 200;
/** Batas karakter teks tempel. */
const MAX_TEXT_CHARS = 10_000;
/** Batas karakter teks tombol. */
const MAX_KEY_TEXT_CHARS = 1_000;
/** Batas karakter nama/kode tombol. */
const MAX_KEY_NAME_CHARS = 64;
/** Batas karakter hasil salinan. */
const MAX_SELECTION_CHARS = 100_000;
/** Jeda sebelum state dikirim lewat SSE (ms). */
const STATE_DEBOUNCE_MS = 50;
/** Umur catatan dialog di state (ms). */
const DIALOG_TTL_MS = 5_000;
/** Umur catatan aktivitas agent di state (ms). */
const AGENT_TTL_MS = 4_000;
/** Batas panjang label aktivitas agent. */
const MAX_AGENT_ACTION_CHARS = 60;
/** Batas ukuran tampilan. */
const VIEWPORT_MIN_WIDTH = 320;
const VIEWPORT_MAX_WIDTH = 1920;
const VIEWPORT_MIN_HEIGHT = 240;
const VIEWPORT_MAX_HEIGHT = 1200;
/** Ukuran tampilan bawaan. */
const DEFAULT_VIEWPORT: BrowserViewport = { width: 1280, height: 800 };

/** Bawaan jumlah karakter teks pada snapshot. */
const DEFAULT_SNAPSHOT_CHARS = 12_000;
/** Batas atas jumlah karakter teks pada snapshot. */
const MAX_SNAPSHOT_CHARS = 30_000;
/** Batas jumlah elemen interaktif pada satu snapshot. */
const MAX_SNAPSHOT_ELEMENTS = 80;
/** Batas panjang nama elemen. */
const MAX_ELEMENT_NAME_CHARS = 80;
/** Batas panjang tautan elemen. */
const MAX_ELEMENT_HREF_CHARS = 200;
/** Batas panjang isi input pada snapshot. */
const MAX_ELEMENT_VALUE_CHARS = 200;
/** Batas panjang teks yang diketik lewat `typeRef`. */
const MAX_TYPE_REF_CHARS = 10_000;
/** Penanda teks yang dipotong. */
const POTONGAN_TANDAA = "[dipotong]";
/** Lama tenang halaman sebelum aksi dianggap selesai (ms). */
const ACTION_SETTLE_MS = 300;
/** Batas total tunggu halaman tenang (ms). */
const ACTION_TIMEOUT_MS = 1_500;
/** Batas tunggu navigasi (riwayat/muat ulang) selesai (ms). */
const NAVIGATION_TIMEOUT_MS = 3_000;
/** Jarak antar pemeriksaan status navigasi (ms). */
const NAVIGATION_POLL_MS = 50;
/** Jeda menunggu peristiwa "halaman mulai memuat" datang (ms). */
const NAVIGATION_GRACE_MS = 500;
/** Bawaan jarak gulir (piksel). */
const DEFAULT_SCROLL_PX = 600;
/** Batas atas jarak gulir (piksel). */
const MAX_SCROLL_PX = 5_000;
/** Batas bawah jarak gulir (piksel). */
const MIN_SCROLL_PX = 1;

/** Skema yang boleh dipakai untuk navigasi. */
const ALLOWED_SCHEMES = new Set(["http", "https"]);

/** Host yang dianggap lokal (dipakai `http://`, bukan `https://`). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Tombol mouse yang boleh dipakai. */
const MOUSE_BUTTONS = new Set<BrowserMouseButton>(["left", "middle", "right", "none"]);

/** Jenis gerakan mouse yang boleh dipakai. */
const MOUSE_TYPES = new Set<BrowserMouseType>(["move", "down", "up", "wheel"]);

/** Tombol yang tak mencetak teks (dikirim sebagai `rawKeyDown`). */
const CONTROL_KEYS = new Set([
  "Alt",
  "AltGraph",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "CapsLock",
  "ContextMenu",
  "Control",
  "Delete",
  "End",
  "Enter",
  "Escape",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "Home",
  "Insert",
  "Meta",
  "NumLock",
  "PageDown",
  "PageUp",
  "PrintScreen",
  "ScrollLock",
  "Shift",
  "Tab",
]);

function invalid(message: string): BrowserError {
  return new BrowserError(message, "tidak-valid");
}

/** Galat standar saat ref tak dikenal atau elemennya sudah hilang. */
function elemenTidakDitemukan(): BrowserError {
  return new BrowserError("Elemen tidak ditemukan; ambil snapshot baru.", "tidak-valid");
}

/** Ambil titik tengah dari hasil skrip aksi; undefined bila tak ada. */
function titikDari(
  hasil: Record<string, unknown> | undefined,
): { x: number; y: number } | undefined {
  if (hasil === undefined) return undefined;
  const x = hasil.x;
  const y = hasil.y;
  if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
  if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
  return { x, y };
}

/**
 * Skrip konstan snapshot halaman.
 *
 * Skrip ini TIDAK PERNAH menerima masukan dari agent atau pengguna: seluruh
 * parameter (batas karakter, batas elemen) dipangkas di sisi TypeScript.
 * Hasil halaman adalah data tak dipercaya; manajer tak menafsirkan isinya.
 */
export const SNAPSHOT_SCRIPT = `(function () {
  var PEMILIH = "a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable],[onclick]";
  var BATAS_ELEMEN = 80;
  var BATAS_TEKS = 60000;
  function potong(s, n) {
    if (s === undefined || s === null) return "";
    var t = String(s);
    var a = 0;
    var b = t.length;
    while (a < b && t.charCodeAt(a) <= 32) a += 1;
    while (b > a && t.charCodeAt(b - 1) <= 32) b -= 1;
    var isi = "";
    var spasi = false;
    for (var i = a; i < b; i += 1) {
      if (t.charCodeAt(i) <= 32) {
        if (!spasi) { isi += " "; spasi = true; }
      } else {
        isi += t.charAt(i);
        spasi = false;
      }
    }
    if (isi.length > n) isi = isi.slice(0, n);
    return isi;
  }
  function terlihat(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom <= 0 || r.right <= 0) return false;
    if (r.top >= window.innerHeight || r.left >= window.innerWidth) return false;
    var st = window.getComputedStyle(el);
    if (!st) return false;
    if (st.visibility === "hidden" || st.display === "none") return false;
    if (Number(st.opacity) === 0) return false;
    return true;
  }
  function peran(el, tag, tipe) {
    var dariAtribut = el.getAttribute("role");
    if (dariAtribut) return dariAtribut;
    if (tag === "a") return el.hasAttribute("href") ? "link" : "";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (tipe === "checkbox") return "checkbox";
      if (tipe === "radio") return "radio";
      if (tipe === "button" || tipe === "submit" || tipe === "reset") return "button";
      return "textbox";
    }
    return "";
  }
  var nodes = document.querySelectorAll(PEMILIH);
  var daftar = [];
  var refs = [];
  for (var i = 0; i < nodes.length && daftar.length < BATAS_ELEMEN; i += 1) {
    var el = nodes[i];
    if (!terlihat(el)) continue;
    var tag = String(el.tagName || "").toLowerCase();
    var tipe = tag === "input" ? String(el.getAttribute("type") || "text").toLowerCase() : "";
    var nama = el.getAttribute("aria-label");
    if (!nama) nama = el.getAttribute("placeholder");
    if (!nama) nama = el.getAttribute("alt");
    if (!nama) nama = el.getAttribute("title");
    if (!nama) nama = el.textContent;
    var item = { ref: daftar.length + 1, tag: tag, name: potong(nama, 80) };
    var per = peran(el, tag, tipe);
    if (per) item.role = per;
    if (tipe) item.type = tipe;
    if (tipe && tipe !== "password" && el.value !== undefined && el.value !== null && el.value !== "") {
      item.value = potong(el.value, 200);
    }
    if (tag === "a" && el.hasAttribute("href")) item.href = potong(el.href, 200);
    var kotak = el.getBoundingClientRect();
    item.x = Math.round(kotak.left + kotak.width / 2);
    item.y = Math.round(kotak.top + kotak.height / 2);
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    daftar.push(item);
    refs.push(el);
  }
  window.__jejakRefs = refs;
  window.__jejakSnapshot = daftar.length;
  var body = document.body;
  var teks = body && body.innerText ? String(body.innerText) : "";
  if (teks.length > BATAS_TEKS) teks = teks.slice(0, BATAS_TEKS);
  return { url: String(location.href), title: String(document.title), text: teks, elements: daftar };
})()`;

/**
 * Tubuh skrip konstan aksi berbasis elemen.
 *
 * Hanya dipakai lewat `ACTION_SCRIPT`; isian sebaris berisi nomor ref
 * (angka bulat yang sudah divalidasi), bukan teks bebas dari agent.
 */
export const ACTION_SCRIPT = `
  function ambilRef(ref) {
    var refs = window.__jejakRefs;
    if (!refs || typeof refs.length !== "number") return undefined;
    var el = refs[ref - 1];
    return el ? el : undefined;
  }
  function keAtas(el) {
    try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); return; } catch (e) {}
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
  }
  function titik(el) {
    var kotak = el.getBoundingClientRect();
    return { x: Math.round(kotak.left + kotak.width / 2), y: Math.round(kotak.top + kotak.height / 2) };
  }
  var __jejakAksi = {
    klik: function (ref) {
      var el = ambilRef(ref);
      if (!el) return null;
      keAtas(el);
      return titik(el);
    },
    fokus: function (ref) {
      var el = ambilRef(ref);
      if (!el) return null;
      keAtas(el);
      try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
      return titik(el);
    },
    pilih: function (ref) {
      var el = ambilRef(ref);
      if (!el) return null;
      try {
        if (typeof el.select === "function") {
          el.select();
        } else if (el.isContentEditable) {
          var pilihan = window.getSelection();
          if (pilihan) {
            var rentang = document.createRange();
            rentang.selectNodeContents(el);
            pilihan.removeAllRanges();
            pilihan.addRange(rentang);
          }
        }
      } catch (e) {}
      return { ok: true };
    }
  };
`;

/** Nama tombol yang boleh ditekan beserta kode dan nomor tombolnya. */
const TOMBOL_NAMA: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

/** Bentuk ekspresi skrip aksi: skrip konstan + nomor ref (angka bulat). */
function ekspresiAksi(aksi: "klik" | "fokus" | "pilih", ref: number): string {
  return `(function () {${ACTION_SCRIPT}
  return __jejakAksi.${aksi}(${ref});
})()`;
}

/** Terjemahkan nama tombol ke detail tombol; undefined bila tak diizinkan. */
function infoTombol(
  key: unknown,
): { key: string; code: string; keyCode: number; text?: string } | undefined {
  if (typeof key !== "string" || key === "") return undefined;
  const nama = TOMBOL_NAMA[key];
  if (nama !== undefined) return nama;
  if (/^[a-zA-Z]$/.test(key)) {
    const atas = key.toUpperCase();
    return { key, code: `Key${atas}`, keyCode: atas.charCodeAt(0), text: key };
  }
  if (/^[0-9]$/.test(key)) {
    return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  }
  return undefined;
}

/** Batas jumlah karakter teks pada snapshot. */
function batasSnapshotChars(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_SNAPSHOT_CHARS;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid("Batas karakter snapshot tidak valid.");
  }
  if (value < 0) throw invalid("Batas karakter snapshot tidak valid.");
  return Math.min(MAX_SNAPSHOT_CHARS, Math.max(1, Math.round(value)));
}

/** Batas jarak gulir dalam piksel. */
function batasGulir(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_SCROLL_PX;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid("Jumlah gulir tidak valid.");
  }
  return Math.min(MAX_SCROLL_PX, Math.max(MIN_SCROLL_PX, Math.round(value)));
}

/** Potong teks halaman dan beri penanda bila terpotong. */
function potongTeks(teks: string, maxChars: number): string {
  if (teks.length <= maxChars) return teks;
  const sisa = Math.max(0, maxChars - POTONGAN_TANDAA.length);
  return teks.slice(0, sisa) + POTONGAN_TANDAA;
}

/** Bentuk mentah hasil snapshot (belum dipangkas). */
interface SnapshotMentah {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
}

/**
 * Urai hasil snapshot; datanya tak dipercaya sehingga setiap field diperiksa.
 *
 * Isi input kata sandi dibuang di sini juga, bukan hanya di skrip halaman.
 */
function uraiSnapshot(nilai: unknown): SnapshotMentah {
  let data: unknown = nilai;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = undefined;
    }
  }
  if (typeof data !== "object" || data === null) {
    return { url: "", title: "", text: "", elements: [] };
  }
  const rec = data as Record<string, unknown>;
  const elements: PageElement[] = [];
  const daftar = Array.isArray(rec.elements) ? rec.elements : [];
  for (const item of daftar.slice(0, MAX_SNAPSHOT_ELEMENTS)) {
    const el = uraiElemen(item);
    if (el !== undefined) elements.push(el);
  }
  return {
    url: typeof rec.url === "string" ? rec.url : "",
    title: typeof rec.title === "string" ? rec.title : "",
    text: typeof rec.text === "string" ? rec.text : "",
    elements,
  };
}

/** Urai satu elemen snapshot; undefined bila tak berbentuk elemen. */
function uraiElemen(item: unknown): PageElement | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const rec = item as Record<string, unknown>;
  const ref = rec.ref;
  if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) return undefined;
  const el: PageElement = {
    ref,
    tag: typeof rec.tag === "string" ? rec.tag : "",
    name:
      typeof rec.name === "string" ? rec.name.slice(0, MAX_ELEMENT_NAME_CHARS) : "",
    x: 0,
    y: 0,
  };
  if (typeof rec.role === "string" && rec.role !== "") el.role = rec.role;
  const tipe = typeof rec.type === "string" ? rec.type : "";
  if (tipe !== "") el.type = tipe;
  // Isi input kata sandi tak pernah keluar dari manajer.
  if (tipe !== "password" && typeof rec.value === "string" && rec.value !== "") {
    el.value = rec.value.slice(0, MAX_ELEMENT_VALUE_CHARS);
  }
  if (typeof rec.href === "string" && rec.href !== "") {
    el.href = rec.href.slice(0, MAX_ELEMENT_HREF_CHARS);
  }
  if (typeof rec.x === "number" && Number.isFinite(rec.x)) el.x = Math.round(rec.x);
  if (typeof rec.y === "number" && Number.isFinite(rec.y)) el.y = Math.round(rec.y);
  if (rec.disabled === true) el.disabled = true;
  return el;
}

/** Nama host dari masukan tanpa skema (tanpa port). */
function hostNameOf(raw: string): string | undefined {
  let host = raw;
  const cut = host.search(/[/?#]/);
  if (cut >= 0) host = host.slice(0, cut);
  if (host === "") return undefined;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return undefined;
    return host.slice(0, end + 1).toLowerCase();
  }
  const colon = host.lastIndexOf(":");
  if (colon >= 0) {
    const port = host.slice(colon + 1);
    if (!/^\d+$/.test(port)) return undefined;
    host = host.slice(0, colon);
  }
  if (host === "") return undefined;
  return host.toLowerCase();
}

/** Apakah masukan tanpa skema terlihat seperti nama host? */
function looksLikeHost(raw: string): boolean {
  const host = hostNameOf(raw);
  if (host === undefined) return false;
  if (host.startsWith("[")) return host.endsWith("]");
  return /^[a-z0-9][a-z0-9.-]*$/.test(host);
}

/**
 * Normalisasi URL navigasi (fungsi murni).
 *
 * Hanya `http:`, `https:`, dan persis `about:blank` yang diterima.
 * Masukan tanpa skema yang terlihat seperti host mendapat `http://` untuk host
 * lokal dan `https://` untuk host lain.
 */
export function normalizeBrowserUrl(input: unknown): string {
  if (typeof input !== "string") throw invalid("URL harus berupa teks.");
  const raw = input.trim();
  if (raw === "") throw invalid("URL tidak boleh kosong.");
  if (raw === "about:blank") return raw;

  if (/^https?:\/\//i.test(raw)) {
    const parsed = new URL(raw);
    if (parsed.hostname === "") throw invalid("URL harus punya nama host.");
    return parsed.toString();
  }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (schemeMatch !== null) {
    const name = (schemeMatch[1] ?? "").toLowerCase();
    const rest = raw.slice(schemeMatch[0].length);
    // "localhost:3000" dan "host:8080" adalah host+port, bukan skema.
    if (!/^\d+(\/|$|\?|#)/.test(rest)) {
      if (!ALLOWED_SCHEMES.has(name)) {
        throw invalid(`Skema "${name}:" tidak diizinkan. Gunakan http: atau https:.`);
      }
      if (!rest.startsWith("//")) {
        throw invalid("URL harus diawali http:// atau https://.");
      }
      const parsed = new URL(raw);
      if (parsed.hostname === "") throw invalid("URL harus punya nama host.");
      return parsed.toString();
    }
  }

  if (!looksLikeHost(raw)) {
    throw invalid("URL harus berupa alamat http/https, misalnya https://example.com.");
  }
  const host = hostNameOf(raw) ?? "";
  const schemePrefix = LOCAL_HOSTS.has(host) ? "http" : "https";
  const parsed = new URL(`${schemePrefix}://${raw}`);
  if (parsed.hostname === "") throw invalid("URL harus punya nama host.");
  return parsed.toString();
}

/** Baca port dan jalur WebSocket dari berkas `DevToolsActivePort`. */
export function readDevToolsPortFile(profileDir: string): DevToolsEndpoint | undefined {
  try {
    const content = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8");
    const lines = content.split("\n");
    const port = Number.parseInt((lines[0] ?? "").trim(), 10);
    const path = (lines[1] ?? "").trim();
    if (!Number.isInteger(port) || port <= 0 || path === "") return undefined;
    return { port, path };
  } catch {
    return undefined;
  }
}

/** Argumen Chrome untuk profil terpisah milik Jejak. */
export function chromeArgs(profileDir: string): string[] {
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    "--window-size=1280,800",
    "about:blank",
  ];
}

/** Baca baris perintah proses lewat `ps`; undefined bila proses tak ada. */
export function readCommandLinePs(pid: number): string | undefined {
  try {
    const hasil = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (hasil.exitCode !== 0) return undefined;
    const isi = hasil.stdout.toString().trim();
    return isi === "" ? undefined : isi;
  } catch {
    return undefined;
  }
}

/** Kirim sinyal ke proses; diam-diam bila proses sudah hilang. */
export function killProcessById(pid: number, signal: number | NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Proses sudah berhenti atau tak diizinkan; abaikan.
  }
}

/** Periksa proses masih hidup lewat sinyal 0. */
export function isProcessAliveById(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Tolak field yang tak dikenal pada event input. */
function cekField(event: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(event)) {
    if (!allowed.includes(key)) throw invalid("Event input tidak valid.");
  }
}

/** Baca modifier (bitmask 0..15). */
function bacaModifier(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 15) {
    throw invalid("Modifier tidak valid.");
  }
  return value;
}

/** Validasi event mouse terhadap area tampilan. */
function validateMouse(
  event: Record<string, unknown>,
  viewport: BrowserViewport,
): BrowserMouseInput {
  cekField(event, [
    "kind",
    "type",
    "x",
    "y",
    "button",
    "clickCount",
    "deltaX",
    "deltaY",
    "modifiers",
  ]);
  const type = event.type;
  if (typeof type !== "string" || !MOUSE_TYPES.has(type as BrowserMouseType)) {
    throw invalid("Jenis event mouse tidak dikenal.");
  }
  const x = event.x;
  const y = event.y;
  if (typeof x !== "number" || !Number.isFinite(x)) throw invalid("Koordinat mouse tidak valid.");
  if (typeof y !== "number" || !Number.isFinite(y)) throw invalid("Koordinat mouse tidak valid.");
  if (x < 0 || x > viewport.width || y < 0 || y > viewport.height) {
    throw invalid("Koordinat mouse di luar area tampilan.");
  }
  const out: BrowserMouseInput = { kind: "mouse", type: type as BrowserMouseType, x, y };
  if (event.button !== undefined) {
    if (typeof event.button !== "string" || !MOUSE_BUTTONS.has(event.button as BrowserMouseButton)) {
      throw invalid("Tombol mouse tidak dikenal.");
    }
    out.button = event.button as BrowserMouseButton;
  }
  if (event.clickCount !== undefined) {
    const count = event.clickCount;
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > 10
    ) {
      throw invalid("Jumlah klik tidak valid.");
    }
    out.clickCount = count;
  }
  if (event.deltaX !== undefined || event.deltaY !== undefined) {
    if (type !== "wheel") throw invalid("Nilai gulir hanya sah untuk event wheel.");
    const dx = event.deltaX ?? 0;
    const dy = event.deltaY ?? 0;
    if (typeof dx !== "number" || !Number.isFinite(dx)) {
      throw invalid("Nilai gulir tidak valid.");
    }
    if (typeof dy !== "number" || !Number.isFinite(dy)) {
      throw invalid("Nilai gulir tidak valid.");
    }
    out.deltaX = dx;
    out.deltaY = dy;
  }
  const modifier = bacaModifier(event.modifiers);
  if (modifier !== undefined) out.modifiers = modifier;
  return out;
}

/** Validasi event keyboard. */
function validateKey(event: Record<string, unknown>): BrowserKeyInput {
  cekField(event, ["kind", "type", "key", "code", "text", "modifiers", "keyCode"]);
  const type = event.type;
  if (type !== "down" && type !== "up") throw invalid("Jenis event tombol tidak dikenal.");
  const key = event.key;
  const code = event.code;
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_NAME_CHARS) {
    throw invalid("Nama tombol tidak valid.");
  }
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_KEY_NAME_CHARS) {
    throw invalid("Kode tombol tidak valid.");
  }
  const out: BrowserKeyInput = { kind: "key", type, key, code };
  if (event.text !== undefined) {
    if (typeof event.text !== "string" || event.text.length > MAX_KEY_TEXT_CHARS) {
      throw invalid("Teks tombol tidak valid.");
    }
    out.text = event.text;
  }
  const modifier = bacaModifier(event.modifiers);
  if (modifier !== undefined) out.modifiers = modifier;
  if (event.keyCode !== undefined) {
    const keyCode = event.keyCode;
    if (
      typeof keyCode !== "number" ||
      !Number.isInteger(keyCode) ||
      keyCode < 0 ||
      keyCode > 0xffff
    ) {
      throw invalid("Kode numerik tombol tidak valid.");
    }
    out.keyCode = keyCode;
  }
  return out;
}

/** Validasi event tempel teks. */
function validateText(event: Record<string, unknown>): BrowserTextInput {
  cekField(event, ["kind", "text"]);
  const text = event.text;
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_CHARS) {
    throw invalid("Teks input tidak valid.");
  }
  return { kind: "text", text };
}

/**
 * Validasi daftar event input (fungsi murni).
 *
 * Semua galat memakai pesan umum: isi input bisa memuat kata sandi sehingga
 * tak boleh ikut terbawa ke pesan galat maupun log.
 */
export function validateInputEvents(
  raw: unknown,
  viewport: BrowserViewport,
): BrowserInputEvent[] {
  if (!Array.isArray(raw)) throw invalid("Daftar event input harus berupa larik.");
  if (raw.length > MAX_INPUT_EVENTS) {
    throw new BrowserError(
      `Jumlah event input melebihi batas ${MAX_INPUT_EVENTS}.`,
      "batas",
    );
  }
  const out: BrowserInputEvent[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw invalid("Event input harus berupa objek.");
    }
    const event = item as Record<string, unknown>;
    const kind = event.kind;
    if (kind === "mouse") out.push(validateMouse(event, viewport));
    else if (kind === "key") out.push(validateKey(event));
    else if (kind === "text") out.push(validateText(event));
    else throw invalid("Jenis event input tidak dikenal.");
  }
  return out;
}

/** Klem ukuran tampilan ke batas yang diizinkan dan bulatkan. */
export function clampViewportAxis(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid("Ukuran tampilan tidak valid.");
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

interface Subscriber {
  listener: BrowserFrameListener;
  busy: boolean;
  pending?: BrowserFrame;
}

/** Catatan internal satu tab halaman. */
interface TabRecord {
  /** TargetId CDP. */
  id: string;
  /** Sesi CDP melekat (flatten). */
  sessionId: string;
  title: string;
  url: string;
  loading: boolean;
  /** Id frame utama (untuk menyaring navigasi dalam dokumen). */
  mainFrameId?: string;
  /** Fungsi lepas untuk pendengar peristiwa tab ini. */
  unsubscribe: Array<() => void>;
}

/**
 * Manajer browser: satu Chromium per proses Jejak, banyak tab halaman dengan
 * satu tab aktif, screencast untuk panel, dan pencorng input mouse/keyboard.
 */
export class BrowserManager {
  private readonly env: Record<string, string | undefined>;
  private readonly platform: NodeJS.Platform;
  private readonly exists: ChromeExists;
  private readonly spawn: (command: string, args: string[]) => BrowserProcess;
  private readonly connect: (wsUrl: string) => Promise<CdpConnection>;
  private readonly readPort: (profileDir: string) => DevToolsEndpoint | undefined;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;
  private readonly idleScreenshotMs: number;
  private readonly portTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly readCommandLine: ReadCommandLine;
  private readonly killProcess: KillProcess;
  private readonly isProcessAlive: IsProcessAlive;
  private readonly pidFileName: string;
  private readonly dialogTtlMs: number;

  private client: CdpConnection | undefined;
  private process: BrowserProcess | undefined;
  /** Semua tab terbuka, urut sesuai pembuatan. */
  private readonly tabRecords = new Map<string, TabRecord>();
  /** Sesi yang sedang dipasang (menghindari pasang ganda). */
  private readonly attaching = new Map<string, Promise<TabRecord | undefined>>();
  private activeId: string | undefined;
  private canGoBack = false;
  private canGoForward = false;
  private viewport: BrowserViewport = { ...DEFAULT_VIEWPORT };
  private lastDialog: BrowserDialogInfo | undefined;
  private dialogTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly agentTtlMs: number;
  /** Catatan aktivitas agent terakhir. */
  private agent: BrowserAgentActivity | undefined;
  /** Pembatal timer aktivitas agent (dibersihkan saat close). */
  private agentCancel: (() => void) | undefined;
  private lastFrame: BrowserFrame | undefined;
  private screencastOn = false;
  /** Waktu frame terakhir yang diterima (ms); undefined bila belum ada. */
  private lastFrameAt: number | undefined;
  /** True saat permintaan screenshot sedang berjalan. */
  private capturePending = false;
  /** Pembatal detak pengaman; undefined bila detak tidak dijadwalkan. */
  private cancelTick: (() => void) | undefined;
  /** True bila pemeriksaan Chrome yatim sudah dijalankan sekali. */
  private orphanChecked = false;
  private readonly subscribers = new Set<Subscriber>();
  private readonly stateListeners = new Set<BrowserStateListener>();
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  /** Potret state terakhir yang dikirim (agar tak dikirim dua kali). */
  private lastSentState: string | undefined;
  /** Antrean pekerjaan tab (perubahan tab tak boleh saling berebut). */
  private antrean: Promise<unknown> = Promise.resolve();
  /** Tombol mouse yang sedang ditekan (untuk bitmask `buttons`). */
  private readonly pressedButtons = new Set<BrowserMouseButton>();
  /** Waktu event input terakhir (untuk batas laju). */
  private inputTimes: number[] = [];
  /** Jumlah elemen pada snapshot terakhir (ref valid hanya sampai snapshot berikutnya). */
  private snapshotCount = 0;

  constructor(options: BrowserManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.exists = options.exists ?? existsSync;
    this.spawn =
      options.spawn ??
      ((command, args) =>
        Bun.spawn([command, ...args], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }));
    this.connect = options.connect ?? ((wsUrl) => CdpClient.connect(wsUrl));
    this.readPort = options.readDevToolsPort ?? readDevToolsPortFile;
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        (timer as { unref?: () => void }).unref?.();
        return () => clearTimeout(timer);
      });
    this.idleScreenshotMs = options.idleScreenshotMs ?? DEFAULT_IDLE_SCREENSHOT_MS;
    this.portTimeoutMs = options.portTimeoutMs ?? DEFAULT_PORT_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.readCommandLine = options.readCommandLine ?? readCommandLinePs;
    this.killProcess = options.killProcess ?? killProcessById;
    this.isProcessAlive = options.isProcessAlive ?? isProcessAliveById;
    this.pidFileName = options.pidFileName ?? DEFAULT_PID_FILE_NAME;
    this.dialogTtlMs = options.dialogTtlMs ?? DIALOG_TTL_MS;
    this.agentTtlMs = options.agentTtlMs ?? AGENT_TTL_MS;
  }

  /** PID proses Chrome yang sedang berjalan (undefined bila belum ada). */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  /** Keadaan browser sekarang; tidak pernah membocorkan URL CDP. */
  state(): BrowserState {
    const tabs = this.tabs();
    const aktif = this.activeTab();
    return {
      status: this.client !== undefined ? "menyala" : "mati",
      tabs,
      activeId: this.activeId,
      url: aktif?.url ?? "",
      title: aktif?.title ?? "",
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      loading: aktif?.loading ?? false,
      viewport: { width: this.viewport.width, height: this.viewport.height },
      lastDialog: this.lastDialog,
      agent: this.agent,
    };
  }

  /**
   * Catat aktivitas agent yang sedang berjalan lalu dorong state ke pelanggan.
   *
   * `action` hanya label singkat (mis. "membuka alamat"); isi halaman dan teks
   * yang diketik tak boleh masuk ke sini. Catatan hilang sendiri 4 detik
   * setelah aktivitas terakhir (pola sama seperti catatan dialog).
   */
  noteAgent(action: string): void {
    const teks = action.trim().slice(0, MAX_AGENT_ACTION_CHARS);
    if (teks === "") return;
    this.agent = { action: teks, at: this.now() };
    this.agentCancel?.();
    this.agentCancel = this.schedule(() => {
      this.agentCancel = undefined;
      this.agent = undefined;
      this.notifyState();
    }, this.agentTtlMs);
    this.notifyState();
  }

  /** Daftar tab terbuka (urut sesuai pembuatan). */
  tabs(): BrowserTab[] {
    const out: BrowserTab[] = [];
    for (const record of this.tabRecords.values()) {
      out.push({
        id: record.id,
        title: record.title,
        url: record.url,
        active: record.id === this.activeId,
        loading: record.loading,
      });
    }
    return out;
  }

  /** Catatan internal tab aktif. */
  private activeTab(): TabRecord | undefined {
    if (this.activeId === undefined) return undefined;
    return this.tabRecords.get(this.activeId);
  }

  /** Pastikan Chrome berjalan; luncurkan bila belum. */
  async ensure(): Promise<void> {
    if (this.client !== undefined) return;
    if (!this.orphanChecked) {
      this.orphanChecked = true;
      await this.killOrphan(this.profileDir());
    }
    await this.start();
  }

  /** Folder profil browser milik Jejak. */
  private profileDir(): string {
    return join(jejakHome(this.env), "browser-profile");
  }

  /** Berkas pid Chrome di dalam folder profil. */
  private pidFilePath(profileDir: string): string {
    return join(profileDir, this.pidFileName);
  }

  /**
   * Tulis pid Chrome ke berkas profil supaya proses yatim bisa dikenai.
   */
  private writePidFile(profileDir: string, pid: number): void {
    try {
      writeFileSync(this.pidFilePath(profileDir), `${pid}\n`, "utf8");
    } catch {
      // Berkas pid hanya pelengkap; kegagalan tak boleh menggagalkan browser.
    }
  }

  /** Hapus berkas pid (dan port DevTools usang bila diminta). */
  private removePidFile(profileDir: string, jugaPort = false): void {
    for (const path of [
      this.pidFilePath(profileDir),
      ...(jugaPort ? [join(profileDir, "DevToolsActivePort")] : []),
    ]) {
      try {
        unlinkSync(path);
      } catch {
        // Berkas tak ada; abaikan.
      }
    }
  }

  /**
   * Bunuh Chrome yatim dari proses Jejak sebelumnya.
   *
   * Hanya proses yang baris perintahnya memuat path profil Jejak yang boleh
   * dibunuh; proses lain (misalnya pid yang dipakai ulang) tak boleh disentuh.
   */
  private async killOrphan(profileDir: string): Promise<void> {
    const pidFile = this.pidFilePath(profileDir);
    let isi: string;
    try {
      isi = readFileSync(pidFile, "utf8").trim();
    } catch {
      return;
    }
    const pid = Number.parseInt(isi, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      this.removePidFile(profileDir, true);
      return;
    }
    if (!this.isProcessAlive(pid)) {
      // Berkas pid usang: prosesnya sudah mati.
      this.removePidFile(profileDir, true);
      return;
    }
    if (this.platform === "win32") {
      // Windows tak punya `ps`; lewati pemeriksaan baris perintah.
      this.removePidFile(profileDir, true);
      return;
    }
    const baris = this.readCommandLine(pid) ?? "";
    if (!baris.includes(profileDir)) {
      // Bukan Chrome milik Jejak; jangan dibunuh.
      this.removePidFile(profileDir, true);
      return;
    }
    this.killProcess(pid, "SIGTERM");
    const mati = await this.waitProcessGone(pid, this.closeTimeoutMs);
    if (!mati) {
      this.killProcess(pid, "SIGKILL");
      await this.waitProcessGone(pid, 1_000);
    }
    this.removePidFile(profileDir, true);
  }

  /** Tunggu proses benar-benar hilang (true) atau waktu habis (false). */
  private async waitProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isProcessAlive(pid)) return true;
      await Bun.sleep(ORPHAN_POLL_MS);
    }
    return !this.isProcessAlive(pid);
  }

  private async start(): Promise<void> {
    const command = locateChrome(this.env, this.platform, this.exists);
    if (command === undefined) {
      throw new BrowserError(
        "Chrome atau Chromium tidak ditemukan. Pasang Google Chrome atau set JEJAK_CHROME_PATH.",
        "tidak-ditemukan",
      );
    }
    const profileDir = this.profileDir();
    try {
      mkdirSync(profileDir, { recursive: true });
    } catch {
      throw new BrowserError("Folder profil browser tidak dapat dibuat.", "gagal");
    }

    let proc: BrowserProcess;
    try {
      proc = this.spawn(command, chromeArgs(profileDir));
    } catch {
      throw new BrowserError("Chrome tidak dapat dijalankan.", "gagal");
    }
    this.process = proc;
    this.writePidFile(profileDir, proc.pid);
    void proc.exited
      .then(() => this.handleExit(proc))
      .catch(() => this.handleExit(proc));

    const endpoint = await this.waitForPort(profileDir);
    if (endpoint === undefined) {
      await this.terminate(proc);
      this.process = undefined;
      throw new BrowserError("Browser tidak siap; port DevTools tak terbaca.", "gagal");
    }

    let client: CdpConnection;
    try {
      // URL CDP hanya dipakai di dalam proses ini; tak pernah ke log atau klien.
      client = await this.connect(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`);
    } catch {
      await this.terminate(proc);
      this.process = undefined;
      throw new BrowserError("Gagal terhubung ke browser.", "gagal");
    }
    this.client = client;
    try {
      await this.attach(client);
    } catch (error) {
      this.client = undefined;
      await this.terminate(proc);
      this.process = undefined;
      if (error instanceof BrowserError) throw error;
      throw new BrowserError("Browser tidak dapat disiapkan.", "gagal");
    }
  }

  private async waitForPort(profileDir: string): Promise<DevToolsEndpoint | undefined> {
    const deadline = Date.now() + this.portTimeoutMs;
    while (Date.now() < deadline) {
      const endpoint = this.readPort(profileDir);
      if (endpoint !== undefined) return endpoint;
      await Bun.sleep(PORT_POLL_MS);
    }
    return undefined;
  }

  /** Pasang sesi CDP dan 준비kan tab halaman. */
  private async attach(client: CdpConnection): Promise<void> {
    // Peristiwa target dibaca dari event (bukan polling): popup, perubahan
    // judul, dan target yang ditutup.
    client.on("Target.targetCreated", (params) => {
      void this.onTargetCreated(params);
    });
    client.on("Target.targetInfoChanged", (params) => {
      this.onTargetInfoChanged(params);
    });
    client.on("Target.targetDestroyed", (params) => {
      this.onTargetDestroyed(params);
    });
    try {
      await client.send("Target.setDiscoverTargets", { discover: true });
    } catch {
      // Browser lama mungkin tak mendukung; tab tetap dibaca dari getTargets.
    }
    // Unduhan selalu ditolak: Jejak tak menyimpan berkas unduhan.
    try {
      await client.send("Browser.setDownloadBehavior", { behavior: "deny" });
    } catch {
      // Perilaku bawaan browser juga menolak unduhan di mode headless.
    }

    const targets = (await client.send("Target.getTargets")) as
      | { targetInfos?: Array<{ targetId?: string; type?: string }> }
      | undefined;
    const infos = targets?.targetInfos ?? [];
    const halaman = infos.filter(
      (info) => info.type === "page" && typeof info.targetId === "string",
    );
    if (halaman.length === 0) {
      const dibuat = (await client.send("Target.createTarget", { url: "about:blank" })) as
        | { targetId?: string }
        | undefined;
      const targetId = dibuat?.targetId;
      if (targetId === undefined) {
        throw new BrowserError("Tab halaman utama tidak ditemukan.", "gagal");
      }
      await this.ensureTab(targetId);
    } else {
      for (const info of halaman) {
        await this.ensureTab(info.targetId as string);
      }
    }

    // Tab aktif pertama: ukuran tampilan ikut dipasang di sana.
    const ids = [...this.tabRecords.keys()];
    const pertama = ids[0];
    if (pertama !== undefined) {
      this.activeId = undefined;
      await this.activateTabInner(pertama);
    }
    await this.refreshHistory();
  }

  /** Pasang sesi CDP untuk satu tab (sekali saja per target). */
  private async ensureTab(targetId: string): Promise<TabRecord | undefined> {
    const sedang = this.attaching.get(targetId);
    if (sedang !== undefined) return sedang;
    const ada = this.tabRecords.get(targetId);
    if (ada !== undefined) return ada;
    const kerja = this.attachTab(targetId);
    this.attaching.set(targetId, kerja);
    try {
      return await kerja;
    } finally {
      this.attaching.delete(targetId);
    }
  }

  /** Buat catatan tab dan pasang sesi CDP-nya. */
  private async attachTab(targetId: string): Promise<TabRecord | undefined> {
    const client = this.client;
    if (client === undefined) return undefined;
    let sessionId: string | undefined;
    try {
      const attached = (await client.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId?: string } | undefined;
      sessionId = attached?.sessionId;
    } catch {
      // Target sudah tertutup; tab tak dibuat.
      return undefined;
    }
    if (sessionId === undefined) return undefined;
    const record: TabRecord = {
      id: targetId,
      sessionId,
      title: "",
      url: "",
      loading: false,
      unsubscribe: [],
    };
    this.tabRecords.set(targetId, record);
    try {
      await client.send("Page.enable", undefined, sessionId);
      await client.send("Runtime.enable", undefined, sessionId);
    } catch {
      // Domain tak tersedia; tab tetap dipakai tanpa informasi tambahan.
    }
    this.registerTabHandlers(record);
    await this.refreshTabInfo(record);
    return record;
  }

  /** Daftarkan pendengar peristiwa untuk satu tab. */
  private registerTabHandlers(record: TabRecord): void {
    const client = this.client;
    if (client === undefined) return;
    const sid = record.sessionId;
    record.unsubscribe.push(
      client.on(
        "Page.frameNavigated",
        (params) => {
          const p = params as { frame?: { id?: string; url?: string; parentId?: string } };
          const frame = p.frame;
          if (frame === undefined) return;
          // Hanya frame utama yang mengubah URL tab.
          if (frame.parentId !== undefined) return;
          if (typeof frame.id === "string") record.mainFrameId = frame.id;
          if (typeof frame.url === "string") {
            record.url = frame.url;
            this.notifyState();
          }
          void this.refreshHistory();
        },
        sid,
      ),
      client.on(
        "Page.navigatedWithinDocument",
        (params) => {
          const p = params as { frameId?: string; url?: string };
          if (typeof p.url !== "string") return;
          if (record.mainFrameId !== undefined && p.frameId !== record.mainFrameId) return;
          record.url = p.url;
          this.notifyState();
        },
        sid,
      ),
      client.on(
        "Page.frameStartedLoading",
        () => {
          record.loading = true;
          this.notifyState();
        },
        sid,
      ),
      client.on(
        "Page.frameStoppedLoading",
        () => {
          record.loading = false;
          // Judul dan URL final halaman diambil setelah pemuatan selesai.
          void this.refreshTabInfo(record);
          this.notifyState();
        },
        sid,
      ),
      client.on(
        "Page.loadEventFired",
        () => {
          record.loading = false;
          void this.refreshTabInfo(record);
          void this.refreshHistory();
          this.notifyState();
        },
        sid,
      ),
      client.on(
        "Page.javascriptDialogOpening",
        (params) => {
          void this.handleDialog(record, params);
        },
        sid,
      ),
      client.on(
        "Page.screencastFrame",
        (params) => {
          this.onFrame(
            params as {
              data?: string;
              sessionId?: number;
              metadata?: { deviceWidth?: number; deviceHeight?: number };
            },
          );
        },
        sid,
      ),
    );
  }

  /** Target halaman baru (popup): jadikan tab aktif. */
  private async onTargetCreated(params: unknown): Promise<void> {
    // Browser yang sudah ditutup tak boleh dilalui lagi (tak boleh menyalakan
    // Chrome baru dari peristiwa yang tertinggal).
    if (this.client === undefined) return;
    const p = params as
      | { targetInfo?: { targetId?: string; type?: string; url?: string; title?: string } }
      | undefined;
    const info = p?.targetInfo;
    if (info === undefined) return;
    if (info.type !== "page") return;
    const targetId = info.targetId;
    if (typeof targetId !== "string" || targetId === "") return;
    if (this.tabRecords.has(targetId)) return;
    if (this.tabRecords.size >= MAX_TABS) {
      // Batas tab terlampaui; popup ditutup lagi.
      await this.closeTarget(targetId);
      return;
    }
    const tab = await this.ensureTab(targetId);
    if (tab === undefined) return;
    if (typeof info.url === "string") tab.url = info.url;
    if (typeof info.title === "string") tab.title = info.title;
    await this.activateTab(targetId);
  }

  /** Judul atau URL tab berubah. */
  private onTargetInfoChanged(params: unknown): void {
    const p = params as
      | { targetInfo?: { targetId?: string; url?: string; title?: string } }
      | undefined;
    const info = p?.targetInfo;
    if (info === undefined) return;
    const targetId = info.targetId;
    if (typeof targetId !== "string") return;
    const tab = this.tabRecords.get(targetId);
    if (tab === undefined) return;
    let berubah = false;
    if (typeof info.url === "string" && info.url !== "" && info.url !== tab.url) {
      tab.url = info.url;
      berubah = true;
    }
    if (typeof info.title === "string" && info.title !== tab.title) {
      tab.title = info.title;
      berubah = true;
    }
    if (berubah) this.notifyState();
  }

  /** Target ditutup (misalnya popup yang shuts itself down). */
  private onTargetDestroyed(params: unknown): void {
    const p = params as { targetId?: string } | undefined;
    const targetId = p?.targetId;
    if (typeof targetId !== "string") return;
    const tab = this.tabRecords.get(targetId);
    if (tab === undefined) return;
    const tetangga = this.tetanggaDari(targetId);
    for (const unsubscribe of tab.unsubscribe) unsubscribe();
    this.tabRecords.delete(targetId);
    if (this.activeId === targetId) this.activeId = undefined;
    void this.antri(() => this.surelAktif(tetangga));
    this.notifyState();
  }

  /** Tutup target lewat CDP; kegagalan diabaikan. */
  private async closeTarget(targetId: string): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    try {
      await client.send("Target.closeTarget", { targetId });
    } catch {
      // Target sudah tertutup.
    }
  }

  /**
   * Pastikan selalu ada satu tab aktif.
   *
   * `tetangga` adalah tab yang sebaiknya aktif (misalnya tab di sebelah tab
   * yang baru ditutup); bila tak ada, tab pertama yang dipakai.
   */
  private async surelAktif(tetangga?: string): Promise<void> {
    if (this.activeId !== undefined && this.tabRecords.has(this.activeId)) return;
    if (tetangga !== undefined && this.tabRecords.has(tetangga)) {
      await this.activateTabInner(tetangga);
      return;
    }
    const ids = [...this.tabRecords.keys()];
    const pertama = ids[0];
    if (pertama !== undefined) {
      await this.activateTabInner(pertama);
      return;
    }
    await this.buatTabKosong();
  }

  /** Tab di sebelah tab yang ditutup (sebelum lebih dulu, lalu sesudah). */
  private tetanggaDari(targetId: string): string | undefined {
    const ids = [...this.tabRecords.keys()];
    const index = ids.indexOf(targetId);
    if (index < 0) return undefined;
    const sebelum = ids[index - 1];
    if (sebelum !== undefined) return sebelum;
    return ids[index + 1];
  }

  /** Buat tab about:blank baru lalu aktifkan. */
  private async buatTabKosong(): Promise<string | undefined> {
    const client = this.client;
    if (client === undefined) return undefined;
    let targetId: string | undefined;
    try {
      const dibuat = (await client.send("Target.createTarget", { url: "about:blank" })) as
        | { targetId?: string }
        | undefined;
      targetId = dibuat?.targetId;
    } catch {
      return undefined;
    }
    if (targetId === undefined) return undefined;
    const tab = await this.ensureTab(targetId);
    if (tab === undefined) return undefined;
    await this.activateTabInner(targetId);
    return targetId;
  }

  /** Jalankan pekerjaan tab secara berurutan. */
  private async antri<T>(kerja: () => Promise<T>): Promise<T> {
    const hasil = this.antrean.then(kerja, kerja);
    this.antrean = hasil.then(
      () => undefined,
      () => undefined,
    );
    return hasil;
  }

  /** Ambil URL dan judul tab terbaru (best effort). */
  private async refreshTabInfo(record: TabRecord): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    try {
      const result = (await client.send("Target.getTargetInfo", { targetId: record.id })) as
        | { targetInfo?: { url?: unknown; title?: unknown } }
        | undefined;
      const info = result?.targetInfo;
      if (info === undefined) return;
      if (typeof info.url === "string" && info.url !== "") record.url = info.url;
      if (typeof info.title === "string") record.title = info.title;
    } catch {
      // Info target bersifat tambahan; kegagalan tidak berwarna galat.
    }
  }

  /** Perbarui penanda riwayat (mundur/maju). */
  private async refreshHistory(): Promise<void> {
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) return;
    try {
      const result = (await client.send("Page.getNavigationHistory", undefined, tab.sessionId)) as
        | { currentIndex?: number; entries?: unknown[] }
        | undefined;
      const currentIndex = typeof result?.currentIndex === "number" ? result.currentIndex : 0;
      const total = Array.isArray(result?.entries) ? result.entries.length : 0;
      const canGoBack = currentIndex > 0;
      const canGoForward = total > 0 && currentIndex < total - 1;
      if (canGoBack === this.canGoBack && canGoForward === this.canGoForward) return;
      this.canGoBack = canGoBack;
      this.canGoForward = canGoForward;
      this.notifyState();
    } catch {
      // Riwayat bersifat tambahan; kegagalan tidak berwarna galat.
    }
  }

  /** Navigasi tab aktif ke URL yang sudah dinormalisasi. */
  async navigate(input: unknown): Promise<BrowserState> {
    const url = normalizeBrowserUrl(input);
    await this.ensure();
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) {
      throw new BrowserError("Browser tidak berjalan.", "mati");
    }
    try {
      await client.send("Page.navigate", { url }, tab.sessionId);
    } catch (error) {
      if (error instanceof BrowserError && error.code === "mati") {
        this.client = undefined;
      }
      throw error;
    }
    tab.url = url;
    await this.refreshTabInfo(tab);
    // URL yang diminta tampil lebih dulu; info target bisa tertinggal.
    tab.url = url;
    // Halaman berganti; ref dari snapshot sebelumnya tak berlaku lagi.
    this.snapshotCount = 0;
    await this.refreshHistory();
    this.notifyState();
    return this.state();
  }

  /** Buka tab baru (maksimal 8 tab). */
  async newTab(input?: unknown): Promise<BrowserState> {
    await this.ensure();
    if (this.tabRecords.size >= MAX_TABS) {
      throw new BrowserError(
        `Batas ${MAX_TABS} tab browser terlampaui. Tutup salah satu tab dulu.`,
        "batas",
      );
    }
    const url = input === undefined || input === null ? "about:blank" : normalizeBrowserUrl(input);
    const client = this.client;
    if (client === undefined) throw new BrowserError("Browser tidak berjalan.", "mati");
    const created = (await client.send("Target.createTarget", { url })) as
      | { targetId?: string }
      | undefined;
    const targetId = created?.targetId;
    if (targetId === undefined) throw new BrowserError("Tab baru tidak dapat dibuat.", "gagal");
    const tab = await this.ensureTab(targetId);
    if (tab === undefined) throw new BrowserError("Tab baru tidak dapat disiapkan.", "gagal");
    tab.url = url;
    await this.antri(() => this.activateTabInner(targetId));
    return this.state();
  }

  /** Aktifkan tab; screencast pindah ke tab itu. */
  async activateTab(id: string): Promise<BrowserState> {
    await this.ensure();
    if (this.tabRecords.get(id) === undefined) {
      throw new BrowserError("Tab tidak ditemukan.", "tidak-ditemukan");
    }
    return this.antri(() => this.activateTabInner(id));
  }

  /** Inti aktivasi tab (dipakai juga dari dalam antrean). */
  private async activateTabInner(id: string): Promise<BrowserState> {
    const tab = this.tabRecords.get(id);
    if (tab === undefined) {
      throw new BrowserError("Tab tidak ditemukan.", "tidak-ditemukan");
    }
    if (this.activeId === id) return this.state();
    const lama = this.activeTab();
    this.activeId = id;
    // Tab berganti; ref dari snapshot sebelumnya tak berlaku lagi.
    this.snapshotCount = 0;
    await this.stopScreencastOn(lama);
    const client = this.client;
    if (client !== undefined) {
      try {
        await client.send("Target.activateTarget", { targetId: id });
      } catch {
        // Aktivasi target gagal; tab tetap dianggap aktif.
      }
      try {
        await client.send("Page.bringToFront", undefined, tab.sessionId);
      } catch {
        // bringToFront gagal; tab tetap dianggap aktif.
      }
      await this.applyViewportTo(tab);
    }
    // Frame lama milik tab sebelumnya; jangan ditampilkan di tab baru.
    this.lastFrame = undefined;
    if (this.subscribers.size > 0) await this.startScreencast();
    await this.refreshHistory();
    this.notifyState();
    return this.state();
  }

  /** Tutup tab; tab terakhir diganti tab about:blank baru. */
  async closeTab(id: string): Promise<BrowserState> {
    await this.ensure();
    if (this.tabRecords.get(id) === undefined) {
      throw new BrowserError("Tab tidak ditemukan.", "tidak-ditemukan");
    }
    return this.antri(() => this.closeTabInner(id));
  }

  /** Inti penutupan tab. */
  private async closeTabInner(id: string): Promise<BrowserState> {
    const tab = this.tabRecords.get(id);
    if (tab === undefined) {
      throw new BrowserError("Tab tidak ditemukan.", "tidak-ditemukan");
    }
    const aktif = this.activeId === id;
    if (aktif) await this.stopScreencastOn(tab);
    const client = this.client;
    if (client !== undefined) {
      try {
        await client.send("Target.closeTarget", { targetId: id });
      } catch {
        // Target sudah tertutup.
      }
      try {
        await client.send("Target.detachFromTarget", { sessionId: tab.sessionId });
      } catch {
        // Sesi sudah terlepas.
      }
    }
    const tetangga = this.tetanggaDari(id);
    for (const unsubscribe of tab.unsubscribe) unsubscribe();
    this.tabRecords.delete(id);
    if (this.activeId === id) this.activeId = undefined;
    await this.surelAktif(tetangga);
    this.notifyState();
    return this.state();
  }

  /** Mundur satu entri riwayat; tak ada riwayat berarti tak berubah. */
  async back(): Promise<BrowserState> {
    await this.ensure();
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) {
      throw new BrowserError("Browser tidak berjalan.", "mati");
    }
    const riwayat = await this.daftarRiwayat();
    if (riwayat === undefined) return this.state();
    const indeksTujuan = riwayat.currentIndex - 1;
    const target = riwayat.entries[indeksTujuan];
    if (target === undefined) return this.state();
    await client.send("Page.navigateToHistoryEntry", { entryId: target.id }, tab.sessionId);
    // URL entri tujuan langsung dipakai; peristiwa navigasi akan menyelaraskan.
    tab.url = target.url;
    // Halaman berganti; ref dari snapshot sebelumnya tak berlaku lagi.
    this.snapshotCount = 0;
    // Tunggu navigasi selesai; tanpa ini riwayat berikutnya bisa dibaca basi.
    await this.tungguRiwayat(indeksTujuan);
    await this.refreshHistory();
    this.notifyState();
    return this.state();
  }

  /** Maju satu entri riwayat; tak ada riwayat berarti tak berubah. */
  async forward(): Promise<BrowserState> {
    await this.ensure();
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) {
      throw new BrowserError("Browser tidak berjalan.", "mati");
    }
    const riwayat = await this.daftarRiwayat();
    if (riwayat === undefined) return this.state();
    const indeksTujuan = riwayat.currentIndex + 1;
    const target = riwayat.entries[indeksTujuan];
    if (target === undefined) return this.state();
    await client.send("Page.navigateToHistoryEntry", { entryId: target.id }, tab.sessionId);
    // URL entri tujuan langsung dipakai; peristiwa navigasi akan menyelaraskan.
    tab.url = target.url;
    // Halaman berganti; ref dari snapshot sebelumnya tak berlaku lagi.
    this.snapshotCount = 0;
    // Tunggu navigasi selesai; tanpa ini riwayat berikutnya bisa dibaca basi.
    await this.tungguRiwayat(indeksTujuan);
    await this.refreshHistory();
    this.notifyState();
    return this.state();
  }

  /** Muat ulang halaman tab aktif. */
  async reload(): Promise<BrowserState> {
    await this.ensure();
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) {
      throw new BrowserError("Browser tidak berjalan.", "mati");
    }
    await client.send("Page.reload", { ignoreCache: false }, tab.sessionId);
    // Halaman berganti; ref dari snapshot sebelumnya tak berlaku lagi.
    this.snapshotCount = 0;
    // Tunggu muat ulang selesai supaya state tak masih menampilkan halaman lama.
    await this.tungguMuatUlang();
    await this.refreshHistory();
    this.notifyState();
    return this.state();
  }

  /** Hentikan pemuatan halaman tab aktif. */
  async stop(): Promise<BrowserState> {
    await this.ensure();
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) {
      throw new BrowserError("Browser tidak berjalan.", "mati");
    }
    await client.send("Page.stopLoading", undefined, tab.sessionId);
    this.notifyState();
    return this.state();
  }

  /** Daftar entri riwayat halaman aktif. */
  private async daftarRiwayat(): Promise<
    { currentIndex: number; entries: Array<{ id: number; url: string }> } | undefined
  > {
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) return undefined;
    try {
      const result = (await client.send("Page.getNavigationHistory", undefined, tab.sessionId)) as
        | { currentIndex?: number; entries?: Array<{ id?: number; url?: string }> }
        | undefined;
      const currentIndex = typeof result?.currentIndex === "number" ? result.currentIndex : 0;
      const entries = (result?.entries ?? []).filter(
        (entry): entry is { id: number; url: string } => typeof entry.id === "number",
      );
      return { currentIndex, entries };
    } catch {
      return undefined;
    }
  }

  /**
   * Tunggu navigasi riwayat selesai: indeks riwayat mencapai entri tujuan lalu
   * halaman berhenti memuat.
   *
   * Batas 3 detik supaya tak memblokir selamanya; bila belum selesai, state
   * terakhir yang ada tetap dikembalikan.
   */
  private async tungguRiwayat(indeksTujuan: number): Promise<void> {
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const riwayat = await this.daftarRiwayat();
      if (riwayat === undefined) return;
      if (riwayat.currentIndex === indeksTujuan) {
        await this.tungguMuatSelesai(deadline);
        return;
      }
      await Bun.sleep(NAVIGATION_POLL_MS);
    }
  }

  /** Tunggu halaman berhenti memuat; memakai sisa batas waktu yang diberi. */
  private async tungguMuatSelesai(deadline: number): Promise<void> {
    const tab = this.activeTab();
    if (tab === undefined) return;
    while (Date.now() < deadline && tab.loading) {
      await Bun.sleep(NAVIGATION_POLL_MS);
    }
  }

  /**
   * Tunggu muat ulang selesai.
   *
   * Peristiwa "halaman mulai memuat" bisa datang sedikit setelah balasan
   * perintah, jadi diberi jeda singkat sebelum menunggu halaman diam.
   */
  private async tungguMuatUlang(): Promise<void> {
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    const tab = this.activeTab();
    if (tab === undefined) return;
    const akhir = Math.min(deadline, Date.now() + NAVIGATION_GRACE_MS);
    while (Date.now() < akhir && !tab.loading) {
      await Bun.sleep(NAVIGATION_POLL_MS);
    }
    await this.tungguMuatSelesai(deadline);
  }

  /** Ubah ukuran tampilan; diterapkan ke tab aktif dan tab berikutnya. */
  async setViewport(width: unknown, height: unknown): Promise<BrowserState> {
    await this.ensure();
    const w = clampViewportAxis(width, VIEWPORT_MIN_WIDTH, VIEWPORT_MAX_WIDTH);
    const h = clampViewportAxis(height, VIEWPORT_MIN_HEIGHT, VIEWPORT_MAX_HEIGHT);
    this.viewport = { width: w, height: h };
    const tab = this.activeTab();
    if (tab !== undefined) {
      await this.applyViewportTo(tab);
      if (this.screencastOn) {
        await this.stopScreencastOn(tab);
        await this.startScreencast();
      }
    }
    this.notifyState();
    return this.state();
  }

  /** Pasang ukuran tampilan ke satu tab. */
  private async applyViewportTo(tab: TabRecord): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    try {
      await client.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: this.viewport.width,
          height: this.viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        tab.sessionId,
      );
    } catch {
      // Emulasi gagal; tampilan memakai ukuran bawaan browser.
    }
  }

  /** Kirim daftar event input ke tab aktif secara berurutan. */
  async dispatchInput(events: unknown): Promise<BrowserState> {
    await this.ensure();
    const daftar = validateInputEvents(events, this.viewport);
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) {
      throw new BrowserError("Browser tidak berjalan.", "mati");
    }
    this.cekLajuInput(daftar.length);
    for (const event of daftar) {
      await this.kirimInput(client, tab, event);
    }
    this.notifyState();
    return this.state();
  }

  /** Tolak event yang melebihi batas laju (200 event/detik). */
  private cekLajuInput(jumlah: number): void {
    const now = this.now();
    this.inputTimes = this.inputTimes.filter((waktu) => now - waktu < 1000);
    if (this.inputTimes.length + jumlah > MAX_INPUT_RATE) {
      throw new BrowserError("Batas laju input terlampaui. Kurangi jumlah event.", "batas");
    }
    for (let i = 0; i < jumlah; i += 1) this.inputTimes.push(now);
  }

  /** Terjemahkan satu event input ke perintah CDP. */
  private async kirimInput(
    client: CdpConnection,
    tab: TabRecord,
    event: BrowserInputEvent,
  ): Promise<void> {
    if (event.kind === "text") {
      await client.send("Input.insertText", { text: event.text }, tab.sessionId);
      return;
    }
    if (event.kind === "key") {
      const modifier = event.modifiers ?? 0;
      const keyCode =
        event.keyCode === undefined ? {} : { windowsVirtualKeyCode: event.keyCode };
      if (event.type === "up") {
        await client.send(
          "Input.dispatchKeyEvent",
          { type: "keyUp", key: event.key, code: event.code, modifiers: modifier, ...keyCode },
          tab.sessionId,
        );
        return;
      }
      const cetak = event.text !== undefined && event.text !== "" && !CONTROL_KEYS.has(event.key);
      await client.send(
        "Input.dispatchKeyEvent",
        {
          type: cetak ? "keyDown" : "rawKeyDown",
          key: event.key,
          code: event.code,
          modifiers: modifier,
          ...(cetak ? { text: event.text } : {}),
          ...keyCode,
        },
        tab.sessionId,
      );
      return;
    }
    const modifier = event.modifiers ?? 0;
    const button =
      event.button ??
      (event.type === "move" || event.type === "wheel" ? "none" : "left");
    if (event.type === "move") {
      await client.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x: event.x,
          y: event.y,
          button: "none",
          buttons: this.maskTombol(),
          modifiers: modifier,
        },
        tab.sessionId,
      );
      return;
    }
    if (event.type === "down") {
      if (button !== "none") this.pressedButtons.add(button);
      await client.send(
        "Input.dispatchMouseEvent",
        {
          type: "mousePressed",
          x: event.x,
          y: event.y,
          button,
          clickCount: event.clickCount ?? 1,
          buttons: this.maskTombol(),
          modifiers: modifier,
        },
        tab.sessionId,
      );
      return;
    }
    if (event.type === "up") {
      if (button !== "none") this.pressedButtons.delete(button);
      await client.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseReleased",
          x: event.x,
          y: event.y,
          button,
          clickCount: event.clickCount ?? 1,
          buttons: this.maskTombol(),
          modifiers: modifier,
        },
        tab.sessionId,
      );
      return;
    }
    await client.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x: event.x,
        y: event.y,
        deltaX: event.deltaX ?? 0,
        deltaY: event.deltaY ?? 0,
        button: "none",
        buttons: this.maskTombol(),
        modifiers: modifier,
      },
      tab.sessionId,
    );
  }

  /** Bitmask tombol mouse yang sedang ditekan. */
  private maskTombol(): number {
    let mask = 0;
    if (this.pressedButtons.has("left")) mask |= 1;
    if (this.pressedButtons.has("right")) mask |= 2;
    if (this.pressedButtons.has("middle")) mask |= 4;
    return mask;
  }

  /** Ambil teks pilihan halaman tab aktif. */
  async copySelection(): Promise<string> {
    await this.ensure();
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) {
      throw new BrowserError("Browser tidak berjalan.", "mati");
    }
    const result = (await client.send(
      "Runtime.evaluate",
      { expression: "window.getSelection().toString()", returnByValue: true },
      tab.sessionId,
    )) as { result?: { value?: unknown } } | undefined;
    const value = result?.result?.value;
    if (typeof value !== "string") return "";
    return value.slice(0, MAX_SELECTION_CHARS);
  }

  /**
   * Ambil cuplikan halaman aktif: teks dan elemen interaktif yang terlihat.
   *
   * Hasil halaman adalah data tak dipercaya; manajer tak menafsirkan isinya
   * dan tak pernah menjalankan JavaScript dari agent.
   */
  async snapshot(options?: { maxChars?: number }): Promise<PageSnapshot> {
    await this.ensure();
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) {
      throw new BrowserError("Browser tidak berjalan.", "mati");
    }
    const maxChars = batasSnapshotChars(options?.maxChars);
    const nilai = await this.evaluate(SNAPSHOT_SCRIPT, tab);
    const hasil = uraiSnapshot(nilai);
    this.snapshotCount = hasil.elements.length;
    return {
      url: hasil.url,
      title: hasil.title,
      text: potongTeks(hasil.text, maxChars),
      elements: hasil.elements,
    };
  }

  /** Klik elemen berdasarkan ref dari snapshot terakhir. */
  async clickRef(ref: number): Promise<BrowserState> {
    await this.ensure();
    const hasil = await this.jalankanAksi("klik", ref);
    const posisi = titikDari(hasil);
    if (posisi === undefined) throw elemenTidakDitemukan();
    const x = Math.min(this.viewport.width, Math.max(0, posisi.x));
    const y = Math.min(this.viewport.height, Math.max(0, posisi.y));
    await this.dispatchInput([
      { kind: "mouse", type: "move", x, y },
      { kind: "mouse", type: "down", x, y, button: "left", clickCount: 1 },
      { kind: "mouse", type: "up", x, y, button: "left", clickCount: 1 },
    ]);
    await this.tungguDiam();
    this.notifyState();
    return this.state();
  }

  /**
   * Isi elemen (input) berdasarkan ref dari snapshot terakhir.
   *
   * Isi yang diketik tak boleh ikut muncul di pesan galat maupun log.
   */
  async typeRef(
    ref: number,
    text: string,
    options?: { submit?: boolean },
  ): Promise<BrowserState> {
    await this.ensure();
    if (typeof text !== "string") throw invalid("Teks yang diketik harus berupa teks.");
    if (text.length > MAX_TYPE_REF_CHARS) {
      throw new BrowserError(
        `Teks yang diketik melebihi batas ${MAX_TYPE_REF_CHARS} karakter.`,
        "batas",
      );
    }
    const fokus = await this.jalankanAksi("fokus", ref);
    const posisi = titikDari(fokus);
    if (posisi === undefined) throw elemenTidakDitemukan();
    const x = Math.min(this.viewport.width, Math.max(0, posisi.x));
    const y = Math.min(this.viewport.height, Math.max(0, posisi.y));
    // Klik tengah supaya elemen benar-benar terfokus.
    await this.dispatchInput([
      { kind: "mouse", type: "move", x, y },
      { kind: "mouse", type: "down", x, y, button: "left", clickCount: 1 },
      { kind: "mouse", type: "up", x, y, button: "left", clickCount: 1 },
    ]);
    // Pilih isi lama supaya teks baru menggantikannya.
    const pilih = await this.jalankanAksi("pilih", ref);
    if (pilih === undefined) throw elemenTidakDitemukan();
    await this.dispatchInput([{ kind: "text", text }]);
    if (options?.submit === true) {
      await this.dispatchInput([
        { kind: "key", type: "down", key: "Enter", code: "Enter", keyCode: 13 },
        { kind: "key", type: "up", key: "Enter", code: "Enter", keyCode: 13 },
      ]);
    }
    await this.tungguDiam();
    this.notifyState();
    return this.state();
  }

  /** Tekan satu tombol yang aman (daftar putih tetap). */
  async pressKey(key: string): Promise<BrowserState> {
    await this.ensure();
    const tombol = infoTombol(key);
    if (tombol === undefined) throw invalid("Tombol tidak diizinkan.");
    await this.dispatchInput([
      {
        kind: "key",
        type: "down",
        key: tombol.key,
        code: tombol.code,
        keyCode: tombol.keyCode,
        ...(tombol.text === undefined ? {} : { text: tombol.text }),
      },
      { kind: "key", type: "up", key: tombol.key, code: tombol.code, keyCode: tombol.keyCode },
    ]);
    await this.tungguDiam();
    this.notifyState();
    return this.state();
  }

  /** Gulir halaman ke atas atau ke bawah di tengah tampilan. */
  async scroll(direction: "up" | "down", amount?: number): Promise<BrowserState> {
    await this.ensure();
    if (direction !== "up" && direction !== "down") throw invalid("Arah gulir tidak valid.");
    const px = batasGulir(amount);
    const x = Math.round(this.viewport.width / 2);
    const y = Math.round(this.viewport.height / 2);
    await this.dispatchInput([
      {
        kind: "mouse",
        type: "wheel",
        x,
        y,
        deltaX: 0,
        deltaY: direction === "down" ? px : -px,
      },
    ]);
    await this.tungguDiam();
    this.notifyState();
    return this.state();
  }

  /** Jalankan skrip tetap di tab aktif dan ambil nilai balikanya. */
  private async evaluate(expression: string, tab: TabRecord): Promise<unknown> {
    const client = this.client;
    if (client === undefined) return undefined;
    const hasil = (await client.send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      tab.sessionId,
    )) as { result?: { value?: unknown } } | undefined;
    return hasil?.result?.value;
  }

  /** Jalankan aksi berbasis elemen; undefined bila ref tak dikenal. */
  private async jalankanAksi(
    aksi: "klik" | "fokus" | "pilih",
    ref: number,
  ): Promise<Record<string, unknown> | undefined> {
    if (!Number.isInteger(ref) || ref < 1 || ref > this.snapshotCount) return undefined;
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) return undefined;
    const nilai = await this.evaluate(ekspresiAksi(aksi, ref), tab);
    if (typeof nilai !== "object" || nilai === null) return undefined;
    return nilai as Record<string, unknown>;
  }

  /** Tunggu halaman tenang agar snapshot berikutnya segar. */
  private async tungguDiam(): Promise<void> {
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const tab = this.activeTab();
      if (tab === undefined || !tab.loading) break;
      await Bun.sleep(50);
    }
    const sisa = deadline - Date.now();
    if (sisa > 0) await Bun.sleep(Math.min(ACTION_SETTLE_MS, sisa));
  }

  /** Dialog JavaScript: alert diterima, sisanya ditolak. */
  private async handleDialog(tab: TabRecord, params: unknown): Promise<void> {
    const p = params as { type?: unknown; message?: unknown } | undefined;
    const type = typeof p?.type === "string" ? p.type : "alert";
    const message = typeof p?.message === "string" ? p.message.slice(0, 200) : "";
    this.lastDialog = { type, message };
    if (this.dialogTimer !== undefined) clearTimeout(this.dialogTimer);
    this.dialogTimer = setTimeout(() => {
      this.dialogTimer = undefined;
      this.lastDialog = undefined;
      this.notifyState();
    }, this.dialogTtlMs);
    (this.dialogTimer as { unref?: () => void }).unref?.();
    this.notifyState();
    const client = this.client;
    if (client === undefined) return;
    try {
      // Alert diterima; confirm/prompt/beforeunload ditolak.
      await client.send(
        "Page.handleJavaScriptDialog",
        { accept: type === "alert" },
        tab.sessionId,
      );
    } catch {
      // Dialog sudah tertutup halaman.
    }
  }

  /**
   * Dengarkan frame screencast. Screencast mulai saat pelanggan pertama dan
   * berhenti saat pelanggan terakhir pergi. Frame terakhir tersimpan dan
   * dikirim ke pelanggan baru.
   */
  subscribe(listener: BrowserFrameListener): () => void {
    const subscriber: Subscriber = { listener, busy: false };
    this.subscribers.add(subscriber);
    if (this.subscribers.size === 1) void this.startScreencast();
    const last = this.lastFrame;
    if (last !== undefined) this.deliver(subscriber, last);
    return () => {
      if (!this.subscribers.delete(subscriber)) return;
      subscriber.pending = undefined;
      if (this.subscribers.size === 0) void this.stopScreencastOn(this.activeTab());
    };
  }

  /**
   * Dengarkan perubahan state. State sekarang langsung dikirim ke pendengar
   * baru; perubahan berikutnya dikirim setelah jeda pendek (debounce).
   */
  subscribeState(listener: BrowserStateListener): () => void {
    const pertama = this.stateListeners.size === 0;
    this.stateListeners.add(listener);
    const snapshot = this.state();
    if (pertama) this.lastSentState = JSON.stringify(snapshot);
    try {
      listener(snapshot);
    } catch {
      // Pendengar yang rusak tak boleh menghentikan pembaruan state.
    }
    return () => {
      this.stateListeners.delete(listener);
      if (this.stateListeners.size === 0) {
        this.lastSentState = undefined;
        if (this.stateTimer !== undefined) {
          clearTimeout(this.stateTimer);
          this.stateTimer = undefined;
        }
      }
    };
  }

  /** Tandai state berubah; pengiriman ditunda sebentar. */
  private notifyState(): void {
    if (this.stateListeners.size === 0) return;
    if (this.stateTimer !== undefined) clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.flushState();
    }, STATE_DEBOUNCE_MS);
    (this.stateTimer as { unref?: () => void }).unref?.();
  }

  /** Kirim state ke pendengar; state identik tak pernah dikirim dua kali. */
  private flushState(): void {
    if (this.stateListeners.size === 0) return;
    const snapshot = this.state();
    const json = JSON.stringify(snapshot);
    if (json === this.lastSentState) return;
    this.lastSentState = json;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(snapshot);
      } catch {
        // Pendengar yang rusak tak boleh menghentikan pembaruan state.
      }
    }
  }

  private async startScreencast(): Promise<void> {
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined || this.screencastOn) return;
    try {
      await client.send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: SCREENSHOT_QUALITY,
          maxWidth: this.viewport.width,
          maxHeight: this.viewport.height,
        },
        tab.sessionId,
      );
      this.screencastOn = true;
    } catch {
      // Tanpa screencast, panel hanya menampilkan pesan "menunggu frame".
    }
    this.lastFrameAt = this.now();
    // Benih: screencast tak selalu mengirim frame untuk halaman statis.
    await this.captureScreenshot();
    this.scheduleTick();
  }

  /** Hentikan screencast pada tab tertentu. */
  private async stopScreencastOn(tab: TabRecord | undefined): Promise<void> {
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.lastFrameAt = undefined;
    const client = this.client;
    const hidup = this.screencastOn;
    this.screencastOn = false;
    if (client === undefined || tab === undefined || !hidup) return;
    try {
      await client.send("Page.stopScreencast", undefined, tab.sessionId);
    } catch {
      // Browser mungkin sudah ditutup.
    }
  }

  /**
   * Ambil satu frame lewat `Page.captureScreenshot` lalu salurkan sebagai frame.
   *
   * Best effort: kegagalan diabaikan agar panel tak terkunci.
   */
  private async captureScreenshot(): Promise<void> {
    if (this.capturePending) return;
    const client = this.client;
    const tab = this.activeTab();
    if (client === undefined || tab === undefined) return;
    this.capturePending = true;
    try {
      const result = (await client.send(
        "Page.captureScreenshot",
        { format: "jpeg", quality: SCREENSHOT_QUALITY },
        tab.sessionId,
      )) as { data?: string } | undefined;
      const data = result?.data;
      if (typeof data !== "string" || data === "") return;
      this.emitFrame({
        data,
        width: this.viewport.width,
        height: this.viewport.height,
        ts: this.now(),
      });
    } catch {
      // Pengambilan yang gagal tak boleh menghentikan screencast.
    } finally {
      this.capturePending = false;
    }
  }

  /** Jadwalkan detak pengaman: screenshot lagi bila halaman lama diam. */
  private scheduleTick(delayMs?: number): void {
    if (this.subscribers.size === 0) return;
    const last = this.lastFrameAt;
    const delay =
      delayMs ??
      (last === undefined
        ? this.idleScreenshotMs
        : Math.max(0, this.idleScreenshotMs - (this.now() - last)));
    this.cancelTick = this.schedule(() => this.handleTick(), delay);
  }

  /** Detak pengaman: kirim frame baru saat tak ada frame screencast terbaru. */
  private handleTick(): void {
    this.cancelTick = undefined;
    if (this.subscribers.size === 0) return;
    if (this.capturePending) {
      // Permintaan sebelumnya belum selesai; jangan menumpuk.
      this.scheduleTick(this.idleScreenshotMs);
      return;
    }
    const last = this.lastFrameAt;
    if (last !== undefined && this.now() - last < this.idleScreenshotMs) {
      this.scheduleTick();
      return;
    }
    void this.captureScreenshot().then(() => this.scheduleTick());
  }

  private onFrame(params: {
    data?: string;
    sessionId?: number;
    metadata?: { deviceWidth?: number; deviceHeight?: number };
  }): void {
    const client = this.client;
    const tab = this.activeTab();
    if (client !== undefined && tab !== undefined) {
      const ack = params.sessionId === undefined ? {} : { sessionId: params.sessionId };
      void client
        .send("Page.screencastFrameAck", ack, tab.sessionId)
        .catch(() => undefined);
    }
    if (typeof params.data !== "string" || params.data === "") return;
    this.emitFrame({
      data: params.data,
      width: this.viewport.width,
      height: this.viewport.height,
      ts: this.now(),
    });
  }

  /** Simpan frame terakhir lalu kirim ke semua pelanggan. */
  private emitFrame(frame: BrowserFrame): void {
    this.lastFrame = frame;
    this.lastFrameAt = frame.ts;
    for (const subscriber of this.subscribers) this.deliver(subscriber, frame);
  }

  /** Kirim frame; bila pelanggan lambat, hanya frame terbaru yang ditahan. */
  private deliver(subscriber: Subscriber, frame: BrowserFrame): void {
    if (subscriber.busy) {
      subscriber.pending = frame;
      return;
    }
    subscriber.busy = true;
    void (async () => {
      try {
        await subscriber.listener(frame);
      } catch {
        // Pelanggan yang rusak tidak boleh menghentikan screencast.
      }
      subscriber.busy = false;
      const next = subscriber.pending;
      subscriber.pending = undefined;
      if (next !== undefined) this.deliver(subscriber, next);
    })();
  }

  /**
   * Bunuh proses Chrome seketika (tanpa menunggu apa pun).
   *
   * Aman dipanggil berulang dan aman saat tak ada proses. Dipakai pada jalur
   * keluar proses (sinyal/`exit`) yang tak boleh menunggu.
   */
  killSync(): void {
    const proc = this.process;
    if (proc === undefined) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      // Proses sudah berhenti.
    }
  }

  /** Tutup browser: hentikan screencast, tutup soket, lalu bunuh Chrome. */
  async close(): Promise<void> {
    this.killSync();
    await this.stopScreencastOn(this.activeTab());
    this.subscribers.clear();
    this.stateListeners.clear();
    this.lastSentState = undefined;
    if (this.stateTimer !== undefined) {
      clearTimeout(this.stateTimer);
      this.stateTimer = undefined;
    }
    if (this.dialogTimer !== undefined) {
      clearTimeout(this.dialogTimer);
      this.dialogTimer = undefined;
    }
    this.agentCancel?.();
    this.agentCancel = undefined;
    this.agent = undefined;
    this.lastFrame = undefined;
    const client = this.client;
    this.client = undefined;
    this.tabRecords.clear();
    this.attaching.clear();
    this.activeId = undefined;
    this.canGoBack = false;
    this.canGoForward = false;
    this.lastDialog = undefined;
    this.pressedButtons.clear();
    this.inputTimes = [];
    if (client !== undefined) {
      try {
        client.close();
      } catch {
        // Soket sudah tertutup.
      }
    }
    const proc = this.process;
    this.process = undefined;
    if (proc !== undefined) await this.terminate(proc);
    this.removePidFile(this.profileDir());
  }

  /** Bunuh proses Chrome; tunggu keluar, lalu paksa. */
  private async terminate(proc: BrowserProcess): Promise<void> {
    try {
      proc.kill();
    } catch {
      // Proses sudah berhenti.
    }
    const exited = await Promise.race([
      proc.exited.then(
        () => true,
        () => true,
      ),
      Bun.sleep(this.closeTimeoutMs).then(() => false),
    ]);
    if (exited) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Proses sudah berhenti.
    }
  }

  /** Chrome berhenti sendiri; state kembali "mati" supaya bisa diyalakan ulang. */
  private handleExit(proc?: BrowserProcess): void {
    if (proc !== undefined && this.process === proc) {
      // Proses ini yang terakhir; berkas pid tak lagi berlaku.
      this.removePidFile(this.profileDir());
    }
    const client = this.client;
    this.client = undefined;
    this.tabRecords.clear();
    this.attaching.clear();
    this.activeId = undefined;
    this.canGoBack = false;
    this.canGoForward = false;
    this.lastDialog = undefined;
    this.screencastOn = false;
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.lastFrameAt = undefined;
    if (this.stateTimer !== undefined) {
      clearTimeout(this.stateTimer);
      this.stateTimer = undefined;
    }
    if (this.dialogTimer !== undefined) {
      clearTimeout(this.dialogTimer);
      this.dialogTimer = undefined;
    }
    this.agentCancel?.();
    this.agentCancel = undefined;
    this.agent = undefined;
    if (client !== undefined) {
      try {
        client.close();
      } catch {
        // Soket sudah tertutup.
      }
    }
  }
}