import type { DesignComment } from "./api";
import type { PinSpec } from "./design-protocol";

/**
 * Logika komentar desain di klien. Murni: tanpa DOM, tanpa jaringan. Teks
 * komentar berasal dari pengguna dan hanya dipakai sebagai teks.
 */

/** Komentar terbuka diurutkan lebih dulu, lalu menurut `createdAt` naik. */
export function sortComments(comments: DesignComment[]): DesignComment[] {
  return comments.slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}

/** Jumlah komentar berstatus open. */
export function openCount(comments: DesignComment[]): number {
  let jumlah = 0;
  for (const comment of comments) if (comment.status === "open") jumlah += 1;
  return jumlah;
}

/** Baris teks komentar tanpa karakter kontrol; maks 300 karakter. */
function satuBaris(text: string): string {
  // ganti semua karakter kontrol (termasuk baris baru) dengan spasi
  const bersih = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return bersih.slice(0, 300);
}

/**
 * Teks pesan untuk agent dari komentar terbuka; `undefined` bila tak ada.
 * Tidak mengirim apa pun sendiri: pemanggil menempelnya ke composer.
 */
export function commentsPrompt(comments: DesignComment[]): string | undefined {
  const open = sortComments(comments).filter((comment) => comment.status === "open");
  if (open.length === 0) return undefined;
  const kepala =
    "Kerjakan komentar desain berikut. Ubah halaman dengan design_patch (satu elemen per panggilan), periksa hasilnya dengan design_screenshot bila kanvas terbuka, lalu tandai tiap komentar selesai dengan design_comment_resolve.";
  const baris = open.map(
    (comment) =>
      `- [${comment.id}] design/pages/${comment.slug}.html, elemen \`${comment.selector}\`: ${satuBaris(comment.text)}`,
  );
  return `${kepala}\n\n${baris.join("\n")}`;
}

/** Label chip: "Komentar (2)" saat ada yang terbuka, "Komentar" saat nol. */
export function commentCountLabel(comments: DesignComment[]): string {
  const jumlah = openCount(comments);
  return jumlah === 0 ? "Komentar" : `Komentar (${jumlah})`;
}

/** Komentar yatim: halamannya tak ada lagi di desain. */
export function isOrphan(comment: DesignComment, slugs: Set<string>): boolean {
  return !slugs.has(comment.slug);
}

/**
 * Nomor pin 1-based menurut `createdAt` naik (seri diurutkan menurut `id`).
 * Nomor tidak bergantung pada status, jadi stabil saat komentar diselesaikan.
 */
export function commentNumbers(comments: DesignComment[]): Map<string, number> {
  const urut = comments.slice().sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const hasil = new Map<string, number>();
  urut.forEach((comment, index) => {
    hasil.set(comment.id, index + 1);
  });
  return hasil;
}

/** Pin semua komentar satu halaman (open dan done), urut menurut nomornya. */
export function pinsForSlug(comments: DesignComment[], slug: string): PinSpec[] {
  const nomor = commentNumbers(comments);
  const hasil: PinSpec[] = [];
  for (const comment of comments) {
    if (comment.slug !== slug) continue;
    hasil.push({
      id: comment.id,
      selector: comment.selector,
      n: nomor.get(comment.id) ?? 0,
      done: comment.status === "done",
    });
  }
  return hasil.sort((a, b) => a.n - b.n);
}
