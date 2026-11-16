import type { CommandInfo } from "./api";

/**
 * Pustaka murni untuk menu perintah slash.
 *
 * Tak ada DOM dan tak ada jaringan: teks dan daftar perintah dibawa masuk,
 * hasilnya keluar. Ini memudahkan diuji tanpa peramban.
 */

/** Konteks slash di depan kursor: teks yang diketik setelah garis miring. */
export interface SlashContext {
  /** Teks setelah garis miring (tanpa garis miring). */
  query: string;
}

/** Pola token perintah: garis miring di awal, tanpa spasi. */
const TOKEN = /^\/[\w:.-]*$/;

/**
 * Konteks perintah slash di depan kursor.
 *
 * Menu hanya terbuka bila teks sebelum kursor adalah token perintah: diawali
 * garis miring dan tanpa spasi. Di tengah kalimat, setelah spasi, atau pada
 * prompt multi-baris, hasilnya `undefined` (menu tak terbuka).
 */
export function slashContext(text: string, caret: number): SlashContext | undefined {
  // Prompt multi-baris tak memakai menu: perintah selalu di baris pertama.
  if (text.includes("\n")) return undefined;
  const posisi = Number.isFinite(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length;
  const upto = text.slice(0, posisi);
  if (!TOKEN.test(upto)) return undefined;
  return { query: upto.slice(1) };
}

/**
 * Posisi kursor pada kolom input.
 *
 * Bila peramban tak memberi posisi (mis. lingkungan uji), kursor dianggap di
 * akhir teks.
 */
export function caretOf(element: { value: string; selectionStart?: number | null }): number {
  const posisi = element.selectionStart;
  return typeof posisi === "number" ? posisi : element.value.length;
}

/**
 * Saring perintah sesuai query.
 *
 * Urutan: nama diawali query, lalu nama atau alias memuat query, lalu
 * deskripsi memuat query. Pencocokan tak peka huruf besar/kecil dan urutannya
 * stabil (perintah dengan nilai sama tetap urut aslinya). Query kosong
 * memakai semua perintah, dipotong `limit`.
 */
export function filterCommands(
  commands: readonly CommandInfo[],
  query: string,
  limit = 8,
): CommandInfo[] {
  const q = query.trim().toLowerCase();
  if (q === "") return commands.slice(0, limit);

  const cocok: { command: CommandInfo; rank: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const name = command.name.toLowerCase();
    const aliases = (command.aliases ?? []).map((alias) => alias.toLowerCase());
    let rank = -1;
    if (name.startsWith(q)) rank = 0;
    else if (name.includes(q) || aliases.some((alias) => alias.includes(q))) rank = 1;
    else if (command.description.toLowerCase().includes(q)) rank = 2;
    if (rank >= 0) cocok.push({ command, rank, index });
  });

  cocok.sort((kiri, kanan) => (kiri.rank === kanan.rank ? kiri.index - kanan.index : kiri.rank - kanan.rank));
  return cocok.slice(0, limit).map((item) => item.command);
}

/**
 * Ganti token perintah di depan kursor dengan `/nama `.
 *
 * Teks setelah kursor dipertahankan; kursor hasil berada di akhir teks yang
 * disisipkan.
 */
export function applyCommand(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const posisi = Number.isFinite(caret) ? Math.max(0, Math.min(caret, text.length)) : text.length;
  const upto = text.slice(0, posisi);
  const after = text.slice(posisi);
  const slash = upto.lastIndexOf("/");
  const head = slash >= 0 ? upto.slice(0, slash) : "";
  const sisip = `/${name} `;
  return { text: `${head}${sisip}${after}`, caret: head.length + sisip.length };
}
