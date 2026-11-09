/**
 * Penyamar rahasia. Fungsi murni: tidak melakukan I/O, tidak log, tidak
 * menyimpan state global.
 *
 * Mengganti hanya bagian rahasia dengan `[disembunyikan:<jenis>]`, bukan
 * seluruh baris. `hits` hanya memuat jenis dan jumlah, tidak pernah nilai
 * asli atau potongannya.
 */

export interface RedactHit {
  kind: string;
  count: number;
}

export interface RedactOptions {
  /** Nilai literal tambahan yang harus disamarkan (mis. nilai dari .env). Nilai < 8 karakter diabaikan. */
  extraValues?: readonly string[];
}

export interface RedactResult {
  text: string;
  hits: RedactHit[];
}

const PLACEHOLDER_PREFIX = "[disembunyikan:";

function placeholder(kind: string): string {
  return `${PLACEHOLDER_PREFIX}${kind}]`;
}

interface HitAccumulator {
  original: string;
  hits: Map<string, { count: number; firstIndex: number }>;
}

function addHit(acc: HitAccumulator, kind: string, count: number, firstIndex: number): void {
  if (count <= 0) return;
  const existing = acc.hits.get(kind);
  if (existing) {
    existing.count += count;
    if (firstIndex < existing.firstIndex) existing.firstIndex = firstIndex;
    return;
  }
  acc.hits.set(kind, { count, firstIndex });
}

/** Nilai yang sudah disamarkan atau jelas merupakan placeholder. */
function isPlaceholderValue(value: string): boolean {
  if (value.startsWith(PLACEHOLDER_PREFIX)) return true;
  const lower = value.toLowerCase();
  if (lower === "changeme") return true;
  if (lower.startsWith("your-")) return true;
  if (value.startsWith("<") && value.endsWith(">")) return true;
  if (value.startsWith("${")) return true;
  if (/^x{8,}$/i.test(value)) return true;
  if (/^\*{8,}$/.test(value)) return true;
  if (/(?:example|dummy|placeholder)/i.test(value)) return true;
  return false;
}

/**
 * Menerapkan satu pola global. `replace` mengembalikan teks pengganti, atau
 * `null` bila kemunculan itu tidak boleh diubah (tidak dihitung sebagai hit).
 */
function applyPattern(
  acc: HitAccumulator,
  text: string,
  kind: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string | null,
): string {
  pattern.lastIndex = 0;
  let result = "";
  let last = 0;
  let count = 0;
  let firstIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    const replacement = replace(match);
    if (replacement === null) continue;
    if (firstIndex < 0) {
      const found = acc.original.indexOf(match[0]);
      firstIndex = found >= 0 ? found : match.index;
    }
    result += text.slice(last, match.index) + replacement;
    last = match.index + match[0].length;
    count += 1;
  }
  if (count === 0) return text;
  result += text.slice(last);
  addHit(acc, kind, count, firstIndex);
  return result;
}

const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

/** Blok PEM penuh; blok tanpa END diganti sampai akhir teks. */
function redactPem(acc: HitAccumulator, text: string): string {
  PEM_BEGIN.lastIndex = 0;
  let result = "";
  let last = 0;
  let count = 0;
  let firstIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = PEM_BEGIN.exec(text)) !== null) {
    const end = PEM_END;
    end.lastIndex = PEM_BEGIN.lastIndex;
    const endMatch = end.exec(text);
    const stop = endMatch ? endMatch.index + endMatch[0].length : text.length;
    if (firstIndex < 0) firstIndex = match.index;
    result += text.slice(last, match.index) + placeholder("kunci privat");
    last = stop;
    count += 1;
    PEM_BEGIN.lastIndex = stop;
    if (stop >= text.length) break;
  }
  if (count === 0) return text;
  result += text.slice(last);
  addHit(acc, "kunci privat", count, firstIndex);
  return result;
}

// Skema URL dibatasi panjangnya agar tidak ada pengulangan tanpa batas.
const URL_CREDENTIAL =
  /([A-Za-z][A-Za-z0-9+.-]{0,16}?:\/\/[^\s/?#@:]+:)([^\s/?#@]+)(@[^\s/?#]+)/g;
const BEARER = /\bBearer\s+([A-Za-z0-9._~+/-]{8,}={0,})/gi;
const API_KEY = /\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}/g;
const GITHUB_TOKEN = /\b(?:ghp_|gho_|ghs_|ghu_|github_pat_)[A-Za-z0-9_]{8,}/g;
const GITLAB_TOKEN = /\bglpat-[A-Za-z0-9_-]{8,}/g;
const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{8,}/g;

// Pemindaian manual `nama = nilai`: lebih aman dari backtracking daripada
// regex dengan prefiks `[A-Za-z0-9_.-]*` yang tak terbatas.
const CREDENTIAL_KEYWORD = /password|passwd|secret|token|api[_-]?key/gi;
const NAME_CHAR = /[A-Za-z0-9_.-]/;
const MAX_NAME = 96;
const MAX_VALUE = 512;

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\r" || char === "\n";
}

function redactCredentialAssignments(
  acc: HitAccumulator,
  text: string,
): string {
  const replacements: Replacement[] = [];
  let firstValue: string | null = null;
  // Pemindaian berjalan kiri ke kanan, jadi penggantian selalu tidak tumpang
  // tindih dan berurutan; cukup bandingkan dengan batas akhir terakhir.
  let lastEnd = -1;

  CREDENTIAL_KEYWORD.lastIndex = 0;
  let keyword: RegExpExecArray | null;
  while ((keyword = CREDENTIAL_KEYWORD.exec(text)) !== null) {
    const keywordStart = keyword.index;
    const keywordEnd = keywordStart + keyword[0].length;

    let nameStart = keywordStart;
    while (
      nameStart > 0 &&
      keywordStart - nameStart < MAX_NAME &&
      NAME_CHAR.test(text.charAt(nameStart - 1))
    ) {
      nameStart -= 1;
    }
    let pos = keywordEnd;
    while (pos < text.length && pos - keywordEnd < MAX_NAME && NAME_CHAR.test(text.charAt(pos))) {
      pos += 1;
    }

    // Nama boleh dalam tanda petik: "api_key": "nilai".
    const nameQuote = text.charAt(pos);
    if (nameQuote === '"' || nameQuote === "'") {
      if (text.charAt(nameStart - 1) !== nameQuote) continue;
      pos += 1;
    }

    while (pos < text.length && isSpace(text.charAt(pos))) pos += 1;
    const separator = text.charAt(pos);
    if (separator !== "=" && separator !== ":") continue;
    pos += 1;
    while (pos < text.length && isSpace(text.charAt(pos))) pos += 1;
    if (pos >= text.length) continue;

    const valueQuote = text.charAt(pos);
    let valueStart: number;
    let valueEnd: number;
    if (valueQuote === '"' || valueQuote === "'") {
      const close = text.indexOf(valueQuote, pos + 1);
      if (close < 0) continue;
      valueStart = pos + 1;
      valueEnd = Math.min(close, valueStart + MAX_VALUE);
    } else {
      valueStart = pos;
      valueEnd = pos;
      while (valueEnd < text.length && valueEnd - valueStart < MAX_VALUE) {
        const char = text.charAt(valueEnd);
        if (isSpace(char) || char === '"' || char === "'" || char === "`") break;
        valueEnd += 1;
      }
    }

    const value = text.slice(valueStart, valueEnd);
    if (value.length < 8) continue;
    if (isPlaceholderValue(value)) continue;
    if (valueStart < lastEnd) continue;

    replacements.push({ start: valueStart, end: valueEnd, text: placeholder("kredensial") });
    lastEnd = valueEnd;
    if (firstValue === null) firstValue = value;
  }

  if (replacements.length === 0) return text;

  replacements.sort((a, b) => a.start - b.start);
  let result = "";
  let last = 0;
  for (const replacement of replacements) {
    result += text.slice(last, replacement.start) + replacement.text;
    last = replacement.end;
  }
  result += text.slice(last);

  const found = firstValue === null ? -1 : acc.original.indexOf(firstValue);
  addHit(acc, "kredensial", replacements.length, found >= 0 ? found : 0);
  return result;
}

function redactExtraValues(
  acc: HitAccumulator,
  text: string,
  values: readonly string[],
): string {
  const candidates = [...new Set(values)]
    .filter(
      (value) =>
        value.length >= 8 &&
        !/^\d+$/.test(value) &&
        !/^(?:true|false|null)$/i.test(value),
    )
    .sort((a, b) => b.length - a.length);

  for (const value of candidates) {
    let index = text.indexOf(value);
    if (index < 0) continue;
    const originalIndex = acc.original.indexOf(value);
    let result = "";
    let last = 0;
    let count = 0;
    while (index >= 0) {
      result += text.slice(last, index) + placeholder("nilai .env");
      last = index + value.length;
      count += 1;
      index = text.indexOf(value, last);
    }
    result += text.slice(last);
    text = result;
    addHit(acc, "nilai .env", count, originalIndex >= 0 ? originalIndex : 0);
  }
  return text;
}

export function redactSecrets(text: string, options?: RedactOptions): RedactResult {
  const acc: HitAccumulator = { original: text, hits: new Map() };

  let output = redactPem(acc, text);

  output = applyPattern(acc, output, "URL berkredensial", URL_CREDENTIAL, (match) => {
    const password = match[2] ?? "";
    if (password.startsWith(PLACEHOLDER_PREFIX)) return null;
    return `${match[1] ?? ""}${placeholder("URL berkredensial")}${match[3] ?? ""}`;
  });

  output = applyPattern(acc, output, "token Bearer", BEARER, (match) => {
    const value = match[1] ?? "";
    if (value.startsWith(PLACEHOLDER_PREFIX)) return null;
    const prefix = match[0].slice(0, match[0].length - value.length);
    return `${prefix}${placeholder("token Bearer")}`;
  });

  output = applyPattern(acc, output, "kunci API", API_KEY, () => placeholder("kunci API"));
  output = applyPattern(acc, output, "token GitHub", GITHUB_TOKEN, () =>
    placeholder("token GitHub"),
  );
  output = applyPattern(acc, output, "token GitLab", GITLAB_TOKEN, () =>
    placeholder("token GitLab"),
  );
  output = applyPattern(acc, output, "kunci AWS", AWS_KEY, () => placeholder("kunci AWS"));
  output = applyPattern(acc, output, "token Slack", SLACK_TOKEN, () =>
    placeholder("token Slack"),
  );

  output = redactCredentialAssignments(acc, output);

  if (options?.extraValues && options.extraValues.length > 0) {
    output = redactExtraValues(acc, output, options.extraValues);
  }

  const hits = [...acc.hits.entries()]
    .sort((a, b) => a[1].firstIndex - b[1].firstIndex)
    .map(([kind, entry]) => ({ kind, count: entry.count }));

  return { text: output, hits };
}

/**
 * Mengambil nilai yang layak disamarkan dari isi berkas .env sederhana.
 * Tidak melempar pada masukan aneh.
 */
export function collectEnvValues(envFileText: string): string[] {
  try {
    if (typeof envFileText !== "string") return [];
    const seen = new Set<string>();
    const values: string[] = [];

    for (const rawLine of envFileText.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      line = line.replace(/^export\s+/, "").trim();
      const equals = line.indexOf("=");
      if (equals <= 0) continue;
      const key = line.slice(0, equals).trim();
      if (key.length === 0) continue;

      let value = line.slice(equals + 1).trim();
      if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value.charAt(0);
        const close = value.indexOf(quote, 1);
        value = close > 0 ? value.slice(1, close) : value.slice(1);
      } else {
        const comment = value.indexOf(" #");
        if (comment >= 0) value = value.slice(0, comment).trim();
      }

      if (value.length < 8) continue;
      if (/^\d+$/.test(value)) continue;
      if (/^(?:true|false|null|undefined)$/i.test(value)) continue;
      if (isPlaceholderValue(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      values.push(value);
    }

    return values;
  } catch {
    return [];
  }
}
