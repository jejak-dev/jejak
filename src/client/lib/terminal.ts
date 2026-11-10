/**
 * Model layar terminal sederhana (murni). Mendukung teks, CR/LF/BS/TAB, SGR (dibuang),
 * dan CSI K/C/D/P/@/G/J. Program layar penuh (vim, htop) tidak didukung.
 */
export interface Screen {
  /** Baris yang sudah selesai (terlama dulu). */
  lines: string[];
  /** Baris aktif. */
  cur: string;
  /** Kolom kursor pada baris aktif. */
  col: number;
  /** Urutan escape yang terpotong di akhir potongan sebelumnya. */
  pending: string;
}

export const MAX_SCREEN_LINES = 2000;

export function emptyScreen(): Screen {
  return { lines: [], cur: "", col: 0, pending: "" };
}

function put(cur: string, col: number, ch: string): { cur: string; col: number } {
  const padded = col > cur.length ? cur + " ".repeat(col - cur.length) : cur;
  return { cur: padded.slice(0, col) + ch + padded.slice(col + 1), col: col + 1 };
}

function csi(screen: Screen, params: string, final: string): void {
  const n = Math.max(1, Number.parseInt(params.replace(/^[?>]/, "").split(";")[0] ?? "", 10) || 1);
  switch (final) {
    case "K": {
      const mode = Number.parseInt(params, 10) || 0;
      if (mode === 0) screen.cur = screen.cur.slice(0, screen.col);
      else if (mode === 1) screen.cur = " ".repeat(Math.min(screen.col, screen.cur.length)) + screen.cur.slice(screen.col);
      else screen.cur = "";
      return;
    }
    case "C":
      screen.col += n;
      return;
    case "D":
      screen.col = Math.max(0, screen.col - n);
      return;
    case "G":
      screen.col = Math.max(0, n - 1);
      return;
    case "P":
      screen.cur = screen.cur.slice(0, screen.col) + screen.cur.slice(screen.col + n);
      return;
    case "@":
      screen.cur = screen.cur.slice(0, screen.col) + " ".repeat(n) + screen.cur.slice(screen.col);
      return;
    case "J": {
      const mode = Number.parseInt(params, 10) || 0;
      if (mode === 2 || mode === 3) {
        screen.lines = [];
        screen.cur = "";
        screen.col = 0;
      }
      return;
    }
    default:
      // SGR (m), mode privat (h/l), posisi (H, f, A, B) diabaikan.
  }
}

/** Menerapkan keluaran baru; mengembalikan layar baru (masukan tidak diubah). */
export function applyOutput(previous: Screen, text: string): Screen {
  const screen: Screen = { ...previous, lines: [...previous.lines] };
  const input = screen.pending + text;
  screen.pending = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] as string;
    if (ch === "\x1b") {
      const next = input[i + 1];
      if (next === undefined) {
        screen.pending = input.slice(i);
        break;
      }
      if (next === "[") {
        let j = i + 2;
        while (j < input.length && /[0-?]/.test(input[j] as string)) j += 1;
        while (j < input.length && /[ -/]/.test(input[j] as string)) j += 1;
        if (j >= input.length) {
          screen.pending = input.slice(i);
          break;
        }
        csi(screen, input.slice(i + 2, j).replace(/[ -/]+$/, ""), input[j] as string);
        i = j;
        continue;
      }
      if (next === "]") {
        let j = i + 2;
        while (j < input.length && input[j] !== "\x07" && !(input[j] === "\x1b" && input[j + 1] === "\\")) j += 1;
        if (j >= input.length) {
          screen.pending = input.slice(i);
          break;
        }
        i = input[j] === "\x07" ? j : j + 1;
        continue;
      }
      i += 1; // ESC + satu karakter (mis. ESC =, ESC >) dibuang
      continue;
    }
    if (ch === "\n") {
      screen.lines.push(screen.cur);
      screen.cur = "";
      screen.col = 0;
    } else if (ch === "\r") {
      screen.col = 0;
    } else if (ch === "\b") {
      screen.col = Math.max(0, screen.col - 1);
    } else if (ch === "\t") {
      const stop = (Math.floor(screen.col / 8) + 1) * 8;
      const moved = put(screen.cur, screen.col, " ");
      screen.cur = moved.cur + " ".repeat(Math.max(0, stop - moved.col));
      screen.col = stop;
    } else if (ch === "\x07" || ch < " ") {
      // Bel dan kontrol lain diabaikan.
    } else {
      const moved = put(screen.cur, screen.col, ch);
      screen.cur = moved.cur;
      screen.col = moved.col;
    }
  }
  if (screen.lines.length > MAX_SCREEN_LINES) {
    screen.lines = screen.lines.slice(screen.lines.length - MAX_SCREEN_LINES);
  }
  return screen;
}

/** Teks yang ditampilkan: baris selesai + baris aktif. */
export function screenText(screen: Screen): string {
  return [...screen.lines, screen.cur].join("\n");
}

/** Memetakan tombol keyboard ke byte untuk PTY; `undefined` = tidak ditangani. */
export function keyToInput(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): string | undefined {
  if (event.metaKey) return undefined;
  const { key } = event;
  if (event.ctrlKey && !event.altKey) {
    if (/^[a-zA-Z]$/.test(key)) return String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64);
    if (key === "[") return "\x1b";
    return undefined;
  }
  switch (key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "Delete":
      return "\x1b[3~";
    default:
  }
  if (key.length === 1 || (key.length > 1 && [...key].length === 1)) {
    return event.altKey ? `\x1b${key}` : key;
  }
  return undefined;
}

export function base64ToText(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
