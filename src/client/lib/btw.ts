/**
 * Pertanyaan sampingan dari salinan percakapan sesi.
 *
 * Pesan yang diawali `/btw` (huruf besar/kecil tak dibedakan) dan diikuti
 * spasi atau baris baru adalah pertanyaan sampingan, bukan giliran biasa.
 * `/btw` tanpa isi dan `/btwx` bukan pertanyaan sampingan.
 */
export function parseBtw(text: string): string | undefined {
  const trimmed = text.trim();
  const match = /^\/btw(?:[ \t]+|\r?\n)([\s\S]*)$/i.exec(trimmed);
  if (match === null) return undefined;
  const question = (match[1] ?? "").trim();
  return question === "" ? undefined : question;
}
