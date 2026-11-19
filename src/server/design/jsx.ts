/**
 * Konverter HTML -> JSX murni (tanpa I/O). Mengubah satu dokumen HTML menjadi
 * satu komponen React: isi `<body>` menjadi JSX, semua `<style>` menjadi CSS
 * global, `<script>` dan `<link rel=stylesheet>` dibuang. Tidak memecah komponen;
 * pemecahan dilakukan lapisan lain. Keluaran deterministik untuk input yang sama.
 */

/** Hasil konversi satu halaman menjadi JSX. */
export interface JsxResult {
  /** Isi JSX (satu akar elemen, fragment, atau `null`). */
  jsx: string;
  /** Gabungan semua `<style>` di dokumen, dipisah baris kosong. */
  css: string;
  /** Isi `<title>` (kosong bila tak ada). */
  title: string;
  /** Peringatan konversi (skrip dibuang, struktur diperbaiki, dst). */
  warnings: string[];
}

/** Elemen tanpa pasangan penutup; ditulis self-closing di JSX. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** Pemetaan nama atribut HTML yang tidak sekadar kebab->camel. */
const ATTR_MAP: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  readonly: "readOnly",
  maxlength: "maxLength",
  colspan: "colSpan",
  rowspan: "rowSpan",
  autocomplete: "autoComplete",
  autofocus: "autoFocus",
  crossorigin: "crossOrigin",
  srcset: "srcSet",
  contenteditable: "contentEditable",
  datetime: "dateTime",
  novalidate: "noValidate",
  enctype: "encType",
  autoplay: "autoPlay",
  playsinline: "playsInline",
  spellcheck: "spellCheck",
};

/** Entitas bernama yang diterjemahkan menjadi karakter. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  middot: "·",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rarr: "→",
  larr: "←",
};

type TokenType = "text" | "open" | "close" | "comment" | "decl" | "raw-style" | "raw-script" | "raw-text";

interface Token {
  type: TokenType;
  /** Teks mentah token; untuk open/close memuat `<...>` utuh. */
  raw: string;
  /** Nama tag (huruf kecil) untuk open/close/raw-text; undefined untuk teks. */
  name?: string;
}

interface ParsedAttr {
  name: string;
  /** `undefined` berarti atribut tanpa nilai (boolean). */
  value: string | undefined;
}

interface TextNode {
  kind: "text";
  text: string;
}

interface ElementNode {
  kind: "element";
  name: string;
  attrs: ParsedAttr[];
  children: Node[];
  /** Isi mentah `<pre>`/`<textarea>`; dipertahankan baris barunya. */
  rawText?: string;
  /** True bila elemen berada di dalam `<svg>`. */
  svg: boolean;
}

type Node = TextNode | ElementNode;

/** Konteks konversi: kumpulan peringatan dan tanda perbaikan struktur. */
interface Ctx {
  warnings: string[];
  fixed: boolean;
}

/** Mengambil nama tag dari teks `<...>`; undefined bila bukan tag. */
function tagName(raw: string): string | undefined {
  const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
  return match === null ? undefined : match[2]!.toLowerCase();
}

/** Mencari `>` penutup satu tag, melewati tanda `>` di dalam nilai berkuote. */
function findTagEnd(html: string, lt: number): number {
  let quote: string | null = null;
  for (let i = lt + 1; i < html.length; i += 1) {
    const char = html[i]!;
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * Pemindai linear dokumen menjadi token. Isi mentah `<script>`/`<style>`
 * dan `<pre>`/`<textarea>` disatukan dalam satu token agar tidak keliru
 * dipindai sebagai tag.
 */
function scan(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      tokens.push({ type: "text", raw: html.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ type: "text", raw: html.slice(i, lt) });

    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      if (close === -1) break;
      tokens.push({ type: "comment", raw: html.slice(lt, close + 3) });
      i = close + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const close = html.indexOf(">", lt + 2);
      if (close === -1) break;
      tokens.push({ type: "decl", raw: html.slice(lt, close + 1) });
      i = close + 1;
      continue;
    }

    const close = findTagEnd(html, lt);
    if (close === -1) break;
    const raw = html.slice(lt, close + 1);
    const name = tagName(raw);
    if (name === undefined) {
      // Bukan tag: "<" dianggap teks.
      tokens.push({ type: "text", raw: "<" });
      i = lt + 1;
      continue;
    }

    if (raw.startsWith("</")) {
      tokens.push({ type: "close", raw, name });
      i = close + 1;
      continue;
    }

    if (name === "script" || name === "style" || name === "pre" || name === "textarea") {
      const closeRe = new RegExp(`</${name}\\s*>`, "gi");
      closeRe.lastIndex = close + 1;
      const match = closeRe.exec(html);
      if (match === null) {
        tokens.push({
          type: name === "script" ? "raw-script" : name === "style" ? "raw-style" : "raw-text",
          raw: html.slice(lt),
          name,
        });
        i = html.length;
        continue;
      }
      tokens.push({
        type: name === "script" ? "raw-script" : name === "style" ? "raw-style" : "raw-text",
        raw: html.slice(lt, match.index + match[0].length),
        name,
      });
      i = match.index + match[0].length;
      continue;
    }

    tokens.push({ type: "open", raw, name });
    i = close + 1;
  }
  return tokens;
}

/** Mengambil substring atribut dari teks tag pembuka (tanpa `<`/`>`). */
function attrText(raw: string): string {
  let text = raw.slice(1);
  const match = /^\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(text);
  if (match !== null) text = text.slice(match[0]!.length);
  return text.replace(/\/?\s*>$/, "");
}

/** Memecah substring atribut menjadi daftar nama/nilai. */
function parseAttrs(raw: string): ParsedAttr[] {
  const attrs: ParsedAttr[] = [];
  let i = 0;
  const length = raw.length;
  while (i < length) {
    while (i < length && /\s/.test(raw[i]!)) i += 1;
    if (i >= length) break;
    const start = i;
    while (i < length && !/[\s=/>]/.test(raw[i]!)) i += 1;
    const name = raw.slice(start, i);
    if (name === "") {
      i += 1;
      continue;
    }
    while (i < length && /\s/.test(raw[i]!)) i += 1;
    if (raw[i] !== "=") {
      attrs.push({ name, value: undefined });
      continue;
    }
    i += 1;
    while (i < length && /\s/.test(raw[i]!)) i += 1;
    let value = "";
    if (raw[i] === '"' || raw[i] === "'") {
      const quote = raw[i]!;
      i += 1;
      const valueStart = i;
      while (i < length && raw[i] !== quote) i += 1;
      value = raw.slice(valueStart, i);
      if (raw[i] === quote) i += 1;
    } else {
      const valueStart = i;
      while (i < length && !/[\s>]/.test(raw[i]!)) i += 1;
      value = raw.slice(valueStart, i);
    }
    attrs.push({ name, value });
  }
  return attrs;
}

/** Menerjemahkan entitas HTML bernama dan numerik menjadi karakter. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = body.slice(hex ? 2 : 1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code)) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Mengubah kebab-case menjadi camelCase. */
function camel(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_whole, char: string) => char.toUpperCase());
}

/** Awalan besar untuk properti CSS berpengawal vendor. */
function capitalize(text: string): string {
  return text === "" ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** Nama properti CSS (style inline) menjadi kunci objek JSX. */
function stylePropToKey(prop: string): string {
  if (prop.startsWith("--")) return `"${prop}"`;
  if (prop.startsWith("-webkit-")) return `Webkit${capitalize(camel(prop.slice("-webkit-".length)))}`;
  if (prop.startsWith("-ms-")) return `ms${capitalize(camel(prop.slice("-ms-".length)))}`;
  return camel(prop);
}

/** Mengubah nilai atribut `style` menjadi literal objek JSX. */
function styleToObject(style: string): string | null {
  const declarations: string[] = [];
  for (const part of style.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    const prop = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (prop === "") continue;
    declarations.push(`${stylePropToKey(prop)}: ${JSON.stringify(value)}`);
  }
  return declarations.length === 0 ? null : `{ ${declarations.join(", ")} }`;
}

/** Meloloskan nilai atribut agar aman sebagai literal string JSX. */
function escapeAttrValue(value: string): string {
  return decodeEntities(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Meloloskan teks menjadi JSX: kurung kurawal dan `<`/`>` jadi ekspresi. */
function escapeText(text: string): string {
  const decoded = decodeEntities(text);
  let result = "";
  for (const char of decoded) {
    if (char === "{") result += '{"{"}';
    else if (char === "}") result += '{"}"}';
    else if (char === "<") result += '{"<"}';
    else if (char === ">") result += '{">"}';
    else result += char;
  }
  return result;
}

/**
 * Mengubah nama atribut HTML menjadi nama JSX. `undefined` berarti atribut
 * dibuang (mis. `xmlns:xlink`). Atribut `data-*` dan `aria-*` dibiarkan.
 */
function mapAttrName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === "xmlns:xlink") return undefined;
  if (lower === "xlink:href") return "href";
  if (lower.startsWith("data-") || lower.startsWith("aria-")) return lower;
  const mapped = ATTR_MAP[lower];
  if (mapped !== undefined) return mapped;
  if (lower.includes("-")) return camel(lower);
  // Pertahankan huruf asli agar atribut SVG berkamel (mis. viewBox) tak rusak.
  return name;
}

/** Merender atribut satu elemen; mengembalikan string dengan spasi di depan. */
function renderAttrs(name: string, attrs: ParsedAttr[], ctx: Ctx, textareaRaw: boolean): string {
  let out = "";
  for (const attr of attrs) {
    const lower = attr.name.toLowerCase();
    if (/^on[a-z]/i.test(lower)) {
      ctx.warnings.push(`Atribut kejadian "${attr.name}" dibuang.`);
      continue;
    }
    const mapped = mapAttrName(attr.name);
    if (mapped === undefined) continue;
    if (mapped === "style") {
      const object = styleToObject(attr.value ?? "");
      if (object !== null) out += ` style={${object}}`;
      continue;
    }
    let renamed = mapped;
    if (renamed === "checked") renamed = "defaultChecked";
    if (
      renamed === "value" &&
      (name === "input" || name === "textarea" || name === "select")
    ) {
      renamed = "defaultValue";
    }
    if (textareaRaw && renamed === "defaultValue") continue;
    if (attr.value === undefined) {
      out += ` ${renamed}`;
    } else {
      out += ` ${renamed}="${escapeAttrValue(attr.value)}"`;
    }
  }
  return out;
}

/** Merender satu elemen menjadi JSX berindentasi. */
function renderElement(node: ElementNode, depth: number, ctx: Ctx): string {
  const pad = "  ".repeat(depth);
  const textareaRaw = node.rawText !== undefined && node.name === "textarea";
  const attrs = renderAttrs(node.name, node.attrs, ctx, textareaRaw);
  const open = `<${node.name}${attrs}`;

  if (node.rawText !== undefined) {
    const inner = JSON.stringify(decodeEntities(node.rawText));
    if (node.name === "textarea") return `${pad}${open} defaultValue={${inner}} />`;
    return `${pad}${open}>{${inner}}</${node.name}>`;
  }

  const isVoid = VOID.has(node.name);
  if (isVoid || (node.children.length === 0 && node.svg)) return `${pad}${open} />`;
  if (node.children.length === 0) return `${pad}${open}></${node.name}>`;

  const onlyText = node.children.every((child) => child.kind === "text");
  if (onlyText) {
    const text = node.children
      .map((child) => escapeText((child as TextNode).text))
      .join("");
    return `${pad}${open}>${text}</${node.name}>`;
  }

  const childPad = "  ".repeat(depth + 1);
  const inner = node.children
    .map((child) =>
      child.kind === "text" ? `${childPad}${escapeText(child.text)}` : renderElement(child, depth + 1, ctx),
    )
    .join("\n");
  return `${pad}${open}>\n${inner}\n${pad}</${node.name}>`;
}

/** Menentukan token isi `<body>`; tanpa `<body>` pakai dokumen minus `<head>`. */
function bodyTokens(tokens: Token[]): Token[] {
  const bodyOpen = tokens.findIndex((token) => token.type === "open" && token.name === "body");
  if (bodyOpen !== -1) {
    let depth = 0;
    let end = tokens.length;
    for (let i = bodyOpen + 1; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.type === "open") {
        if (!VOID.has(token.name!) && !/\/\s*>$/.test(token.raw)) depth += 1;
      } else if (token.type === "close") {
        if (depth === 0 && token.name === "body") {
          end = i;
          break;
        }
        depth -= 1;
      }
    }
    return tokens.slice(bodyOpen + 1, end);
  }
  // Tanpa <body>: buang <head> beserta isinya, <html>, <title>, deklarasi.
  const out: Token[] = [];
  let inHead = false;
  for (const token of tokens) {
    if (token.type === "open" && token.name === "head") {
      inHead = true;
      continue;
    }
    if (token.type === "close" && token.name === "head") {
      inHead = false;
      continue;
    }
    if (inHead) continue;
    if (token.type === "open" && token.name === "html") continue;
    if (token.type === "close" && token.name === "html") continue;
    out.push(token);
  }
  return out;
}

/** Mengambil isi `<title>` pertama dari token. */
function extractTitle(tokens: Token[]): string {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.type === "open" && token.name === "body") return "";
    if (token.type !== "open" || token.name !== "title") continue;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const next = tokens[j]!;
      if (next.type === "close" && next.name === "title") return "";
      if (next.type === "text") return decodeEntities(next.raw).trim();
    }
  }
  return "";
}

/** Membangun pohon elemen dari token isi body, toleran terhadap tag rusak. */
function buildTree(tokens: Token[], ctx: Ctx): Node[] {
  const roots: Node[] = [];
  const stack: ElementNode[] = [];
  const push = (node: Node): void => {
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.children.push(node);
    else roots.push(node);
  };

  for (const token of tokens) {
    if (token.type === "text") {
      const raw = token.raw;
      if (/^\s*$/.test(raw) && /[\r\n]/.test(raw)) continue;
      push({ kind: "text", text: raw });
      continue;
    }
    if (token.type === "raw-text") {
      const name = token.name!;
      const gt = token.raw.indexOf(">");
      const attrs = parseAttrs(attrText(token.raw.slice(0, gt + 1)));
      const inner = token.raw.slice(gt + 1).replace(new RegExp(`</${name}\\s*>$`, "i"), "");
      push({ kind: "element", name, attrs, children: [], rawText: inner, svg: false });
      continue;
    }
    if (
      token.type === "raw-script" ||
      token.type === "raw-style" ||
      token.type === "comment" ||
      token.type === "decl"
    ) {
      continue;
    }
    if (token.type === "open") {
      const name = token.name!;
      if (name === "link" || name === "base" || name === "meta") continue;
      const parent = stack[stack.length - 1];
      const svg = parent !== undefined && (parent.name === "svg" || parent.svg);
      // <title> hanya bermakna di dalam svg (nama aksesibel); di luar itu dilewati.
      if (name === "title" && !svg) continue;
      const attrs = parseAttrs(attrText(token.raw));
      const node: ElementNode = { kind: "element", name, attrs, children: [], svg };
      push(node);
      if (!VOID.has(name) && !/\/\s*>$/.test(token.raw)) stack.push(node);
      continue;
    }
    // Token penutup.
    const name = token.name!;
    let index = -1;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i]!.name === name) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      // Penutup body/html/head/title tanpa pasangan di pohon bukan kerusakan.
      if (!["body", "html", "head", "title"].includes(name)) ctx.fixed = true;
      continue;
    }
    if (index !== stack.length - 1) ctx.fixed = true;
    stack.length = index;
  }
  if (stack.length > 0) ctx.fixed = true;
  return roots;
}

/** Mengubah dokumen HTML menjadi JSX satu akar. */
export function htmlToJsx(html: string): JsxResult {
  const ctx: Ctx = { warnings: [], fixed: false };
  const tokens = scan(html);

  for (const token of tokens) {
    if (token.type === "raw-script") ctx.warnings.push("Skrip dibuang.");
  }

  const title = extractTitle(tokens);
  const css = tokens
    .filter((token) => token.type === "raw-style")
    .map((token) => token.raw.replace(/<\/?style[^>]*>/gi, ""))
    .join("\n\n");

  const nodes = buildTree(bodyTokens(tokens), ctx);
  if (ctx.fixed) ctx.warnings.push("Struktur HTML diperbaiki.");

  let jsx: string;
  if (nodes.length === 0) {
    jsx = "null";
  } else if (nodes.length === 1 && nodes[0]!.kind === "element") {
    jsx = renderElement(nodes[0]!, 0, ctx);
  } else {
    const inner = nodes
      .map((node) => (node.kind === "text" ? `  ${escapeText(node.text)}` : renderElement(node, 1, ctx)))
      .join("\n");
    jsx = `<>\n${inner}\n</>`;
  }

  return { jsx, css, title, warnings: ctx.warnings };
}
