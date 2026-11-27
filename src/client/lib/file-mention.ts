/**
 * Referensi berkas untuk kolom pesan ("Tambah ke konteks").
 *
 * Yang ditambahkan hanya jalur `@jalur/relatif`; isi berkas dibaca agent dari
 * jalur itu. Jalur berasal dari API berkas yang sudah memeriksa cwd sesi.
 */

/** Jalur berkas -> token mention. Repo workspace non-utama jadi awalan jalur. */
export function fileMention(path: string, repo?: string): string {
  const clean = path.replace(/^\/+/, "");
  const full = repo !== undefined && repo !== "" ? `${repo}/${clean}` : clean;
  return /\s/.test(full) ? `@"${full}"` : `@${full}`;
}

/**
 * Menambahkan mention ke teks kolom pesan tanpa menggandakan.
 *
 * Mention yang sudah ada sebagai token utuh dibiarkan; selain itu ditaruh di
 * akhir, dipisah spasi (atau baris baru bila baris terakhir bukan mention).
 */
export function mergeMention(current: string, mention: string): string {
  const tokens = current.split(/\s+/);
  if (tokens.includes(mention) || current.includes(`${mention}\n`)) return current;
  if (current.trim() === "") return `${mention} `;
  const trimmed = current.replace(/\s+$/, "");
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  const onlyMentions = lastLine.split(/\s+/).every((token) => token.startsWith("@"));
  return `${trimmed}${onlyMentions ? " " : "\n"}${mention} `;
}
