import { useEffect, useRef, useState } from "preact/hooks";
import type { TimelineItem } from "../lib/timeline";
import { formatCost, formatCount, statusTone } from "../lib/format";

export interface TimelineProps {
  items: TimelineItem[];
  connection: string;
}

const MAX_INPUT_CHARS = 2000;
const PIN_THRESHOLD_PX = 80;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function prettyInput(input: unknown): string {
  if (input === undefined) return "";
  try {
    const json = JSON.stringify(input, null, 2);
    return json === undefined ? String(input) : clip(json, MAX_INPUT_CHARS);
  } catch {
    return clip(String(input), MAX_INPUT_CHARS);
  }
}

function depthStyle(depth: number): Record<string, string> | undefined {
  return depth > 0 ? { marginLeft: `${Math.min(depth, 3) * 16}px` } : undefined;
}

export function Timeline({ items, connection }: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || !pinned) return;
    element.scrollTop = element.scrollHeight;
  }, [items, pinned]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setPinned(distance <= PIN_THRESHOLD_PX);
  };

  const scrollToBottom = (): void => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    setPinned(true);
  };

  return (
    <div class="jk-timeline">
      <div
        class="jk-timeline-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        aria-live="polite"
        aria-label="Timeline sesi"
      >
        {items.length === 0 && <p class="jk-empty-line">Belum ada aktivitas.</p>}

        {items.map((item, index) => {
          switch (item.kind) {
            case "user":
              return (
                <div class="jk-row jk-row-user" key={index}>
                  <div class="jk-bubble-user">{item.text}</div>
                </div>
              );

            case "thinking":
              return (
                <details class="jk-thinking" key={index} style={depthStyle(item.depth)}>
                  <summary>Berpikir</summary>
                  <p class="jk-pre-wrap">{item.text}</p>
                </details>
              );

            case "text":
              return (
                <div class="jk-text" key={index} style={depthStyle(item.depth)}>
                  {item.text}
                </div>
              );

            case "tool": {
              const tone = statusTone(item.status);
              const input = prettyInput(item.input);
              return (
                <details class="jk-tool" key={index} style={depthStyle(item.depth)}>
                  <summary class="jk-tool-summary">
                    <span class="jk-tool-name">{item.name}</span>
                    {item.summary !== "" && (
                      <span class="jk-mono jk-tool-call">{item.summary}</span>
                    )}
                    <span class={`jk-badge jk-badge-${tone}`}>{item.status}</span>
                  </summary>
                  <div class="jk-tool-body">
                    {input !== "" && (
                      <section>
                        <h4 class="jk-tool-label">Masukan</h4>
                        <pre class="jk-pre jk-pre-input">{input}</pre>
                      </section>
                    )}
                    {item.output !== undefined && (
                      <section>
                        <h4 class="jk-tool-label">Hasil</h4>
                        <pre class="jk-pre jk-pre-output">{clip(item.output, 20000)}</pre>
                      </section>
                    )}
                  </div>
                </details>
              );
            }

            case "error":
              return (
                <div class="jk-danger-box" key={index} role="status">
                  {item.message}
                </div>
              );

            case "result":
              return (
                <footer class="jk-result" key={index}>
                  <span class={`jk-badge jk-badge-${item.ok ? "success" : "danger"}`}>
                    {item.ok ? "ok" : "gagal"}
                  </span>
                  <span class="jk-result-stat">
                    Token masuk: {formatCount(item.inputTokens)}
                  </span>
                  <span class="jk-result-stat">
                    Token keluar: {formatCount(item.outputTokens)}
                  </span>
                  <span class="jk-result-stat">Biaya: {formatCost(item.costUsd)}</span>
                  <span class="jk-result-stat">Giliran: {formatCount(item.numTurns)}</span>
                  {!item.ok && item.error !== undefined && (
                    <span class="jk-result-error">{item.error}</span>
                  )}
                </footer>
              );

            default:
              return null;
          }
        })}
      </div>

      <div class="jk-timeline-foot">
        {connection === "menyambung" && (
          <p class="jk-note" role="status">
            Menyambung ulang…
          </p>
        )}
        {!pinned && (
          <button type="button" class="jk-button jk-button-secondary" onClick={scrollToBottom}>
            Ke bawah
          </button>
        )}
      </div>
    </div>
  );
}
