import { useMemo, useRef } from "preact/hooks";
import { highlight, languageForPath } from "../lib/highlight";
import { TokenSpans } from "./CodeView";

export interface CodeEditorProps {
  path: string;
  value: string;
  onInput(value: string): void;
  onKeyDown?(event: KeyboardEvent): void;
  ariaLabel: string;
}

/**
 * Penyunting kode bergaya VS Code dengan teknik lapisan: textarea transparan
 * di atas `<pre>` bertoken. Textarea tetap sumber kebenaran; pre hanya tampilan.
 */
export function CodeEditor({ path, value, onInput, onKeyDown, ariaLabel }: CodeEditorProps) {
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  const lines = useMemo(() => {
    const tokenLines = highlight(value, languageForPath(path));
    const count = value.split("\n").length;
    while (tokenLines.length < count) tokenLines.push([]);
    return tokenLines;
  }, [value, path]);

  const numbers = useMemo(
    () => Array.from({ length: lines.length }, (_, index) => index + 1).join("\n"),
    [lines.length],
  );

  const syncScroll = (event: Event): void => {
    const source = event.currentTarget as HTMLTextAreaElement;
    const pre = highlightRef.current;
    if (pre !== null) {
      pre.scrollTop = source.scrollTop;
      pre.scrollLeft = source.scrollLeft;
    }
    const gutter = gutterRef.current;
    if (gutter !== null) gutter.scrollTop = source.scrollTop;
  };

  return (
    <div class="jk-vs-code jk-code-editor">
      <div class="jk-ce-gutter" aria-hidden="true" ref={gutterRef}>
        <pre>{numbers}</pre>
      </div>
      <div class="jk-ce-stack">
        <pre class="jk-ce-hl" aria-hidden="true" ref={highlightRef}>
          <code>
            {lines.map((tokens, index) => (
              <span key={index}>
                <TokenSpans tokens={tokens} />
                {"\n"}
              </span>
            ))}
          </code>
        </pre>
        <textarea
          class="jk-ce-input"
          aria-label={ariaLabel}
          spellcheck={false}
          wrap="off"
          autocapitalize="off"
          autocorrect="off"
          value={value}
          onInput={(event) => onInput((event.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
        />
      </div>
    </div>
  );
}
