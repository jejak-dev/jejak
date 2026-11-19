import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type DesignToken } from "./api";

/**
 * Pengelola daftar token desain. Murni terhadap DOM: pemuat disuntikkan,
 * jadi bisa diuji tanpa peramban. `invalidate` menaikkan generasi sehingga
 * hasil lama (sesi/repo sebelumnya) tidak dipakai.
 */

/** Pesan galat saat berkas token berubah di tempat lain. */
export const TOKEN_CONFLICT_MESSAGE = "Token berubah di tempat lain; muat ulang lalu coba lagi.";

/** Pesan galat umum saat daftar token tak dapat dimuat. */
const LOAD_FAILED = "token tidak dapat dimuat";

export interface TokenLoaderOptions {
  /** Ambil daftar token beserta mtime berkasnya. */
  load: () => Promise<{ tokens: DesignToken[]; mtime: number | null }>;
  /** Dipanggil setiap hasil baru berhasil dimuat. */
  onTokens: (tokens: DesignToken[], mtime: number | null) => void;
  /** Dipanggil saat pemuatan gagal. */
  onError: (message: string) => void;
}

export interface TokenLoader {
  /** Muat ulang; hasil dari generasi lama diabaikan. */
  reload(): Promise<void>;
  /** Batalkan hasil yang belum datang; generasi baru dipakai berikutnya. */
  invalidate(): void;
}

/**
 * Pesan galat untuk kesalahan apa pun. Galat 409 (berkas berubah di tempat
 * lain) memakai pesan khusus; galat lain memakai pesan server bila ada.
 */
export function tokenErrorMessage(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.status === 409) return TOKEN_CONFLICT_MESSAGE;
    return caught.message;
  }
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return LOAD_FAILED;
}

export function createTokenLoader(options: TokenLoaderOptions): TokenLoader {
  let generation = 0;

  return {
    async reload() {
      const gen = generation;
      try {
        const result = await options.load();
        if (gen !== generation) return;
        options.onTokens(result.tokens, result.mtime);
      } catch (error) {
        if (gen !== generation) return;
        options.onError(tokenErrorMessage(error));
      }
    },
    invalidate() {
      generation += 1;
    },
  };
}

export interface DesignTokensState {
  tokens: DesignToken[];
  /** Cap waktu berkas token terakhir dibaca; null bila berkas tak ada. */
  mtime: number | null;
  error: string | undefined;
  /** Simpan daftar token lalu muat ulang hasilnya. */
  save(tokens: DesignToken[]): Promise<void>;
  reload(): Promise<void>;
}

/**
 * Token desain satu sesi. Dimuat saat tab aktif dan setiap `version`
 * berubah (`design.tokens.mtime`), sehingga perubahan `tokens.css` oleh
 * agent ikut memuat ulang. Hasil lama diabaikan bila sesi atau repo berganti.
 */
export function useDesignTokens(
  api: ApiClient,
  sessionId: string,
  repo: string | undefined,
  active: boolean,
  version: unknown,
): DesignTokensState {
  const [tokens, setTokens] = useState<DesignToken[]>([]);
  const [mtime, setMtime] = useState<number | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const loaderRef = useRef<TokenLoader | undefined>(undefined);
  // Cap waktu terakhir yang dibaca; dipakai sebagai `baseMtime` saat menyimpan.
  const mtimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      loaderRef.current?.invalidate();
      loaderRef.current = undefined;
      setTokens([]);
      setMtime(null);
      mtimeRef.current = null;
      setError(undefined);
      return;
    }
    const loader = createTokenLoader({
      load: () => api.getDesignTokens(sessionId, repo),
      onTokens: (next, nextMtime) => {
        setTokens(next);
        setMtime(nextMtime);
        mtimeRef.current = nextMtime;
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

  /**
   * Simpan daftar token. `baseMtime` memakai cap waktu terakhir yang dibaca,
   * jadi perubahan di tempat lain ditolak server dengan galat 409.
   */
  const save = useCallback(
    async (next: DesignToken[]): Promise<void> => {
      try {
        await api.saveDesignTokens(
          sessionId,
          { tokens: next, baseMtime: mtimeRef.current },
          repo,
        );
        await reload();
      } catch (caught) {
        setError(tokenErrorMessage(caught));
        throw caught;
      }
    },
    [api, sessionId, repo, reload],
  );

  return { tokens, mtime, error, save, reload };
}
