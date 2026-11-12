import type {
  WikiListing,
  WikiPage as ServerWikiPage,
  WikiPageEntry,
} from "../../server/wiki/wiki-service";

/** Rujukan halaman wiki: slug, judul, dan format isi. */
export type WikiPageRef = WikiPageEntry;

/** Isi satu halaman wiki beserta asal dan status potongnya. */
export type WikiPage = ServerWikiPage;

/** Proyek wiki yang cocok dengan remote origin folder sesi. */
export interface WikiProject {
  providerId: string;
  fullPath: string;
}

/** Daftar halaman hasil sinkronisasi atau pembacaan cache server. */
export type WikiSync = WikiListing;

/** Umur cache sebelum dianggap basi (10 menit). */
export const WIKI_STALE_MS = 10 * 60 * 1000;

/** Panjang isi kutipan sebelum dipotong. */
export const WIKI_QUOTE_MAX = 8000;

/**
 * Simpul daftar wiki. Daftar diratakan: judul grup (depth 0) disusul
 * halaman-halamannya (depth 1).
 */
export interface WikiNode {
  /** Slug halaman; kosong untuk judul grup. */
  slug: string;
  /** Judul halaman atau judul grup. */
  title: string;
  /** 0 untuk judul grup, 1 untuk halaman di dalam grup. */
  depth: number;
}

/** Hasil Pencocokan tautan di dalam isi wiki. */
export type WikiLink =
  | { kind: "wiki"; slug: string }
  | { kind: "external"; href: string }
  | { kind: "none" };

/** Status usia cache: label untuk manusia dan tanda basi. */
export interface WikiFreshness {
  label: string;
  stale: boolean;
}

/** Masukan kutipan ke komposer. */
export interface WikiQuoteInput {
  slug: string;
  title: string;
  content: string;
  commit: string;
  fetchedAt: string;
  /** Asal proyek, misalnya `grup/proyek`. */
  source: string;
}

/** Tautan markdown: `[teks](target)`. */
const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** Peta slug huruf kecil ke halaman; dipakai untuk pencocokan longgar. */
function pagesBySlug(pages: readonly WikiPageRef[]): Map<string, WikiPageRef> {
  const map = new Map<string, WikiPageRef>();
  for (const page of pages) map.set(page.slug.toLowerCase(), page);
  return map;
}

/**
 * Selesaikan tautan relatif terhadap folder halaman sekarang: buang
 * fragmen dan ekstensi `.md`, ubah spasi (`%20`) menjadi `-`, lalu gabung
 * dengan basis folder. Hasil `undefined` bila target tidak masuk akal.
 */
function resolveRelativeSlug(rawHref: string, currentSlug: string): string | undefined {
  let href = rawHref.trim();
  if (href === "") return undefined;

  const hash = href.indexOf("#");
  if (hash >= 0) href = href.slice(0, hash);
  if (href === "") return undefined;

  if (href.toLowerCase().endsWith(".md")) href = href.slice(0, -3);

  href = href.replace(/%20/gi, " ").replace(/\s+/g, "-");
  if (href === "") return undefined;

  const separator = currentSlug.lastIndexOf("/");
  const base = separator >= 0 ? currentSlug.slice(0, separator) : "";
  const segments = base === "" ? [] : base.split("/");

  for (const part of href.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }

  const slug = segments.join("/");
  return slug === "" ? undefined : slug;
}

/**
 * Tentukan jenis tautan: wiki (slug ada di daftar), eksternal, atau
 * tidak dikenal. Tidak pernah menghasilkan slug di luar daftar.
 */
export function resolveWikiLink(
  href: string,
  currentSlug: string,
  pages: readonly WikiPageRef[],
): WikiLink {
  const trimmed = href.trim();
  if (trimmed === "") return { kind: "none" };

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(trimmed);
  if (scheme !== null) {
    const name = scheme[1]!.toLowerCase();
    if (name === "http" || name === "https") return { kind: "external", href: trimmed };
    // Skema lain (javascript:, data:, mailto:) tidak dibuka.
    return { kind: "none" };
  }
  if (trimmed.startsWith("#")) return { kind: "none" };
  if (trimmed.startsWith("//")) return { kind: "external", href: trimmed };

  const slug = resolveRelativeSlug(trimmed, currentSlug);
  if (slug === undefined) return { kind: "none" };
  const page = pagesBySlug(pages).get(slug.toLowerCase());
  if (page === undefined) return { kind: "none" };
  return { kind: "wiki", slug: page.slug };
}

/** Saring halaman menurut judul atau slug; huruf besar diabaikan. */
export function filterPages(
  pages: readonly WikiPageRef[],
  query: string,
): WikiPageRef[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...pages];
  return pages.filter(
    (page) =>
      page.title.toLowerCase().includes(needle) || page.slug.toLowerCase().includes(needle),
  );
}

/** Halaman yang disebut _Sidebar, urut sesuai sidebar dan tanpa duplikat. */
function sidebarPages(
  sidebar: string,
  pages: readonly WikiPageRef[],
): WikiPageRef[] {
  const bySlug = pagesBySlug(pages);
  const result: WikiPageRef[] = [];
  const seen = new Set<string>();
  for (const match of sidebar.matchAll(LINK_PATTERN)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const slug = resolveRelativeSlug(raw, "");
    if (slug === undefined) continue;
    const page = bySlug.get(slug.toLowerCase());
    if (page === undefined || seen.has(page.slug)) continue;
    seen.add(page.slug);
    result.push(page);
  }
  return result;
}

/**
 * Susun daftar wiki. Halaman yang disebut _Sidebar jadi kelompok teratas
 * ("Dari _Sidebar"); halaman lain dikelompokkan menurut folder slug, dan
 * halaman tanpa folder masuk grup "Halaman".
 */
export function buildTree(
  pages: readonly WikiPageRef[],
  sidebar?: string,
): WikiNode[] {
  const nodes: WikiNode[] = [];
  const used = new Set<string>();

  if (sidebar !== undefined && sidebar.trim() !== "") {
    const ordered = sidebarPages(sidebar, pages);
    if (ordered.length > 0) {
      nodes.push({ slug: "", title: "Dari _Sidebar", depth: 0 });
      for (const page of ordered) {
        nodes.push({ slug: page.slug, title: page.title, depth: 1 });
        used.add(page.slug.toLowerCase());
      }
    }
  }

  const groups = new Map<string, WikiPageRef[]>();
  for (const page of pages) {
    if (used.has(page.slug.toLowerCase())) continue;
    const separator = page.slug.lastIndexOf("/");
    const folder = separator >= 0 ? page.slug.slice(0, separator) : "";
    const title = folder === "" ? "Halaman" : folder;
    const list = groups.get(title);
    if (list === undefined) groups.set(title, [page]);
    else list.push(page);
  }

  for (const [title, items] of groups) {
    nodes.push({ slug: "", title, depth: 0 });
    for (const page of items) nodes.push({ slug: page.slug, title: page.title, depth: 1 });
  }

  return nodes;
}

/** Label usia cache dan tanda basi (lebih dari 10 menit). */
export function freshness(fetchedAt: string, now: number): WikiFreshness {
  const stamp = Date.parse(fetchedAt);
  if (!Number.isFinite(stamp)) return { label: "waktu tidak diketahui", stale: true };
  const diff = Math.max(0, now - stamp);
  const minutes = Math.floor(diff / 60_000);
  let label: string;
  if (minutes < 1) label = "baru saja";
  else if (minutes < 60) label = `${minutes} menit lalu`;
  else {
    const hours = Math.floor(minutes / 60);
    label = hours < 24 ? `${hours} jam lalu` : `${Math.floor(hours / 24)} hari lalu`;
  }
  return { label, stale: diff > WIKI_STALE_MS };
}

/** Nilai atribut teks: kutip di dalam tanda petik dihindari. */
function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Teks kutipan berlabel untuk ditempel ke komposer. Isi dipotong dan
 * penutup `</wiki` dinetralkan supaya kutipan tidak keluar dari labelnya.
 */
export function quoteText(input: WikiQuoteInput): string {
  const source = input.source.replace(/\/+$/, "");
  const slug = input.slug.replace(/^\/+/, "");
  const where = source === "" ? slug : `${source}/${slug}`;
  const commit = input.commit.slice(0, 7);
  const stamp = Date.parse(input.fetchedAt);
  const tanggal = Number.isFinite(stamp)
    ? new Date(stamp).toISOString().slice(0, 10)
    : "tidak diketahui";

  let content = input.content;
  if (content.length > WIKI_QUOTE_MAX) {
    content = `${content.slice(0, WIKI_QUOTE_MAX)}\n[dipotong]`;
  }
  content = content.replace(/<\/wiki/gi, "<\\/wiki");

  return `<wiki sumber="${attribute(where)}" commit="${attribute(commit)}" tanggal="${tanggal}">\n${content}\n</wiki>`;
}

/** Pesan ramah untuk galat wiki menurut status server. */
export function wikiErrorMessage(status: number, message?: string): string {
  const text = message?.trim();
  if (status === 404) {
    return "Tidak ada proyek GitLab dari remote origin folder ini. Tambahkan penyedia GitLab di halaman Workspace atau pakai folder yang remote-nya GitLab.";
  }
  if (status === 409) {
    return "Wiki proyek ini belum disinkronkan. Tekan Segarkan untuk mengambil halamannya.";
  }
  if (status === 502) {
    return text === undefined || text === "" ? "Gagal mengambil wiki dari server." : text;
  }
  if (status === 503) {
    return "Wiki dimatikan. Nyalakan wiki di konfigurasi Jejak dan tambahkan penyedia GitLab di halaman Workspace.";
  }
  return text === undefined || text === "" ? "Permintaan wiki gagal." : text;
}
