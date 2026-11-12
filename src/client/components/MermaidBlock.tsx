import { useEffect, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import { renderMermaid } from "../lib/mermaid";
import { isDarkTheme } from "../lib/theme";
import { CopyButton } from "./CopyButton";

/** Tunggu sumber berhenti berubah (mis. saat streaming) sebelum merender. */
const DEBOUNCE_MS = 500;

/** Penomoran instans; dipakai sebagai id elemen SVG mermaid (harus unik). */
let instanceCounter = 0;

export interface MermaidBlockProps {
  source: string;
}

interface DiagramState {
  svg: string | undefined;
  error: string | undefined;
  zoom: boolean;
  setZoom: (zoom: boolean) => void;
}

/** Media query sistem untuk tema gelap. */
function darkMedia(): MediaQueryList | undefined {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
  return window.matchMedia("(prefers-color-scheme: dark)");
}

/** Tema gelap efektif saat ini (atribut tema eksplisit menang). */
function currentDark(): boolean {
  if (typeof document === "undefined") return false;
  return isDarkTheme(document.documentElement, darkMedia());
}

/**
 * State diagram: sumber, status render, zoom, dan tema.
 *
 * Render ditunda 500 ms setelah sumber berhenti berubah, dan render yang
 * sudah usang dibatalkan lewat token.
 */
function useDiagramState(source: string): DiagramState {
  const idRef = useRef<string>("");
  if (idRef.current === "") {
    instanceCounter += 1;
    idRef.current = `jk-mermaid-${instanceCounter}`;
  }
  const tokenRef = useRef(0);
  const [svg, setSvg] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [zoom, setZoom] = useState(false);
  const [dark, setDark] = useState<boolean>(() => currentDark());

  // Ikuti perubahan tema: atribut `data-theme` dan media query sistem.
  useEffect(() => {
    const media = darkMedia();
    const read = (): void => {
      setDark(currentDark());
    };
    read();
    const observer =
      typeof MutationObserver === "undefined" ? undefined : new MutationObserver(read);
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    media?.addEventListener("change", read);
    return () => {
      observer?.disconnect();
      media?.removeEventListener("change", read);
    };
  }, []);

  useEffect(() => {
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    setSvg(undefined);
    setError(undefined);
    const timer = setTimeout(() => {
      void renderMermaid(source, { dark, id: idRef.current })
        .then((result) => {
          if (tokenRef.current !== token) return;
          if (result.ok) {
            setSvg(result.svg);
            setError(undefined);
          } else {
            setSvg(undefined);
            setError(result.error);
          }
        })
        .catch(() => {
          if (tokenRef.current !== token) return;
          setError("Gagal merender diagram");
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [source, dark]);

  return { svg, error, zoom, setZoom };
}

/**
 * Blok diagram mermaid.
 *
 * Selama belum berhasil, isi sumber ditampilkan sebagai blok kode biasa.
 * Setelah render sukses, SVG menggantikan blok kode. Mermaid dimuat secara
 * malas lewat `import()` sehingga kode besar tidak masuk bundel utama.
 */
export function MermaidBlock({ source }: MermaidBlockProps): VNode {
  let state: DiagramState | undefined;
  try {
    state = useDiagramState(source);
  } catch {
    // Dipanggil di luar konteks render (mis. penelusuran pohon VNode
    // tanpa DOM pada tes): tampilkan blok kode biasa saja.
    state = undefined;
  }

  if (state === undefined) {
    return <CodeOnly source={source} />;
  }

  const { svg, error, zoom, setZoom } = state;
  const wrapClass = zoom ? "jk-md-mermaid-wrap jk-md-mermaid-zoom" : "jk-md-mermaid-wrap";

  return (
    <div class={wrapClass}>
      {svg === undefined ? (
        <CodeOnly source={source} />
      ) : (
        <div class="jk-md-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      {svg === undefined ? null : (
        <div class="jk-md-mermaid-bar">
          <CopyButton text={source} label="Salin kode diagram" />
          <button
            type="button"
            class="jk-md-mermaid-btn"
            onClick={() => {
              setZoom(!zoom);
            }}
          >
            {zoom ? "Perkecil" : "Perbesar"}
          </button>
        </div>
      )}
      {error === undefined ? null : <p class="jk-note">{error}</p>}
    </div>
  );
}

/** Tampilan sumber mermaid sebagai blok kode biasa. */
function CodeOnly({ source }: { source: string }): VNode {
  return (
    <div class="jk-md-codeblock">
      <pre class="jk-md-pre" tabIndex={0}>
        <span class="jk-md-lang">mermaid</span>
        <code>{source}</code>
      </pre>
      <CopyButton text={source} label="Salin kode diagram" />
    </div>
  );
}
