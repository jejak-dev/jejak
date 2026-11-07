import type { AgentEvent } from "../../server/agent/events";
import { ApiError } from "./api";

export interface SseFrame {
  id?: string;
  event: string;
  data: string;
}

export type SessionStreamItem =
  | { kind: "event"; seq: number; event: AgentEvent }
  | { kind: "end"; status: string };

export interface FollowOptions {
  after?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  baseUrl?: string;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_DELAYS = [500, 1000, 2000, 5000];
const FRAME_SEPARATOR = /\r?\n\r?\n/;

function parseFrame(raw: string): SseFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "id") {
      id = value;
    } else if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0 && event === undefined) {
    return undefined;
  }

  const frame: SseFrame = {
    event: event === undefined || event === "" ? "message" : event,
    data: dataLines.join("\n"),
  };
  if (id !== undefined) {
    frame.id = id;
  }
  return frame;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const match = FRAME_SEPARATOR.exec(buffer);
        if (match === null) break;
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const frame = parseFrame(raw);
        if (frame !== undefined) {
          yield frame;
        }
      }
    }
    decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream sudah selesai atau dibatalkan.
    }
  }
}

function parseSeq(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseEndStatus(data: string): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed === "object" && parsed !== null) {
      const status = (parsed as { status?: unknown }).status;
      if (typeof status === "string") return status;
    }
  } catch {
    // Data bukan JSON; pakai status bawaan.
  }
  return "selesai";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export async function* followSession(
  id: string,
  options: FollowOptions = {},
): AsyncIterable<SessionStreamItem> {
  const baseUrl = options.baseUrl ?? "";
  const doFetch: typeof fetch = options.fetch ?? globalThis.fetch;
  const signal = options.signal;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const url = `${baseUrl}/api/sessions/${encodeURIComponent(id)}/events`;

  let lastSeq = options.after ?? 0;
  let retryIndex = 0;

  const sleep = (ms: number): Promise<void> => {
    if (options.sleep !== undefined) return options.sleep(ms);
    return new Promise<void>((resolve) => {
      if (isAborted(signal)) {
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", finish, { once: true });
    });
  };

  const nextDelay = (): number => {
    if (retryDelays.length === 0) return 0;
    const index = Math.min(retryIndex, retryDelays.length - 1);
    const delay = retryDelays[index] ?? 0;
    retryIndex += 1;
    return delay;
  };

  let removeAbortListener: (() => void) | undefined;
  const abortPromise: Promise<"aborted"> | undefined =
    signal === undefined
      ? undefined
      : new Promise<"aborted">((resolve) => {
          if (signal.aborted) {
            resolve("aborted");
            return;
          }
          const onAbort = (): void => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        });

  try {
    while (true) {
      if (isAborted(signal)) return;

      let response: Response;
      try {
        const headers: Record<string, string> = {};
        if (lastSeq > 0) {
          headers["last-event-id"] = String(lastSeq);
        }
        response = await doFetch(url, { headers, signal });
      } catch {
        if (isAborted(signal)) return;
        await sleep(nextDelay());
        continue;
      }

      if (!response.ok) {
        const serverError = await response
          .json()
          .then((data: unknown) => {
            if (typeof data === "object" && data !== null) {
              const message = (data as { error?: unknown }).error;
              if (typeof message === "string" && message !== "") return message;
            }
            return undefined;
          })
          .catch(() => undefined);
        throw new ApiError(
          serverError ?? `permintaan gagal (status ${response.status})`,
          response.status,
        );
      }

      if (response.body === null) {
        await sleep(nextDelay());
        continue;
      }

      try {
        const iterator = parseSse(response.body)[Symbol.asyncIterator]();
        while (true) {
          const pending = iterator.next();
          void pending.catch(() => undefined);
          const raced =
            abortPromise === undefined ? await pending : await Promise.race([pending, abortPromise]);

          if (raced === "aborted") {
            void iterator.return?.(undefined);
            return;
          }
          if (raced.done === true) break;

          const frame = raced.value;
          if (frame.event === "agent") {
            const seq = parseSeq(frame.id);
            if (seq === undefined || seq <= lastSeq) continue;
            let event: AgentEvent;
            try {
              event = JSON.parse(frame.data) as AgentEvent;
            } catch {
              continue;
            }
            lastSeq = seq;
            retryIndex = 0;
            yield { kind: "event", seq, event };
          } else if (frame.event === "end") {
            yield { kind: "end", status: parseEndStatus(frame.data) };
            return;
          }
        }
      } catch {
        if (isAborted(signal)) return;
        // Koneksi putus di tengah stream; sambung ulang di bawah.
      }

      if (isAborted(signal)) return;
      await sleep(nextDelay());
    }
  } finally {
    removeAbortListener?.();
  }
}
