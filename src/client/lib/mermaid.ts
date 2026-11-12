/**
 * Pembungkus minimum API mermaid.
 *
 * Sengaja disempit (bukan tipe mermaid penuh) agar modul ini bisa diuji
 * dengan pemuat palsu tanpa DOM, dan agar bundel klien hanya memakai
 * sebagian kecil permukaan API.
 */
export interface MermaidConfig {
  startOnLoad: boolean;
  securityLevel: "strict" | "loose" | "antiscript" | "sandbox";
  theme: "default" | "dark";
}

export interface MermaidApi {
  initialize(config: MermaidConfig): void;
  parse(
    source: string,
    options?: { suppressErrors?: boolean },
  ): Promise<boolean | { diagramType?: string }>;
  render(id: string, source: string): Promise<{ svg: string }>;
}

export type MermaidResult = { ok: true; svg: string } | { ok: false; error: string };

/** Batas panjang sumber diagram (karakter). Lebih panjang ditolak. */
export const MAX_MERMAID_SOURCE = 20_000;

/** Hanya bahasa "mermaid" (huruf besar/kecil tak dibedakan) yang dirender. */
export function isMermaidLang(lang: string | undefined): boolean {
  if (lang === undefined) return false;
  return lang.trim().toLowerCase() === "mermaid";
}

/** Modul mermaid yang sudah dimuat; disimpan agar hanya diimpor sekali. */
let cachedModule: MermaidApi | undefined;

/** Tema yang sudah di-initialize, per instans mermaid (satu kali per tema). */
const initializedThemes = new WeakMap<MermaidApi, string>();

async function loadMermaidModule(): Promise<MermaidApi> {
  if (cachedModule === undefined) {
    const mod = await import("mermaid");
    cachedModule = mod.default as unknown as MermaidApi;
  }
  return cachedModule;
}

/** Pesan galat ringkas tanpa stack. */
function shortMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.replace(/\s+/g, " ").trim();
    if (message !== "") {
      return message.length > 160 ? `${message.slice(0, 157)}...` : message;
    }
  }
  return "Gagal merender diagram";
}

/**
 * Render sumber mermaid menjadi SVG.
 *
 * Memuat mermaid secara malas (import dinamis -> chunk terpisah di bundel
 * klien), memvalidasi sintaks dulu, lalu merender. Galat apa pun dikembalikan
 * sebagai pesan ringkas, tidak pernah dilempar.
 */
export async function renderMermaid(
  source: string,
  options: { dark: boolean; id: string; load?: () => Promise<MermaidApi> },
): Promise<MermaidResult> {
  if (source.length > MAX_MERMAID_SOURCE) {
    return { ok: false, error: "Diagram terlalu panjang untuk dirender" };
  }
  const load = options.load ?? loadMermaidModule;
  try {
    const api = await load();
    const theme = options.dark ? "dark" : "default";
    if (initializedThemes.get(api) !== theme) {
      api.initialize({ startOnLoad: false, securityLevel: "strict", theme });
      initializedThemes.set(api, theme);
    }
    const parsed = await api.parse(source, { suppressErrors: true });
    if (parsed === false) {
      return { ok: false, error: "Sintaks diagram tidak valid" };
    }
    const rendered = await api.render(options.id, source);
    return { ok: true, svg: rendered.svg };
  } catch (error) {
    return { ok: false, error: shortMessage(error) };
  }
}
