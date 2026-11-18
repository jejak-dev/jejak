/**
 * Persiapan pratinjau Markdown untuk berkas di repo (mis. README).
 * Mengubah HTML dasar yang lazim di README menjadi Markdown agar parser kecil
 * di markdown.ts bisa menampilkannya rapi. Murni, linear, tidak melempar.
 */

/** Tag HTML yang dikenali. Selain ini dibiarkan apa adanya (autolink, `a < b`). */
const KNOWN_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "audio", "b", "blockquote", "br",
  "caption", "center", "code", "col", "colgroup", "dd", "del", "details", "div",
  "dl", "dt", "em", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "head", "header", "hr", "html", "i", "iframe", "img", "input",
  "ins", "kbd", "li", "main", "nav", "ol", "p", "picture", "pre", "s", "section",
  "small", "source", "span", "strike", "strong", "sub", "summary", "sup", "svg",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "video",
]);

/** Tag blok: dihapus dan diganti baris kosong sebagai pemisah. */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "audio", "blockquote", "caption", "center", "col",
  "colgroup", "dd", "details", "div", "dl", "dt", "figcaption", "figure", "footer",
  "form", "head", "header", "hr", "html", "iframe", "input", "li", "main", "nav",
  "ol", "p", "picture", "pre", "section", "source", "summary", "svg", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul", "video",
]);

const TAG_OPEN = /^<(\/?)([A-Za-z][A-Za-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/;
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=]+))/g;
const MAX_ALT_DEPTH = 8;
const MAX_TAG_LENGTH = 512;

/** Nilai atribut (tanpa membedakan huruf besar-kecil); undefined bila tak ada. */
function attribute(raw: string, name: string): string | undefined {
  ATTRIBUTE.lastIndex = 0;
  let match = ATTRIBUTE.exec(raw);
  while (match !== null) {
    if (match[1]!.toLowerCase() === name) {
      return match[2] ?? match[3] ?? match[4] ?? "";
    }
    match = ATTRIBUTE.exec(raw);
  }
  return undefined;
}

/** Ubah satu tag menjadi Markdown; `undefined` berarti tag dibiarkan apa adanya. */
function tagToMarkdown(closing: boolean, name: string, attrs: string): string | undefined {
  switch (name) {
    case "br":
      return closing ? undefined : "\n";
    case "img": {
      if (closing) return undefined;
      const alt = (attribute(attrs, "alt") ?? "gambar").trim() || "gambar";
      const src = (attribute(attrs, "src") ?? "").trim();
      return `![${alt}](${src === "" ? "#" : src})`;
    }
    case "a":
      // Tag <a> pembuka ditangani transformHtml; penutup tanpa pasangan dibuang.
      return closing ? "" : undefined;
    case "b":
    case "strong":
      return "**";
    case "i":
    case "em":
      return "*";
    case "code":
      return "`";
    case "li":
      return closing ? "\n" : "\n- ";
    default:
      if (/^h[1-6]$/.test(name)) {
        if (closing) return "\n\n";
        return `\n\n${"#".repeat(Number(name[1]))} `;
      }
      if (BLOCK_TAGS.has(name)) return "\n\n";
      return "";
  }
}

function transformHtml(source: string, depth: number): string {
  if (depth > MAX_ALT_DEPTH) return source;
  const lower = source.toLowerCase();
  let out = "";
  let i = 0;
  while (i < source.length) {
    const next = source.indexOf("<", i);
    if (next === -1) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, next);
    i = next;

    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end === -1) {
        out += source.slice(i);
        break;
      }
      i = end + 3;
      continue;
    }

    const match = TAG_OPEN.exec(source.slice(i, i + MAX_TAG_LENGTH));
    if (match === null || !KNOWN_TAGS.has(match[2]!.toLowerCase())) {
      out += "<";
      i += 1;
      continue;
    }
    const closing = match[1] === "/";
    const name = match[2]!.toLowerCase();
    const attrs = match[3] ?? "";
    const tagEnd = i + match[0].length;

    if (name === "a" && !closing) {
      const closeAt = lower.indexOf("</a>", tagEnd);
      if (closeAt !== -1) {
        // Isi tautan diproses lebih dulu: gambar di dalam tautan menjadi chip.
        const inner = transformHtml(source.slice(tagEnd, closeAt), depth + 1).trim();
        const href = (attribute(attrs, "href") ?? "").trim();
        // Gambar di dalam tautan: parser tak mendukung tautan bersarang gambar, jadi tautan dilepas.
        if (inner !== "") out += href === "" || inner.includes("![") ? inner : `[${inner}](${href})`;
        i = closeAt + "</a>".length;
        continue;
      }
    }

    const replacement = tagToMarkdown(closing, name, attrs);
    if (replacement === undefined) {
      out += "<";
      i += 1;
      continue;
    }
    out += replacement;
    i = tagEnd;
  }
  return out;
}

/**
 * Siapkan teks Markdown untuk pratinjau berkas: HTML dasar diubah menjadi
 * Markdown, isi pagar kode dibiarkan persis, baris kosong beruntun dirapikan.
 */
export function prepareMarkdownPreview(text: string): string {
  if (text === "") return "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    out.push(...transformHtml(buffer.join("\n"), 0).split("\n"));
    buffer = [];
  };

  for (const line of lines) {
    if (fence !== undefined) {
      out.push(line);
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close !== null && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open !== null) {
      flush();
      fence = open[1]!;
      out.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();

  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}
