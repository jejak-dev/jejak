import type { DesignComment, DesignPage } from "../lib/api";
import { commentsPrompt, isOrphan, sortComments } from "../lib/design-comments";
import { useEffect, useRef } from "preact/hooks";

export interface DesignCommentsProps {
  comments: DesignComment[];
  /** Halaman yang ada di desain; dipakai untuk judul dan status yatim. */
  pages: DesignPage[];
  /** Halaman yang benar-benar hidup di kanvas; syarat tombol "Tunjuk". */
  live: Set<string>;
  /** Sorot elemen halaman lewat kanvas. */
  onLocate: (slug: string, selector: string) => void;
  /** Tempel teks ke kolom pesan; tidak mengirim apa pun. */
  onQuote: (text: string) => void;
  onSetStatus: (id: string, status: "open" | "done") => void;
  onRemove: (id: string) => void;
  /** Nomor pin per id komentar; sama dengan nomor yang tampil di kanvas. */
  numbers: Map<string, number>;
  /** Komentar yang disorot (dari klik pin); barisnya ditandai dan digulir. */
  focusedId?: string;
  /** Galat aksi terakhir; ditampilkan sebagai alert. */
  error?: string;
}

const EMPTY_TEXT = "Belum ada komentar. Pilih elemen di kanvas lalu tambahkan komentar.";
const DELETED_PAGE = "(halaman dihapus)";

/**
 * Panel komentar desain: daftar komentar open lalu done, tombol sorot,
 * ubah status, hapus, dan "Kirim ke agent" yang hanya menempel teks.
 */
export function DesignComments(props: DesignCommentsProps) {
  const { comments, pages, live, error, numbers, focusedId } = props;
  const titles = new Map(pages.map((page) => [page.slug, page.title]));
  const slugs = new Set(pages.map((page) => page.slug));
  const sorted = sortComments(comments);
  const prompt = commentsPrompt(comments);
  const barisRefs = useRef(new Map<string, HTMLLIElement>());

  // Gulir baris yang disorot ke tampilan bila elemennya ada.
  useEffect(() => {
    if (focusedId === undefined) return;
    const el = barisRefs.current.get(focusedId);
    if (el === undefined) return;
    if (typeof el.scrollIntoView !== "function") return;
    el.scrollIntoView({ block: "nearest" });
  }, [focusedId, sorted.length]);

  return (
    <aside class="jk-design-comments" aria-label="Komentar desain">
      {error !== undefined && (
        <p class="jk-design-comments-error" role="alert">
          {error}
        </p>
      )}
      {sorted.length === 0 ? (
        <p class="jk-design-comments-empty">{EMPTY_TEXT}</p>
      ) : (
        <ul class="jk-design-comments-list" aria-label="Daftar komentar desain">
          {sorted.map((comment) => {
            const yatim = isOrphan(comment, slugs);
            const judul = yatim ? DELETED_PAGE : (titles.get(comment.slug) ?? comment.slug);
            const nomor = numbers.get(comment.id);
            const fokus = focusedId === comment.id;
            return (
              <li
                key={comment.id}
                ref={(el) => {
                  if (el === null) barisRefs.current.delete(comment.id);
                  else barisRefs.current.set(comment.id, el);
                }}
                class={fokus ? "jk-design-comment is-focused" : "jk-design-comment"}
                data-status={comment.status}
                aria-current={fokus ? "true" : undefined}
              >
                <div class="jk-design-comment-head">
                  <span class="jk-design-comment-page">
                    {nomor !== undefined && <span class="jk-design-comment-number">#{nomor}</span>}
                    {judul}
                  </span>
                  <code class="jk-design-comment-selector">{comment.selector}</code>
                </div>
                <p class="jk-design-comment-text">{comment.text}</p>
                <div class="jk-design-comment-actions">
                  {!yatim && live.has(comment.slug) && (
                    <button
                      type="button"
                      class="jk-design-chip"
                      onClick={() => props.onLocate(comment.slug, comment.selector)}
                    >
                      Tunjuk
                    </button>
                  )}
                  <button
                    type="button"
                    class="jk-design-chip"
                    onClick={() =>
                      props.onSetStatus(comment.id, comment.status === "open" ? "done" : "open")
                    }
                  >
                    {comment.status === "open" ? "Selesai" : "Buka lagi"}
                  </button>
                  <button
                    type="button"
                    class="jk-design-chip"
                    onClick={() => props.onRemove(comment.id)}
                  >
                    Hapus
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {prompt !== undefined && (
        <div class="jk-design-comments-footer">
          <button
            type="button"
            class="jk-design-chip"
            onClick={() => props.onQuote(prompt)}
          >
            Kirim ke agent
          </button>
        </div>
      )}
    </aside>
  );
}
