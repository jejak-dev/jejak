import type { AgentEvent } from "./events";

const MAX_OUTPUT = 4000;
const TRUNCATION_SUFFIX = "\n…(dipotong)";
const NON_TEXT_PLACEHOLDER = "[bukan teks]";

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

function renderToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        return block.text;
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

function mapResult(message: Record<string, unknown>): AgentEvent[] {
  const subtype = typeof message.subtype === "string" ? message.subtype : "";
  const ok = subtype === "success" && message.is_error !== true;

  const event: Extract<AgentEvent, { type: "result" }> = { type: "result", ok };

  if (ok && typeof message.result === "string") {
    event.summary = message.result;
  }

  if (!ok) {
    const errors = message.errors;
    if (Array.isArray(errors) && errors.length > 0) {
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
    default:
      return [];
  }
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
