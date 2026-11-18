/**
 * Mesin terminal berbasis xterm.js.
 *
 * xterm dimuat malas (import dinamis) supaya bundel awal tetap ringan; CSS-nya
 * diimpor statis di komponen karena CSS chunk malas tidak dimuat otomatis.
 */

export interface TerminalEngine {
  cols: number;
  rows: number;
  write(bytes: Uint8Array): void;
  reset(): void;
  fit(): void;
  focus(): void;
  onData(cb: (text: string) => void): void;
  dispose(): void;
}

export type TerminalEngineFactory = (container: HTMLElement) => Promise<TerminalEngine>;

function cssVar(name: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

export const createXtermEngine: TerminalEngineFactory = async (container) => {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);

  const term = new Terminal({
    fontFamily: cssVar("--mono", "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"),
    fontSize: 13,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    theme: {
      background: cssVar("--bg", "#1d1c1a"),
      foreground: cssVar("--ink", "#ece9e2"),
      cursor: cssVar("--ink", "#ece9e2"),
      selectionBackground: cssVar("--t3", "#908d85"),
    },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  const fit = (): void => {
    // Container 0×0 (mis. tab tersembunyi) membuat fit melempar galat.
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    fitAddon.fit();
  };

  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write(bytes: Uint8Array): void {
      term.write(bytes);
    },
    reset(): void {
      term.reset();
    },
    fit,
    focus(): void {
      term.focus();
    },
    onData(cb: (text: string) => void): void {
      term.onData(cb);
    },
    dispose(): void {
      term.dispose();
    },
  };
};
