import { useEffect, useRef, useState } from "preact/hooks";
import type { TimelineItem } from "../lib/timeline";
import { formatCost, formatCount } from "../lib/format";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";

export interface TimelineProps {
  items: TimelineItem[];
  connection: string;
  cwd: string;
  onDecide: (requestId: string, decision: "allow" | "deny", message?: string) => Promise<void>;
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

export function Timeline({ items, connection, cwd, onDecide }: TimelineProps) {
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

  const pending = items.filter(
    (item): item is Extract<TimelineItem, { kind: "permission" }> =>
      item.kind === "permission" && item.status === "menunggu",
  );
  const firstPendingId = pending[0]?.id;
  const [pendingHidden, setPendingHidden] = useState(false);

  // Kartu izin pertama yang menunggu di luar layar: tampilkan pil penunjuk.
  useEffect(() => {
    const root = scrollRef.current;
    if (root === null || firstPendingId === undefined) {
      setPendingHidden(false);
      return;
    }
    const node = Array.from(root.querySelectorAll<HTMLElement>("[data-permission-id]")).find(
      (element) => element.dataset.permissionId === firstPendingId,
    );
    if (node === undefined) return;
    const observer = new IntersectionObserver(
      ([entry]) => setPendingHidden(entry !== undefined && !entry.isIntersecting),
      { root, threshold: 0.1 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [firstPendingId, items.length]);

  const jumpToPending = (): void => {
    const root = scrollRef.current;
    if (root === null || firstPendingId === undefined) return;
    const node = Array.from(root.querySelectorAll<HTMLElement>("[data-permission-id]")).find(
      (element) => element.dataset.permissionId === firstPendingId,
    );
    node?.scrollIntoView({ block: "center" });
    node?.focus({ preventScroll: true });
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
        <div class="jk-col">
          {items.length === 0 && <p class="jk-empty-line">Belum ada aktivitas.</p>}

          {items.map((item, index) => {
            switch (item.kind) {
              case "user":
                return (
                  <div class="jk-user" key={index}>
                    {item.text}
                  </div>
                );

              case "thinking":
                return (
                  <details class="jk-step jk-step-think" key={index} style={depthStyle(item.depth)}>
                    <summary>
                      <span class="jk-chev">
                        <Icon name="chevron" />
                      </span>
                      Berpikir
                    </summary>
                    <div class="jk-step-body jk-pre-wrap">{item.text}</div>
                  </details>
                );

              case "text":
                return (
                  <div class="jk-text" key={index} style={depthStyle(item.depth)}>
                    <Markdown text={item.text} />
                  </div>
                );

              case "tool": {
                const input = prettyInput(item.input);
                return (
                  <details class="jk-step" key={index} style={depthStyle(item.depth)}>
                    <summary>
                      <span class="jk-chev">
                        <Icon name="chevron" />
                      </span>
                      <span class="jk-step-name">{item.name}</span>
                      {item.summary !== "" && <span class="jk-step-arg">{item.summary}</span>}
                      <span class={`jk-step-status jk-step-${item.status}`}>{item.status}</span>
                    </summary>
                    <div class="jk-step-body">
                      {input !== "" && (
                        <section>
                          <h4 class="jk-step-label">Masukan</h4>
                          <pre class="jk-pre">{input}</pre>
                        </section>
                      )}
                      {item.output !== undefined && (
                        <section>
                          <h4 class="jk-step-label">Hasil</h4>
                          <pre class="jk-pre jk-pre-output">{clip(item.output, 20000)}</pre>
                        </section>
                      )}
                    </div>
                  </details>
                );
              }

              case "permission":
                return <PermissionCard key={item.id} item={item} cwd={cwd} onDecide={onDecide} />;

              case "error":
                return (
                  <div class="jk-danger-box" key={index} role="status">
                    {item.message}
                  </div>
                );

              case "result":
                return (
                  <footer class="jk-result" key={index}>
                    <span class={`jk-result-mark ${item.ok ? "jk-ok" : "jk-bad"}`}>
                      {item.ok ? "Selesai" : "Gagal"}
                    </span>
                    {item.inputTokens !== undefined && (
                      <span>{formatCount(item.inputTokens)} token masuk</span>
                    )}
                    {item.outputTokens !== undefined && (
                      <span>{formatCount(item.outputTokens)} keluar</span>
                    )}
                    {item.cacheReadTokens !== undefined && item.cacheReadTokens > 0 && (
                      <span>{formatCount(item.cacheReadTokens)} dari cache</span>
                    )}
                    {item.numTurns !== undefined && <span>{formatCount(item.numTurns)} giliran</span>}
                    {item.estimatedCostUsd !== undefined && (
                      <span title="Perkiraan dari tarif di profil provider">{formatCost(item.estimatedCostUsd)}</span>
                    )}
                    {item.costUsd !== undefined && item.estimatedCostUsd === undefined && (
                      <span title="Dihitung SDK dengan tarif Claude, mungkin tidak akurat untuk model lain">SDK {formatCost(item.costUsd)}</span>
                    )}
                    {!item.ok && item.error !== undefined && (
                      <span class="jk-bad">{item.error}</span>
                    )}
                  </footer>
                );

              default:
                return null;
            }
          })}
        </div>
      </div>

      <div class="jk-timeline-foot">
        {pendingHidden && pending.length > 0 && (
          <button type="button" class="jk-pending-pill" onClick={jumpToPending}>
            <span>
              Menunggu izin: {pending[0]?.name}
              {pending.length > 1 ? ` (+${pending.length - 1})` : ""}
            </span>
            <span class="jk-pending-go">Lihat</span>
          </button>
        )}
        {connection === "menyambung" && (
          <p class="jk-float-note" role="status">
            Menyambung ulang…
          </p>
        )}
        {!pinned && (
          <button type="button" class="jk-float-btn" onClick={scrollToBottom}>
            Ke bawah
          </button>
        )}
      </div>
    </div>
  );
}
