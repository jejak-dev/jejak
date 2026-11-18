import type { ComponentChild } from "preact";
import { highlight, languageForPath, type Token } from "../lib/highlight";

/**
 * Render token satu baris. Token `plain` menjadi teks biasa agar tidak ada
 * span berlebih. Dipakai bersama oleh penampil dan penyunting kode.
 */
export function TokenSpans({ tokens }: { tokens: readonly Token[] }): ComponentChild {
  return tokens.map((token, at) =>
    token.kind === "plain" ? (
      token.text
    ) : (
      <span class={`tok-${token.kind}`} key={at}>
        {token.text}
      </span>
    ),
  );
}

export interface CodeViewProps {
  content: string;
  path: string;
  /** Baris yang disorot (1-based), mis. dari hasil pencarian. */
  highlightLine?: number;
  /** Wadah luar, dipakai pemanggil untuk menggulir ke baris tersorot. */
  viewRef?: { current: HTMLDivElement | null };
}

/**
 * Penampil kode bergaya VS Code: nomor baris, latar tema, dan token berwarna.
 * Token `plain` dirender sebagai teks biasa agar tidak ada span berlebih.
 */
export function CodeView({ content, path, highlightLine, viewRef }: CodeViewProps) {
  const lines = highlight(content, languageForPath(path));
  return (
    <div
      ref={viewRef}
      class="jk-perm-code jk-panel-code jk-vs-code"
      tabIndex={0}
      role="region"
      aria-label={`Isi ${path}`}
    >
      {lines.map((tokens, index) => (
        <div
          class={`jk-perm-line${index + 1 === highlightLine ? " jk-line-hit" : ""}`}
          key={index}
          data-line={highlightLine === index + 1 ? index + 1 : undefined}
        >
          <i aria-hidden="true">{index + 1}</i>
          <span>
            {tokens.length === 0 ? " " : <TokenSpans tokens={tokens} />}
          </span>
        </div>
      ))}
    </div>
  );
}
