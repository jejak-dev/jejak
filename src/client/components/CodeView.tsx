import { highlight, languageForPath } from "../lib/highlight";

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
            {tokens.length === 0
              ? " "
              : tokens.map((token, at) =>
                  token.kind === "plain" ? (
                    token.text
                  ) : (
                    <span class={`tok-${token.kind}`} key={at}>
                      {token.text}
                    </span>
                  ),
                )}
          </span>
        </div>
      ))}
    </div>
  );
}
