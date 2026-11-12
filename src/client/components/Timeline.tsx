import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CANCELLED_MESSAGE, dedupeToolPermission, type TimelineItem } from "../lib/timeline";
import { StepsGroup } from "./StepsGroup";
import { groupSteps, stepsStatus, summarizeSteps, type StepItem } from "../lib/step-groups";
import { clipContent, diffCopyText, toolView, type ToolView } from "../lib/tool-view";
import { formatCost, formatCount } from "../lib/format";
import { attachmentUrl, splitAttachments } from "../lib/attachments";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";

export interface TimelineProps {
  items: TimelineItem[];
  connection: string;
  /** Sesi sedang bekerja: tampilkan indikator aktivitas di dasar timeline. */
  running?: boolean;
  /** Bash berjalan dalam sandbox (diizinkan otomatis di dalam batasnya). */
  sandboxed?: boolean;
  cwd: string;
  onDecide: (
    requestId: string,
    decision: "allow" | "deny",
    message?: string,
    answers?: Record<string, string>,
  ) => Promise<void>;
  /** Nomor urut pesan pengguna yang bisa dimundurkan. */
  rewindableSeqs?: number[];
  /** Jalankan mundur percakapan; galat ditampilkan di timeline. */
  onRewind?: (seq: number) => Promise<void>;
}

const MAX_INPUT_CHARS = 2000;
const MAX_OUTPUT_CHARS = 20000;
const PIN_THRESHOLD_PX = 80;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function rawInput(input: unknown): string {
  if (input === undefined) return "";
  try {
    const json = JSON.stringify(input, null, 2);
    return json === undefined ? String(input) : json;
  } catch {
    return String(input);
  }
}

function prettyInput(input: unknown): string {
  const text = rawInput(input);
  return text === "" ? "" : clip(text, MAX_INPUT_CHARS);
}

function SectionHead({ label, children }: { label: string; children?: ComponentChildren }) {
  return (
    <div class="jk-step-head">
      <h4 class="jk-step-label">{label}</h4>
      {children}
    </div>
  );
}

function ToolInputView({
  name,
  input,
  view,
}: {
  name: string;
  input: unknown;
  view: ToolView;
}) {
  switch (view.kind) {
    case "command":
      return (
        <section>
          <SectionHead label="Perintah">
            <CopyButton text={view.command} label="Salin perintah" />
          </SectionHead>
          <pre class="jk-pre jk-tool-cmd">{view.command}</pre>
          {view.description !== undefined && <p class="jk-tool-note">{view.description}</p>}
        </section>
      );

    case "diff": {
      const truncated = view.lines.some((line) => line.type === "more");
      const removed = view.lines.filter((line) => line.type === "del").length;
      const added = view.lines.filter((line) => line.type === "add").length;
      return (
        <section>
          <SectionHead label={view.path}>
            {!truncated && (
              <span class="jk-tool-count">
                −{removed} +{added}
              </span>
            )}
            <CopyButton text={() => diffCopyText(name, input)} label="Salin isi baru" />
          </SectionHead>
          <div class="jk-tool-diff" tabIndex={0} role="region" aria-label={`Perubahan ${view.path}`}>
            {view.lines.map((line, index) => {
              if (line.type === "sep") return <div class="jk-tool-dsep" key={index} />;
              if (line.type === "more") {
                return (
                  <div class="jk-tool-dmore" key={index}>
                    … {formatCount(line.count)} baris lagi
                  </div>
                );
              }
              return (
                <div
                  class={`jk-tool-dline ${line.type === "add" ? "jk-perm-add" : "jk-perm-del"}`}
                  key={index}
                >
                  <i>{line.type === "add" ? "+" : "-"}</i>
                  <span>{line.text === "" ? " " : line.text}</span>
                </div>
              );
            })}
          </div>
          {view.note !== undefined && <p class="jk-tool-note">{view.note}</p>}
        </section>
      );
    }

    case "write": {
      const shown = clipContent(view.content);
      return (
        <section>
          <SectionHead label={view.path}>
            <CopyButton text={view.content} label="Salin isi berkas" />
          </SectionHead>
          <pre class="jk-pre jk-pre-output">
            {shown.text}
            {shown.hidden > 0 ? `\n… ${formatCount(shown.hidden)} baris lagi` : ""}
          </pre>
        </section>
      );
    }

    case "generic":
      return null;
  }
}

function depthStyle(depth: number): Record<string, string> | undefined {
  return depth > 0 ? { marginLeft: `${Math.min(depth, 3) * 16}px` } : undefined;
}

function hasDescription(view: ReturnType<typeof toolView>): boolean {
  return view.kind === "command" && view.description !== undefined && view.description !== "";
}

/** Judul blok saat berjalan: deskripsi (atau ringkasan) langkah terbaru. */
function liveLabelOf(step: StepItem | undefined): string {
  if (step === undefined) return "";
  if (step.kind === "thinking") return "Berpikir";
  const view = toolView(step.name, step.input);
  if (hasDescription(view) && view.kind === "command") return view.description ?? "";
  return step.summary !== "" ? `${step.name} ${step.summary}` : step.name;
}

export function Timeline({
  items: rawItems,
  connection,
  running,
  sandboxed,
  cwd,
  onDecide,
  rewindableSeqs,
  onRewind,
}: TimelineProps) {
  // Sesi sudah berhenti (gagal, selesai, server restart): izin yang masih "menunggu"
  // tidak bisa diputuskan lagi, jadi tampilkan sebagai dihentikan.
  const items =
    running === false
      ? rawItems.map((item) =>
          item.kind === "permission" && item.status === "menunggu"
            ? { ...item, status: "dihentikan" as const }
            : item,
        )
      : rawItems;
  const visibleItems = dedupeToolPermission(items);
  // Setelah baris hasil, giliran sudah selesai walau status sesi belum diperbarui.
  const finished = items[items.length - 1]?.kind === "result";
  const lastItem = items[items.length - 1];
  const streamingNow = lastItem?.kind === "text" && lastItem.streaming === true;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);

  // Mundur percakapan: tombol kecil di pesan pengguna, konfirmasi dua langkah.
  const [confirmSeq, setConfirmSeq] = useState<number | undefined>(undefined);
  const [rewinding, setRewinding] = useState(false);
  const [rewindError, setRewindError] = useState<string | undefined>(undefined);

  const runRewind = async (seq: number): Promise<void> => {
    if (onRewind === undefined || rewinding) return;
    setRewinding(true);
    setRewindError(undefined);
    try {
      await onRewind(seq);
      setConfirmSeq(undefined);
    } catch (error) {
      setRewindError(error instanceof Error ? error.message : "gagal mundur percakapan");
    } finally {
      setRewinding(false);
    }
  };

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

  const renderStep = (item: StepItem, index: number) => {
    if (item.kind === "thinking") {
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
    }
              // Pertanyaan agent ditampilkan oleh kartu izin; baris tool-nya dobel.
              if (item.name === "AskUserQuestion" || item.name === "ExitPlanMode") return null;
              const view = toolView(item.name, item.input);
              const input = prettyInput(item.input);
              return (
                <details
                  class={`jk-step${hasDescription(view) ? " jk-step-has-desc" : ""}`}
                  key={index}
                  style={depthStyle(item.depth)}
                >
                  <summary>
                    <span class="jk-chev">
                      <Icon name="chevron" />
                    </span>
                    <span class="jk-step-name">{item.name}</span>
                    {view.kind === "command" && view.description !== undefined && view.description !== "" ? (
                      <span class="jk-step-arg jk-step-desc" title={item.summary}>
                        {view.description}
                      </span>
                    ) : (
                      item.summary !== "" && <span class="jk-step-arg">{item.summary}</span>
                    )}
                    {sandboxed === true && item.name === "Bash" && (
                      <span
                        class="jk-step-tag"
                        title="Berjalan dalam sandbox: tulis hanya di folder kerja, jaringan dibatasi, tanpa kartu izin."
                      >
                        sandbox
                      </span>
                    )}
                    {running === false && item.status === "berjalan" ? (
                      // Sesi sudah berhenti (mis. server restart): jangan berputar selamanya.
                      <span class="jk-step-status">terhenti</span>
                    ) : (
                      <span class={`jk-step-status jk-step-${item.status}`}>
                        {item.status === "berjalan" && <span class="jk-spinner" aria-hidden="true" />}
                        {item.status}
                      </span>
                    )}
                  </summary>
                  <div class="jk-step-body">
                    {view.kind === "generic"
                      ? input !== "" && (
                          <section>
                            <SectionHead label="Masukan">
                              <CopyButton text={rawInput(item.input)} label="Salin JSON masukan" />
                            </SectionHead>
                            <pre class="jk-pre">{input}</pre>
                          </section>
                        )
                      : <ToolInputView name={item.name} input={item.input} view={view} />}
                    {item.output !== undefined && (
                      <section>
                        <SectionHead label="Hasil">
                          <CopyButton text={item.output} label="Salin hasil" />
                        </SectionHead>
                        <pre class="jk-pre jk-pre-output">{clip(item.output, MAX_OUTPUT_CHARS)}</pre>
                      </section>
                    )}
                  </div>
                </details>
              );
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

          {groupSteps(visibleItems).map((block) => {
            if (block.kind === "steps") {
              const summary = summarizeSteps(block.items);
              const status = stepsStatus(block.items);
              const live = status.running && running !== false;
              return (
                <StepsGroup
                  key={`steps-${block.index}`}
                  summary={summary}
                  liveLabel={liveLabelOf(block.items[block.items.length - 1])}
                  live={live}
                  failed={status.failed}
                >
                  {block.items.map((step, offset) => renderStep(step, block.index + offset))}
                </StepsGroup>
              );
            }
            const item = block.item;
            const index = block.index;
            switch (item.kind) {
              case "user": {
                const parsed = splitAttachments(item.text);
                const seq = item.seq;
                const canRewind =
                  running !== true &&
                  onRewind !== undefined &&
                  seq !== undefined &&
                  rewindableSeqs?.includes(seq) === true;
                return (
                  <div class="jk-user" key={index}>
                    {parsed.body}
                    {parsed.files.length > 0 && (
                      <div class="jk-user-atts">
                        {parsed.files.map((file) =>
                          file.image ? (
                            <a key={file.path} href={attachmentUrl(file)} target="_blank" rel="noreferrer">
                              <img class="jk-user-att-img" src={attachmentUrl(file)} alt={file.name} />
                            </a>
                          ) : (
                            <a
                              key={file.path}
                              class="jk-user-att-file"
                              href={attachmentUrl(file)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Icon name="file" />
                              {file.name}
                            </a>
                          ),
                        )}
                      </div>
                    )}
                    {canRewind && (
                      confirmSeq === seq ? (
                        <div
                          class="jk-rewind-confirm"
                          role="alertdialog"
                          aria-label="Konfirmasi mundur percakapan"
                        >
                          <p>Buang pesan ini dan sesudahnya? Berkas tidak ikut dikembalikan.</p>
                          <div class="jk-rewind-actions">
                            <button
                              type="button"
                              class="jk-button"
                              disabled={rewinding}
                              onClick={() => void runRewind(seq)}
                            >
                              Ya, buang
                            </button>
                            <button
                              type="button"
                              class="jk-link-btn"
                              disabled={rewinding}
                              onClick={() => setConfirmSeq(undefined)}
                            >
                              Batal
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          class="jk-rewind-btn"
                          onClick={() => setConfirmSeq(seq)}
                        >
                          Mundur ke sini
                        </button>
                      )
                    )}
                  </div>
                );
              }


              case "text":
                return (
                  <div
                    class={`jk-text${item.streaming === true ? " jk-text-streaming" : ""}`}
                    key={index}
                    style={depthStyle(item.depth)}
                  >
                    <Markdown text={item.text} />
                  </div>
                );


              case "permission":
                return <PermissionCard key={item.id} item={item} cwd={cwd} onDecide={onDecide} />;

              case "error":
                return (
                  <div class="jk-danger-box" key={index} role="status">
                    {item.message}
                  </div>
                );

              case "notice":
                return (
                  <p
                    class={`jk-notice${item.level === "warn" ? " jk-notice-warn" : ""}`}
                    key={index}
                    role="status"
                  >
                    {item.text}
                  </p>
                );

              case "result":
                return (
                  <footer class="jk-result" key={index} title={resultDetail(item)}>
                    <span class={`jk-result-mark ${item.ok ? "jk-ok" : item.error === CANCELLED_MESSAGE ? "" : "jk-bad"}`}>
                      {item.ok ? "Selesai" : item.error === CANCELLED_MESSAGE ? "Dihentikan" : "Gagal"}
                    </span>
                    {item.estimatedCostUsd !== undefined && (
                      <span title="Perkiraan dari tarif di profil provider">{formatCost(item.estimatedCostUsd)}</span>
                    )}
                    {item.costUsd !== undefined && item.estimatedCostUsd === undefined && (
                      <span title="Dihitung SDK dengan tarif Claude, mungkin tidak akurat untuk model lain">SDK {formatCost(item.costUsd)}</span>
                    )}
                    {!item.ok && item.error !== undefined && item.error !== CANCELLED_MESSAGE && (
                      <span class="jk-bad">{item.error}</span>
                    )}
                  </footer>
                );

              default:
                return null;
            }
          })}
          {running === true && !finished && !streamingNow && pending.length === 0 && (
            <div class="jk-working" role="status" aria-label="Agent sedang bekerja">
              <span class="jk-working-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span class="jk-working-text">Working…</span>
            </div>
          )}
        </div>
      </div>

      <div class="jk-timeline-foot">
        {rewindError !== undefined && (
          <p class="jk-error-line" role="alert">
            {rewindError}
          </p>
        )}
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

/** Rincian token/giliran untuk tooltip baris hasil (tidak ditampilkan terbuka). */
function resultDetail(item: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  numTurns?: number;
}): string | undefined {
  const parts: string[] = [];
  if (item.inputTokens !== undefined) parts.push(`${formatCount(item.inputTokens)} token masuk`);
  if (item.outputTokens !== undefined) parts.push(`${formatCount(item.outputTokens)} keluar`);
  if (item.cacheReadTokens !== undefined && item.cacheReadTokens > 0) {
    parts.push(`${formatCount(item.cacheReadTokens)} dari cache`);
  }
  if (item.numTurns !== undefined) parts.push(`${formatCount(item.numTurns)} giliran`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
