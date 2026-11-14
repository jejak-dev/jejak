import type { RunnerCommand } from "../../server/runner/runner-service";

/** Batas jumlah perintah kustom per folder (sama dengan server). */
export const RUNNER_MAX_CUSTOM = 40;
/** Panjang maksimum label perintah. */
export const RUNNER_LABEL_MAX = 60;
/** Panjang maksimum teks perintah (satu baris). */
export const RUNNER_COMMAND_MAX = 500;
/** Panjang maksimum grup perintah. */
export const RUNNER_GROUP_MAX = 40;

export interface CommandFormInput {
  label: string;
  command: string;
  group?: string;
}

export interface CommandFormValue {
  label: string;
  command: string;
  group?: string;
}

export type CommandFormResult =
  | { ok: true; value: CommandFormValue }
  | { ok: false; error: string };

export interface CommandGroup {
  title: string;
  items: RunnerCommand[];
}

/** `true` bila teks memuat karakter kontrol (newline, tab, dan sejenisnya). */
function hasControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Kelompokkan perintah: script package lebih dulu, lalu perintah kustom
 * menurut grupnya (tanpa grup -> "Kustom"). Urutan kemunculan dijaga.
 */
export function groupCommands(commands: readonly RunnerCommand[]): CommandGroup[] {
  const packages: RunnerCommand[] = [];
  const customGroups: CommandGroup[] = [];
  const index = new Map<string, CommandGroup>();
  for (const item of commands) {
    if (item.source === "package") {
      packages.push(item);
      continue;
    }
    const key = item.group ?? "";
    let group = index.get(key);
    if (group === undefined) {
      group = { title: key === "" ? "Kustom" : key, items: [] };
      index.set(key, group);
      customGroups.push(group);
    }
    group.items.push(item);
  }
  const result: CommandGroup[] = [];
  if (packages.length > 0) result.push({ title: "Package", items: packages });
  result.push(...customGroups);
  return result;
}

/** Validasi form perintah kustom; aturan sama dengan server. */
export function validateCommandForm(input: CommandFormInput): CommandFormResult {
  const label = input.label ?? "";
  if (hasControlChar(label)) {
    return { ok: false, error: "Field label tidak boleh memuat karakter kontrol." };
  }
  const trimmedLabel = label.trim();
  if (trimmedLabel === "") return { ok: false, error: "Field label wajib diisi." };
  if (trimmedLabel.length > RUNNER_LABEL_MAX) {
    return { ok: false, error: `Field label maksimal ${RUNNER_LABEL_MAX} karakter.` };
  }

  const command = input.command ?? "";
  if (hasControlChar(command)) {
    return { ok: false, error: "Field command harus satu baris tanpa karakter kontrol." };
  }
  const trimmedCommand = command.trim();
  if (trimmedCommand === "") return { ok: false, error: "Field command wajib diisi." };
  if (trimmedCommand.length > RUNNER_COMMAND_MAX) {
    return { ok: false, error: `Field command maksimal ${RUNNER_COMMAND_MAX} karakter.` };
  }

  const group = input.group ?? "";
  if (hasControlChar(group)) {
    return { ok: false, error: "Field group tidak boleh memuat karakter kontrol." };
  }
  const trimmedGroup = group.trim();
  if (trimmedGroup.length > RUNNER_GROUP_MAX) {
    return { ok: false, error: `Field group maksimal ${RUNNER_GROUP_MAX} karakter.` };
  }

  return {
    ok: true,
    value: {
      label: trimmedLabel,
      command: trimmedCommand,
      ...(trimmedGroup === "" ? {} : { group: trimmedGroup }),
    },
  };
}

/**
 * Teks konfirmasi yang jujur: script package menampilkan isi script di
 * samping perintahnya, perintah kustom menampilkan perintah penuh.
 */
export function confirmText(item: RunnerCommand): string {
  const head = `Jalankan di terminal: ${item.command}`;
  if (item.source !== "package") return head;
  const detail = item.detail ?? "";
  if (detail === "") return head;
  return `${head}\n\nIsi script:\n${detail}`;
}

/** Pesan ramah untuk galat menjalankan perintah. */
export function runErrorMessage(status: number, message?: string): string {
  if (status === 409) return "Perintah belum dikonfirmasi. Konfirmasi ulang di panel ini.";
  if (status === 503) {
    // Di Windows server menjawab bahwa terminal tak tersedia; pesan itu lebih
    // jujur daripada petunjuk JEJAK_TERMINAL=1 yang tak berguna di sana.
    const text = message?.trim();
    if (text !== undefined && text !== "" && /windows/i.test(text)) return text;
    return "Terminal dimatikan. Jalankan Jejak dengan JEJAK_TERMINAL=1 untuk menyalakannya.";
  }
  if (status === 429) {
    return "Batas terminal tercapai. Tutup terminal yang tidak dipakai, lalu coba lagi.";
  }
  if (status === 404) return "Folder atau perintah tidak dikenal. Muat ulang daftar perintah.";
  const text = message?.trim();
  return text === undefined || text === "" ? "Perintah gagal dijalankan." : text;
}
