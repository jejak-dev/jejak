import type { AgentEvent } from "./events";

const MAX_OUTPUT = 4000;
const TRUNCATION_SUFFIX = "\n…(dipotong)";
const NON_TEXT_PLACEHOLDER = "[bukan teks]";
/** Penanda gambar pada event yang disimpan; data gambar tak ikut tersimpan. */
const IMAGE_PLACEHOLDER = "[gambar]";
/** Panjang minimum rentetan base64 yang dianggap data biner (bukan teks biasa). */
const MIN_BASE64_RUN = 1024;
/** Penanda data biner yang dibuang dari event yang disimpan. */
const BINARY_PLACEHOLDER = "[data biner dipotong]";
/** Rentetan base64 panjang; diganti penanda supaya tak mengembang di database. */
const BASE64_RUN = new RegExp(`[A-Za-z0-9+/]{${MIN_BASE64_RUN},}={0,2}`, "g");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}${TRUNCATION_SUFFIX}` : text;
}

function readParentToolUseId(source: Record<string, unknown>): string | undefined {
  const value = source.parent_tool_use_id;
  return typeof value === "string" ? value : undefined;
}

type ChildEvent = Extract<AgentEvent, { type: "text" | "text_delta" | "thinking" | "tool_call" }>;

function withParent(event: ChildEvent, parentToolUseId: string | undefined): ChildEvent {
  return parentToolUseId === undefined ? event : { ...event, parentToolUseId };
}

function mapAssistantBlock(
  block: Record<string, unknown>,
  parentToolUseId: string | undefined,
): ChildEvent | null {
  const blockType = block.type;

  if (blockType === "text") {
    const text = block.text;
    if (!isNonEmptyString(text)) return null;
    return withParent({ type: "text", text }, parentToolUseId);
  }

  if (blockType === "thinking") {
    const thinking = block.thinking;
    if (!isNonEmptyString(thinking)) return null;
    return withParent({ type: "thinking", text: thinking }, parentToolUseId);
  }

  if (blockType === "tool_use") {
    const id = block.id;
    const name = block.name;
    if (typeof id !== "string" || typeof name !== "string") return null;
    return withParent({ type: "tool_call", id, name, input: block.input }, parentToolUseId);
  }

  return null;
}

/**
 * Penanda singkat untuk blok gambar.
 *
 * Data gambar (base64) tak pernah ikut ke event yang disimpan; yang tersimpan
 * cuma penanda ukuran. Bentuk blok bisa berupa MCP (`data`) atau API
 * (`source.data`); keduanya ditangani.
 */
function imagePlaceholder(block: Record<string, unknown>): string {
  const sumber = block.source;
  const data =
    typeof block.data === "string"
      ? block.data
      : isRecord(sumber) && typeof sumber.data === "string"
        ? sumber.data
        : undefined;
  if (data === undefined || data === "") return IMAGE_PLACEHOLDER;
  const kib = Math.max(1, Math.round((data.length * 3) / 4 / 1024));
  return `[gambar ${kib} KB]`;
}

/**
 * Buang data biner panjang dari teks event yang disimpan.
 *
 * Kalau gambar sampai sebagai teks (misalnya runtime meratakan blok gambar
 * jadi base64), data itu tak boleh mengembang di database. Teks asli tetap
 * sampai ke model; yang dibuang hanya salinan pada event.
 *
 * Rangkaian huruf panjang (mis. satu kata panjang) tak dianggap biner: rentetan
 * harus memuat angka atau tanda base64.
 */
function buangBiner(text: string): string {
  return text.replace(BASE64_RUN, (rentetan) =>
    /[0-9+/]/.test(rentetan) ? BINARY_PLACEHOLDER : rentetan,
  );
}

function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") return buangBiner(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return buangBiner(block.text);
      }
      if (isRecord(block) && block.type === "image") {
        return imagePlaceholder(block);
      }
      return NON_TEXT_PLACEHOLDER;
    })
    .join("\n");
}

function mapAssistant(message: Record<string, unknown>): AgentEvent[] {
  const inner = message.message;
  if (!isRecord(inner) || !Array.isArray(inner.content)) return [];

  const parentToolUseId = readParentToolUseId(message);
  const events: AgentEvent[] = [];
  for (const block of inner.content) {
    if (!isRecord(block)) continue;
    const event = mapAssistantBlock(block, parentToolUseId);
    if (event !== null) events.push(event);
  }
  return events;
}

/** Potongan teks dari `includePartialMessages`; hanya delta teks yang dipakai. */
function mapStreamEvent(message: Record<string, unknown>): AgentEvent[] {
  const event = message.event;
  if (!isRecord(event) || event.type !== "content_block_delta") return [];
  const delta = event.delta;
  if (!isRecord(delta) || delta.type !== "text_delta" || !isNonEmptyString(delta.text)) return [];
  return [withParent({ type: "text_delta", text: delta.text }, readParentToolUseId(message))];
}

function mapUser(message: Record<string, unknown>): AgentEvent[] {
  const inner = message.message;
  if (!isRecord(inner) || !Array.isArray(inner.content)) return [];

  const events: AgentEvent[] = [];
  for (const block of inner.content) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const toolUseId = block.tool_use_id;
    if (typeof toolUseId !== "string") continue;
    events.push({
      type: "tool_result",
      id: toolUseId,
      output: truncate(renderToolResultContent(block.content)),
      isError: block.is_error === true,
    });
  }
  return events;
}

/** Pesan untuk giliran "sukses" yang ternyata tak memproses apa pun. */
const EMPTY_TURN_ERROR =
  "Giliran kosong: agent tidak memproses pesan (sesi mungkin terlalu besar atau gagal dilanjutkan). Kirim ulang pesan, atau mulai sesi baru bila berulang.";
/** Awalan teks hasil yang sebenarnya galat kompaksi otomatis. */
const COMPACTION_ERROR_PREFIX = "error during compaction";
/** Panjang maksimum teks galat kompaksi yang diteruskan. */
const MAX_COMPACTION_ERROR = 500;

function mapResult(message: Record<string, unknown>): AgentEvent[] {
  const subtype = typeof message.subtype === "string" ? message.subtype : "";
  const resultText = typeof message.result === "string" ? message.result : undefined;
  const numTurns = typeof message.num_turns === "number" ? message.num_turns : undefined;
  const usageRecord = message.usage;
  const outputTokens =
    isRecord(usageRecord) && typeof usageRecord.output_tokens === "number"
      ? usageRecord.output_tokens
      : undefined;

  let ok = subtype === "success" && message.is_error !== true;
  let forcedError: string | undefined;

  if (ok) {
    const trimmed = resultText?.trim() ?? "";
    if (trimmed.toLowerCase().startsWith(COMPACTION_ERROR_PREFIX)) {
      // SDK mencatat galat kompaksi sebagai hasil sukses; itu bukan jawaban.
      ok = false;
      forcedError = (resultText ?? "").slice(0, MAX_COMPACTION_ERROR);
    } else if (
      trimmed === "" &&
      (numTurns === undefined || numTurns === 0) &&
      (outputTokens === undefined || outputTokens === 0)
    ) {
      // Sukses tanpa teks, tanpa giliran, dan tanpa keluaran: prompt tak diproses.
      ok = false;
      forcedError = EMPTY_TURN_ERROR;
    }
  }

  const event: Extract<AgentEvent, { type: "result" }> = { type: "result", ok };

  if (ok && resultText !== undefined) {
    event.summary = resultText;
  }

  if (!ok) {
    const errors = message.errors;
    if (forcedError !== undefined) {
      event.error = forcedError;
    } else if (Array.isArray(errors) && errors.length > 0) {
      event.error = errors.map((error) => String(error)).join("; ");
    } else {
      event.error = `eksekusi gagal (${subtype})`;
    }
  }

  if (typeof message.total_cost_usd === "number") event.costUsd = message.total_cost_usd;
  if (typeof message.num_turns === "number") event.numTurns = message.num_turns;

  const usage = message.usage;
  if (isRecord(usage)) {
    if (typeof usage.input_tokens === "number") event.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") event.outputTokens = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === "number") event.cacheReadTokens = usage.cache_read_input_tokens;
    if (typeof usage.cache_creation_input_tokens === "number") event.cacheWriteTokens = usage.cache_creation_input_tokens;
  }

  return [event];
}

/** Panjang maksimum teks saran yang dikirim ke klien. */
const MAX_SUGGESTION = 300;

/**
 * Saran prompt berikutnya dari SDK (`prompt_suggestion`).
 *
 * Teks dipotong supaya chip di komposer tetap satu baris; saran kosong
 * diabaikan.
 */
function mapPromptSuggestion(message: Record<string, unknown>): AgentEvent[] {
  const suggestion = message.suggestion;
  if (typeof suggestion !== "string") return [];
  const text = suggestion.trim();
  if (text === "") return [];
  return [{ type: "suggestion", text: text.slice(0, MAX_SUGGESTION) }];
}

export function mapSdkMessage(message: unknown): AgentEvent[] {
  if (!isRecord(message)) return [];

  switch (message.type) {
    case "system":
      if (message.subtype !== "init") return [];
      if (typeof message.session_id !== "string") return [];
      const session: Extract<AgentEvent, { type: "session" }> = {
        type: "session",
        sessionId: message.session_id,
      };
      if (typeof message.model === "string" && message.model !== "") session.model = message.model;
      return [session];
    case "stream_event":
      return mapStreamEvent(message);
    case "assistant":
      return mapAssistant(message);
    case "user":
      return mapUser(message);
    case "result":
      return mapResult(message);
    case "prompt_suggestion":
      return mapPromptSuggestion(message);
    default:
      return [];
  }
}

/**
 * `uuid` pesan assistant agent utama (bukan subagent); jangkar percakapan.
 * `undefined` bila pesan tidak punya uuid atau berasal dari subagent.
 */
export function assistantUuidOf(message: unknown): string | undefined {
  if (!isRecord(message) || message.type !== "assistant") return undefined;
  if (readParentToolUseId(message) !== undefined) return undefined;
  const uuid = message.uuid;
  return typeof uuid === "string" && uuid !== "" ? uuid : undefined;
}

/**
 * Ukuran konteks dari pesan assistant agent utama (bukan subagent): token masuk,
 * cache, dan keluaran pada panggilan model itu. `undefined` bila tak ada usage.
 */
export function contextTokensOf(message: unknown): number | undefined {
  if (isRecord(message) && message.type === "system" && message.subtype === "compact_boundary") {
    // Setelah compact ukuran konteks berubah; 0 berarti "belum diketahui" (klien menyembunyikan cincin).
    const meta = isRecord(message.compact_metadata) ? message.compact_metadata : {};
    const post = meta.post_tokens;
    return typeof post === "number" && post > 0 ? post : 0;
  }
  if (!isRecord(message) || message.type !== "assistant") return undefined;
  if (readParentToolUseId(message) !== undefined) return undefined;
  const inner = message.message;
  if (!isRecord(inner) || !isRecord(inner.usage)) return undefined;
  const usage = inner.usage;
  const part = (key: string): number => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const total =
    part("input_tokens") +
    part("cache_read_input_tokens") +
    part("cache_creation_input_tokens") +
    part("output_tokens");
  return total > 0 ? total : undefined;
}

/**
 * Perkiraan token per panggilan dari usage giliran: (masuk + cache) / jumlah
 * giliran. `undefined` bila tak bisa dihitung.
 */
function approxTokensPerCall(usage: {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  numTurns?: number;
}): number | undefined {
  const turns = usage.numTurns;
  if (typeof turns !== "number" || turns <= 0) return undefined;
  const total = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return total > 0 ? Math.round(total / turns) : undefined;
}

/**
 * Koreksi ukuran konteks per pesan terhadap jendela dan rata-rata usage.
 *
 * Gateway sebagian provider melaporkan usage per pesan yang menggelembung
 * (mis. cache dibaca ulang tiap langkah), sehingga cincin konteks bisa
 * melewati jendela. Bila angka per pesan mustahil — melebihi jendela atau
 * jauh di atas rata-rata per panggilan — pakai perkiraan rata-rata dan tandai
 * `estimated`. Tanpa perkiraan yang masuk akal, angka mustahil dibuang.
 */
export function reconcileContextTokens(
  perMessage: number | undefined,
  usage: {
    inputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    numTurns?: number;
  },
  window?: number,
): { tokens: number | undefined; estimated: boolean } {
  const approx = approxTokensPerCall(usage);
  if (perMessage === undefined) return { tokens: approx, estimated: approx !== undefined };
  const overWindow = window !== undefined && perMessage > window;
  const overAverage = approx !== undefined && perMessage > 2.5 * approx;
  if (overWindow || overAverage) {
    return approx !== undefined
      ? { tokens: approx, estimated: true }
      : { tokens: undefined, estimated: false };
  }
  return { tokens: perMessage, estimated: false };
}

/** Jendela konteks terbesar dari `modelUsage` pesan hasil SDK. */
export function contextWindowOf(message: unknown): number | undefined {
  if (!isRecord(message) || message.type !== "result" || !isRecord(message.modelUsage)) {
    return undefined;
  }
  let best: number | undefined;
  for (const entry of Object.values(message.modelUsage)) {
    if (!isRecord(entry)) continue;
    const window = entry.contextWindow;
    if (typeof window === "number" && window > 0 && (best === undefined || window > best)) {
      best = window;
    }
  }
  return best;
}
