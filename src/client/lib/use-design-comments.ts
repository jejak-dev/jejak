import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ApiClient,
  type DesignComment,
  type DesignCommentInput,
} from "./api";

/**
 * Pengelola daftar komentar desain. Murni terhadap DOM: pemuat disuntikkan,
 * jadi bisa diuji tanpa peramban. `invalidate` menaikkan generasi sehingga
 * hasil lama (sesi/repo sebelumnya) tidak dipakai.
 */

export interface CommentLoaderOptions {
  /** Ambil daftar komentar beserta mtime berkasnya. */
  load: () => Promise<{ comments: DesignComment[]; mtime: number }>;
  /** Dipanggil setiap hasil baru berhasil dimuat. */
  onComments: (comments: DesignComment[]) => void;
  /** Dipanggil saat pemuatan gagal. */
  onError: (message: string) => void;
}

export interface CommentLoader {
  /** Muat ulang; hasil dari generasi lama diabaikan. */
  reload(): Promise<void>;
  /** Batalkan hasil yang belum datang; generasi baru dipakai berikutnya. */
  invalidate(): void;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message !== "") return error.message;
  return "komentar tidak dapat dimuat";
}

export function createCommentLoader(options: CommentLoaderOptions): CommentLoader {
  let generation = 0;

  return {
    async reload() {
      const gen = generation;
      try {
        const result = await options.load();
        if (gen !== generation) return;
        options.onComments(result.comments);
      } catch (error) {
        if (gen !== generation) return;
        options.onError(messageOf(error));
      }
    },
    invalidate() {
      generation += 1;
    },
  };
}

export interface DesignCommentsState {
  comments: DesignComment[];
  error: string | undefined;
  add(input: DesignCommentInput): Promise<DesignComment>;
  setStatus(id: string, status: "open" | "done"): Promise<DesignComment>;
  remove(id: string): Promise<void>;
  reload(): Promise<void>;
}

/**
 * Komentar desain satu sesi. Dimuat saat tab aktif dan setiap model desain
 * berubah (cap folder `design/` sudah menelusuri `comments.json`).
 */
export function useDesignComments(
  api: ApiClient,
  sessionId: string,
  repo: string | undefined,
  active: boolean,
  version: unknown,
): DesignCommentsState {
  const [comments, setComments] = useState<DesignComment[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const loaderRef = useRef<CommentLoader | undefined>(undefined);

  useEffect(() => {
    if (!active) {
      loaderRef.current?.invalidate();
      loaderRef.current = undefined;
      setComments([]);
      setError(undefined);
      return;
    }
    const loader = createCommentLoader({
      load: () => api.listDesignComments(sessionId, repo),
      onComments: (next) => {
        setComments(next);
        setError(undefined);
      },
      onError: (message) => setError(message),
    });
    loaderRef.current = loader;
    void loader.reload();
    return () => {
      loader.invalidate();
      if (loaderRef.current === loader) loaderRef.current = undefined;
    };
  }, [api, sessionId, repo, active, version]);

  const reload = useCallback(async (): Promise<void> => {
    const loader = loaderRef.current;
    if (loader !== undefined) await loader.reload();
  }, []);

  /** Jalankan aksi tulis lalu muat ulang; galat disimpan dan dilempar ulang. */
  const write = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        const hasil = await action();
        await reload();
        return hasil;
      } catch (caught) {
        setError(messageOf(caught));
        throw caught;
      }
    },
    [reload],
  );

  const add = useCallback(
    (input: DesignCommentInput): Promise<DesignComment> =>
      write(() => api.addDesignComment(sessionId, input, repo)),
    [api, sessionId, repo, write],
  );

  const setStatus = useCallback(
    (id: string, status: "open" | "done"): Promise<DesignComment> =>
      write(() => api.updateDesignComment(sessionId, id, { status }, repo)),
    [api, sessionId, repo, write],
  );

  const remove = useCallback(
    (id: string): Promise<void> =>
      write(async () => {
        await api.deleteDesignComment(sessionId, id, repo);
      }),
    [api, sessionId, repo, write],
  );

  return { comments, error, add, setStatus, remove, reload };
}
