import { clampZoom, type Rect } from "./design-canvas";
import type { FrameBounds, FrameStyle } from "./design-protocol";

/**
 * Alat Pilih: data pilihan/hover dari frame dan teks konteks untuk komposer.
 * Murni: tanpa DOM, tanpa jaringan. Semua data dari frame dianggap tidak
 * tepercaya dan hanya dipakai sebagai teks.
 */

export interface Selection {
  slug: string;
  title: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
  bounds: FrameBounds;
  style: FrameStyle;
}

export interface Hover {
  slug: string;
  tag: string;
  label: string;
  bounds: FrameBounds;
}

const MAX_TEXT_CHARS = 200;
const MAX_HTML_CHARS = 2048;

const STYLE_ROWS: readonly { key: keyof FrameStyle; label: string }[] = [
  { key: "color", label: "Warna" },
  { key: "backgroundColor", label: "Latar" },
  { key: "fontFamily", label: "Font" },
  { key: "fontSize", label: "Ukuran font" },
  { key: "fontWeight", label: "Bobot" },
  { key: "padding", label: "Padding" },
  { key: "margin", label: "Margin" },
  { key: "borderRadius", label: "Radius" },
  { key: "display", label: "Tampilan" },
];

/** Kotak elemen di koordinat dunia: posisi frame ditambah kotak di dalamnya. */
export function overlayRect(frame: Rect, bounds: FrameBounds): Rect {
  return {
    x: frame.x + bounds.x,
    y: frame.y + bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

/** Ketebalan garis dunia agar tampak 2 px di layar pada zoom berapa pun. */
export function overlayBorder(zoom: number): number {
  return 2 / clampZoom(zoom);
}

/** Baris gaya terhitung dengan urutan tetap; nilai kosong dilewati. */
export function styleRows(style: FrameStyle): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  for (const { key, label } of STYLE_ROWS) {
    const value = style[key];
    if (value === undefined) continue;
    const rapi = value.trim();
    if (rapi === "") continue;
    rows.push({ label, value: rapi });
  }
  return rows;
}

/** Teks chip di atas elemen, mis. `Tombol · button`. */
export function chipText(tag: string, label: string): string {
  return `${label} · ${tag}`;
}

/** Berkas halaman untuk satu slug. */
export function pageFile(slug: string): string {
  return `design/pages/${slug}.html`;
}

function rapikan(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Pagar backtick yang lebih panjang daripada deret terpanjang di dalam teks. */
function pagar(text: string, minimal: number): string {
  let terpanjang = 0;
  let jalan = 0;
  for (const karakter of text) {
    if (karakter === "`") {
      jalan += 1;
      if (jalan > terpanjang) terpanjang = jalan;
    } else {
      jalan = 0;
    }
  }
  return "`".repeat(Math.max(minimal, terpanjang + 1));
}

function kodeSebaris(text: string): string {
  const fence = pagar(text, 1);
  const perluSpasi = text.startsWith("`") || text.endsWith("`");
  return perluSpasi ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/**
 * Teks Markdown Bahasa Indonesia untuk ditempel ke komposer: ringkasan
 * elemen terpilih, gaya, HTML, lalu kalimat pembuka yang menunggu permintaan
 * pengguna.
 */
export function elementContext(sel: Selection, pageFile: string): string {
  const baris: string[] = [];
  baris.push(`Elemen terpilih di halaman "${sel.title}" (${pageFile})`);
  baris.push("");
  baris.push(`- Selector: ${kodeSebaris(sel.selector)}`);
  baris.push(`- Tag: ${sel.tag}`);
  const teks = rapikan(sel.text).slice(0, MAX_TEXT_CHARS);
  if (teks !== "") baris.push(`- Teks: ${teks}`);
  baris.push(
    `- Ukuran: ${Math.round(sel.bounds.width)} x ${Math.round(sel.bounds.height)}`,
  );
  for (const row of styleRows(sel.style)) {
    baris.push(`- ${row.label}: ${row.value}`);
  }
  baris.push("");
  const html = sel.html.slice(0, MAX_HTML_CHARS);
  const fence = pagar(html, 3);
  baris.push(`${fence}html`);
  baris.push(html);
  baris.push(fence);
  baris.push("");
  baris.push("Ubah elemen ini: ");
  return baris.join("\n");
}
