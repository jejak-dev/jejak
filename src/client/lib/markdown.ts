/**
 * Parser markdown kecil dan murni (tanpa DOM) untuk teks agen.
 * Tidak mengenal HTML: semua tag diperlakukan sebagai teks biasa.
 * Sumber di atas MAX_SOURCE_CHARS dirender apa adanya tanpa parsing.
 */

export type MdAlign = "left" | "center" | "right" | null;

export type MdInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MdInline[] }
  | { type: "em"; children: MdInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: MdInline[] }
  | { type: "break" };

export type MdBlock =
  | { type: "paragraph"; children: MdInline[] }
  | { type: "heading"; level: number; children: MdInline[] }
  | { type: "code"; lang?: string; text: string }
  | { type: "list"; ordered: boolean; start?: number; items: MdBlock[][] }
  | { type: "quote"; children: MdBlock[] }
  | { type: "rule" }
  | { type: "table"; header: MdInline[][]; aligns: MdAlign[]; rows: MdInline[][][] };

const MAX_SOURCE_CHARS = 200_000;
const MAX_NESTING = 6;
const MAX_INLINE_DEPTH = 8;
/** Batas pencarian penutup agar input buruk tetap linear dan aman. */
const MAX_EMPHASIS_SPAN = 1_000;
const MAX_AUTOLINK_SPAN = 2_048;
const MAX_LINK_URL_SPAN = 2_048;

export interface MarkdownOptions {
  /** Izinkan tautan relatif (tanpa skema) tetap dirender sebagai tautan. */
  relativeLinks?: boolean;
}

export function parseMarkdown(source: string, options?: MarkdownOptions): MdBlock[] {
  if (source.length === 0) return [];
  // Teks sangat panjang: jangan diparse, perlakukan sebagai pre polos.
  if (source.length > MAX_SOURCE_CHARS) {
    return [{ type: "code", text: source }];
  }
  const normalized = source.replace(/\r\n?/g, "\n");
  return parseBlocks(normalized.split("\n"), 0, options?.relativeLinks === true);
}

export function safeHref(url: string, allowRelative = false): string | undefined {
  const trimmed = url.trim();
  if (trimmed === "") return undefined;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(trimmed);
  if (scheme === null) {
    if (!allowRelative) return undefined;
    // Tautan relatif: "//" (protocol-relative) dan backslash ditolak.
    if (trimmed.startsWith("//") || trimmed.startsWith("\\")) return undefined;
    return trimmed;
  }
  const name = scheme[1]!.toLowerCase();
  if (name === "http" || name === "https" || name === "mailto") return trimmed;
  return undefined;
}

/* ---------- Blok ---------- */

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function leadingSpaces(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count += 1;
  return count;
}

function stripIndent(line: string, amount: number): string {
  let count = 0;
  while (count < amount && count < line.length && line[count] === " ") count += 1;
  return line.slice(count);
}

interface Fence {
  char: string;
  length: number;
  info: string;
}

function matchFence(line: string): Fence | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return undefined;
  const fence = match[2]!;
  return { char: fence[0]!, length: fence.length, info: match[3]!.trim() };
}

function isClosingFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (match === null) return false;
  const run = match[1]!;
  return run[0] === fence.char && run.length >= fence.length;
}

function matchHeading(line: string): { level: number; content: string } | undefined {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  if (match === null) return undefined;
  const content = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: match[1]!.length, content };
}

function isRule(line: string): boolean {
  return /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

function isQuoteLine(line: string): boolean {
  return /^ {0,3}>/.test(line);
}

interface ListMarker {
  ordered: boolean;
  start: number;
  indent: number;
  contentIndent: number;
  content: string;
}

function matchListMarker(line: string): ListMarker | undefined {
  const bullet = /^( {0,3})([-+*])([ \t]+)(.*)$/.exec(line);
  if (bullet !== null) {
    const indent = bullet[1]!.length;
    const spacing = bullet[3]!;
    return {
      ordered: false,
      start: 1,
      indent,
      contentIndent: indent + 1 + Math.min(spacing.length, 4),
      content: bullet[4]!,
    };
  }
  const ordered = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/.exec(line);
  if (ordered !== null) {
    const indent = ordered[1]!.length;
    const spacing = ordered[4]!;
    return {
      ordered: true,
      start: Number.parseInt(ordered[2]!, 10),
      indent,
      contentIndent:
        indent + ordered[2]!.length + 1 + Math.min(spacing.length, 4),
      content: ordered[5]!,
    };
  }
  return undefined;
}

function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "\\" && text[i + 1] === "|") {
      cell += "|";
      i += 1;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function isDelimiterRow(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function alignmentOf(cell: string): MdAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  if (line === undefined) return false;
  if (matchFence(line) !== undefined) return true;
  if (matchHeading(line) !== undefined) return true;
  if (isRule(line)) return true;
  if (isQuoteLine(line)) return true;
  if (matchListMarker(line) !== undefined) return true;
  if (
    line.includes("|") &&
    index + 1 < lines.length &&
    isDelimiterRow(lines[index + 1]!)
  ) {
    return true;
  }
  return false;
}

function parseBlocks(lines: string[], depth: number, relative: boolean): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = matchFence(line);
    if (fence !== undefined) {
      i = parseFence(lines, i, fence, blocks);
      continue;
    }

    const heading = matchHeading(line);
    if (heading !== undefined) {
      blocks.push({
        type: "heading",
        level: heading.level,
        children: parseInline(heading.content, 0, false, relative),
      });
      i += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length) {
      const header = splitTableRow(line);
      const delimiter = splitTableRow(lines[i + 1]!);
      if (header.length === delimiter.length && isDelimiterRow(lines[i + 1]!)) {
        i = parseTable(lines, i, header, delimiter, blocks, relative);
        continue;
      }
    }

    if (isQuoteLine(line)) {
      i = parseQuote(lines, i, depth, blocks, relative);
      continue;
    }

    const marker = matchListMarker(line);
    if (marker !== undefined) {
      i = parseList(lines, i, marker, depth, blocks, relative);
      continue;
    }

    i = parseParagraph(lines, i, blocks, relative);
  }
  return blocks;
}

function parseFence(
  lines: string[],
  start: number,
  fence: Fence,
  blocks: MdBlock[],
): number {
  const content: string[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isClosingFence(line, fence)) {
      i += 1;
      break;
    }
    content.push(line);
    i += 1;
  }
  const text = content.join("\n");
  const lang = fence.info === "" ? undefined : fence.info.split(/\s+/)[0];
  blocks.push(lang === undefined ? { type: "code", text } : { type: "code", lang, text });
  return i;
}

function parseQuote(
  lines: string[],
  start: number,
  depth: number,
  blocks: MdBlock[],
  relative: boolean,
): number {
  const inner: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const match = /^ {0,3}> ?(.*)$/.exec(line);
    if (match !== null) {
      inner.push(match[1]!);
      i += 1;
      continue;
    }
    if (isBlank(line) && i + 1 < lines.length && isQuoteLine(lines[i + 1]!)) {
      inner.push("");
      i += 1;
      continue;
    }
    break;
  }
  if (depth >= MAX_NESTING) {
    const joined = inner.join("\n");
    // Sisa penanda kutipan yang melampaui batas ikut menjadi teks.
    blocks.push({
      type: "paragraph",
      children: [{ type: "text", text: joined.replace(/^ {0,3}> ?/gm, "") }],
    });
  } else {
    blocks.push({ type: "quote", children: parseBlocks(inner, depth + 1, relative) });
  }
  return i;
}

function parseList(
  lines: string[],
  start: number,
  marker: ListMarker,
  depth: number,
  blocks: MdBlock[],
  relative: boolean,
): number {
  if (depth >= MAX_NESTING) {
    // Terlalu dalam: semua baris daftar menjadi satu paragraf teks.
    const raw: string[] = [];
    let i = start;
    while (i < lines.length && !isBlank(lines[i]!)) {
      raw.push(lines[i]!);
      i += 1;
    }
    blocks.push({
      type: "paragraph",
      children: [{ type: "text", text: raw.join("\n") }],
    });
    return i;
  }

  const baseIndent = marker.indent;
  const itemLines: string[][] = [];
  let current: string[] = [marker.content];
  const flush = (): void => {
    itemLines.push(current);
  };

  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i]!;

    if (isBlank(line)) {
      let next = i;
      while (next < lines.length && isBlank(lines[next]!)) next += 1;
      if (next >= lines.length) {
        i = next;
        break;
      }
      const nextLine = lines[next]!;
      const nextMarker = matchListMarker(nextLine);
      if (
        nextMarker !== undefined &&
        nextMarker.ordered === marker.ordered &&
        nextMarker.indent <= baseIndent
      ) {
        flush();
        current = [nextMarker.content];
        i = next + 1;
        continue;
      }
      if (leadingSpaces(nextLine) >= marker.contentIndent) {
        current.push("");
        i += 1;
        continue;
      }
      break;
    }

    const sibling = matchListMarker(line);
    if (
      sibling !== undefined &&
      sibling.ordered === marker.ordered &&
      sibling.indent <= baseIndent
    ) {
      flush();
      current = [sibling.content];
      i += 1;
      continue;
    }
    if (
      sibling !== undefined &&
      sibling.ordered !== marker.ordered &&
      sibling.indent <= baseIndent
    ) {
      break;
    }

    current.push(stripIndent(line, marker.contentIndent));
    i += 1;
  }
  flush();

  const items = itemLines.map((item) => parseBlocks(item, depth + 1, relative));
  blocks.push(
    marker.ordered
      ? { type: "list", ordered: true, start: marker.start, items }
      : { type: "list", ordered: false, items },
  );
  return i;
}

function parseTable(
  lines: string[],
  start: number,
  headerCells: string[],
  delimiterCells: string[],
  blocks: MdBlock[],
  relative: boolean,
): number {
  const aligns = delimiterCells.map(alignmentOf);
  const rows: MdInline[][][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line) || !line.includes("|")) break;
    const cells = splitTableRow(line);
    const row: MdInline[][] = [];
    for (let column = 0; column < headerCells.length; column += 1) {
      row.push(parseInline(cells[column] ?? "", 0, false, relative));
    }
    rows.push(row);
    i += 1;
  }
  const table: MdBlock = {
    type: "table",
    header: headerCells.map((cell) => parseInline(cell, 0, false, relative)),
    aligns,
    rows,
  };
  blocks.push(table);
  return i;
}

function parseParagraph(
  lines: string[],
  start: number,
  blocks: MdBlock[],
  relative: boolean,
): number {
  const parts: string[] = [];
  let hardBreak = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) break;
    if (i > start && startsBlock(lines, i)) break;

    let content = line.replace(/^ {0,3}/, "");
    let hard = false;
    if (/[ \t]{2,}$/.test(content)) {
      content = content.replace(/[ \t]+$/, "");
      hard = true;
    } else if (content.endsWith("\\")) {
      content = content.slice(0, -1);
      hard = true;
    }

    if (parts.length > 0) parts.push(hardBreak ? "\n" : " ");
    parts.push(content);
    hardBreak = hard;
    i += 1;
  }
  blocks.push({
    type: "paragraph",
    children: parseInline(parts.join(""), 0, false, relative),
  });
  return i;
}

/* ---------- Inline ---------- */

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

function findEmphasis(
  source: string,
  start: number,
  char: string,
  double: boolean,
): { content: string; end: number } | undefined {
  const openLength = double ? 2 : 1;
  const contentStart = start + openLength;
  if (contentStart >= source.length) return undefined;
  if (source[contentStart] === char) return undefined;
  const delimiter = char.repeat(openLength);

  if (char === "_" && isWordChar(source[start - 1])) return undefined;

  let search = contentStart;
  const limit = Math.min(source.length, contentStart + MAX_EMPHASIS_SPAN);
  while (search < limit) {
    const found = source.indexOf(delimiter, search);
    if (found === -1 || found > limit) return undefined;
    if (found === contentStart) return undefined;
    if (char === "_" && isWordChar(source[found + openLength])) {
      // `_` di dalam kata (mis. snake_case) bukan penutup miring.
      search = found + 1;
      continue;
    }
    if (!double && (source[found - 1] === char || source[found + 1] === char)) {
      search = found + 1;
      continue;
    }
    const content = source.slice(contentStart, found);
    if (content === "" || content.startsWith(" ") || content.endsWith(" ")) {
      search = found + openLength;
      continue;
    }
    return { content, end: found + openLength };
  }
  return undefined;
}

function findClosingParen(source: string, start: number): number {
  let depth = 0;
  const limit = Math.min(source.length, start + MAX_LINK_URL_SPAN);
  for (let i = start; i < limit; i += 1) {
    const char = source[i]!;
    if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function isUrlBoundary(previous: string | undefined): boolean {
  return previous === undefined || !/[A-Za-z0-9_/:.@%+-]/.test(previous);
}

function trimUrl(url: string): string {
  let result = url;
  while (result.length > 0 && /[.,;:!?'"*]/.test(result[result.length - 1]!)) {
    result = result.slice(0, -1);
  }
  let open = 0;
  let close = 0;
  for (const char of result) {
    if (char === "(") open += 1;
    else if (char === ")") close += 1;
  }
  while (close > open && result.endsWith(")")) {
    result = result.slice(0, -1);
    close -= 1;
  }
  return result;
}

function parseInline(
  source: string,
  depth: number,
  insideLink: boolean,
  relative: boolean,
): MdInline[] {
  if (source === "") return [];
  if (depth > MAX_INLINE_DEPTH) return [{ type: "text", text: source }];

  const out: MdInline[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer !== "") {
      out.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  // Posisi `](` berikutnya di-cache supaya deretan `[` yatim tetap linear.
  let nextLinkOpen = -1;
  let noMoreLinks = false;
  const linkOpenAtOrAfter = (from: number): number => {
    if (noMoreLinks) return -1;
    if (nextLinkOpen !== -1 && nextLinkOpen >= from) return nextLinkOpen;
    nextLinkOpen = source.indexOf("](", from);
    if (nextLinkOpen === -1) noMoreLinks = true;
    return nextLinkOpen;
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i]!;

    if (char === "\\") {
      const next = source[i + 1];
      if (next !== undefined && /[\\`*_{}\[\]()#+\-.!>|~]/.test(next)) {
        buffer += next;
        i += 2;
        continue;
      }
      buffer += char;
      i += 1;
      continue;
    }

    if (char === "\n") {
      flush();
      out.push({ type: "break" });
      i += 1;
      continue;
    }

    if (char === "`") {
      let run = 1;
      while (run < 5 && source[i + run] === "`") run += 1;
      if (run > 4) {
        // Deret pagar sangat panjang: perlakukan sebagai teks, bukan kode inline.
        buffer += source[i];
        i += 1;
        continue;
      }
      const delimiter = "`".repeat(run);
      const close = source.indexOf(delimiter, i + run);
      if (close === -1) {
        buffer += delimiter;
        i += run;
        continue;
      }
      let text = source.slice(i + run, close).replace(/\n/g, " ");
      if (text.length >= 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") {
        text = text.slice(1, -1);
      }
      flush();
      out.push({ type: "code", text });
      i = close + run;
      continue;
    }

    if (char === "*" || char === "_") {
      const double = source[i + 1] === char;
      const emphasis = findEmphasis(source, i, char, double);
      if (emphasis !== undefined) {
        flush();
        out.push(
          double
            ? { type: "strong", children: parseInline(emphasis.content, depth + 1, insideLink, relative) }
            : { type: "em", children: parseInline(emphasis.content, depth + 1, insideLink, relative) },
        );
        i = emphasis.end;
        continue;
      }
      buffer += char;
      i += 1;
      continue;
    }

    if (char === "!" && source[i + 1] === "[" && linkOpenAtOrAfter(i + 2) !== -1) {
      const open = linkOpenAtOrAfter(i + 2);
      if (open !== -1) {
        const close = findClosingParen(source, open + 2);
        if (close !== -1) {
          // Gambar tidak pernah dirender sebagai <img>: hanya teks alt.
          buffer += source.slice(i + 2, open);
          i = close + 1;
          continue;
        }
      }
      buffer += char;
      i += 1;
      continue;
    }

    if (char === "[" && !insideLink && linkOpenAtOrAfter(i + 1) !== -1) {
      const open = linkOpenAtOrAfter(i + 1);
      if (open === -1) {
        buffer += char;
        i += 1;
        continue;
      }
      const close = findClosingParen(source, open + 2);
      if (close === -1) {
        buffer += source.slice(i, open + 2);
        i = open + 2;
        continue;
      }
      const label = source.slice(i + 1, open);
      const href = safeHref(source.slice(open + 2, close), relative);
      flush();
      if (href === undefined) {
        out.push({ type: "text", text: source.slice(i, close + 1) });
      } else {
        out.push({ type: "link", href, children: parseInline(label, depth + 1, true, relative) });
      }
      i = close + 1;
      continue;
    }

    if (char === "<" && !insideLink) {
      const auto = matchAutolink(source, i);
      if (auto !== undefined) {
        flush();
        out.push({
          type: "link",
          href: auto.href,
          children: [{ type: "text", text: auto.url }],
        });
        i = auto.end;
        continue;
      }
      buffer += char;
      i += 1;
      continue;
    }

    if (
      char === "h" &&
      !insideLink &&
      isUrlBoundary(source[i - 1]) &&
      (source.startsWith("http://", i) || source.startsWith("https://", i))
    ) {
      let end = i;
      while (end < source.length && !/[\s<>]/.test(source[end]!)) end += 1;
      const url = trimUrl(source.slice(i, end));
      const href = safeHref(url);
      flush();
      if (href === undefined) {
        buffer += source.slice(i, i + url.length);
      } else {
        out.push({ type: "link", href, children: [{ type: "text", text: url }] });
      }
      i += url.length;
      continue;
    }

    buffer += char;
    i += 1;
  }
  flush();
  return out;
}

function matchAutolink(
  source: string,
  start: number,
): { href: string; url: string; end: number } | undefined {
  const limit = Math.min(source.length, start + MAX_AUTOLINK_SPAN);
  let end = start + 1;
  while (end < limit) {
    const char = source[end]!;
    if (char === ">") break;
    if (char === "<" || char === " " || char === "\t" || char === "\n") {
      return undefined;
    }
    end += 1;
  }
  if (end >= limit || source[end] !== ">") return undefined;
  const url = source.slice(start + 1, end);
  const href = safeHref(url);
  if (href === undefined) return undefined;
  return { href, url, end: end + 1 };
}
