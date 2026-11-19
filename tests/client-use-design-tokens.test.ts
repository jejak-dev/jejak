import { describe, expect, test } from "bun:test";
import { ApiError, type DesignToken } from "../src/client/lib/api";
import {
  createTokenLoader,
  tokenErrorMessage,
  TOKEN_CONFLICT_MESSAGE,
} from "../src/client/lib/use-design-tokens";

/** Tunggu seluruh rantai promise yang tertunda selesai. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function token(name: string, value: string): DesignToken {
  return { name, value };
}

describe("createTokenLoader", () => {
  test("reload memanggil onTokens dengan hasil", async () => {
    const dimuat: DesignToken[][] = [];
    const waktu: Array<number | null> = [];
    const loader = createTokenLoader({
      load: async () => ({ tokens: [token("--a", "1")], mtime: 1 }),
      onTokens: (tokens, mtime) => {
        dimuat.push(tokens);
        waktu.push(mtime);
      },
      onError: () => {},
    });

    await loader.reload();
    expect(dimuat).toEqual([[token("--a", "1")]]);
    expect(waktu).toEqual([1]);
  });

  test("hasil lama diabaikan setelah invalidate", async () => {
    const dimuat: DesignToken[][] = [];
    let release: (() => void) | undefined;
    const loader = createTokenLoader({
      load: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { tokens: [token("--lama", "1")], mtime: 1 };
      },
      onTokens: (tokens) => dimuat.push(tokens),
      onError: () => {},
    });

    const janji = loader.reload();
    loader.invalidate();
    release?.();
    await janji;
    await flush();
    expect(dimuat).toEqual([]);
  });

  test("invalidate juga membuang galat generasi lama", async () => {
    const galat: string[] = [];
    let release: (() => void) | undefined;
    const loader = createTokenLoader({
      load: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new ApiError("gagal", 500);
      },
      onTokens: () => {},
      onError: (message) => galat.push(message),
    });

    const janji = loader.reload();
    loader.invalidate();
    release?.();
    await janji;
    expect(galat).toEqual([]);
  });

  test("galat ApiError diteruskan pesannya", async () => {
    const galat: string[] = [];
    const loader = createTokenLoader({
      load: async () => {
        throw new ApiError("Sesi tidak ditemukan.", 404);
      },
      onTokens: () => {},
      onError: (message) => galat.push(message),
    });

    await loader.reload();
    expect(galat).toEqual(["Sesi tidak ditemukan."]);
  });

  test("reload kedua memakai hasil terbaru", async () => {
    let nomor = 0;
    const dimuat: DesignToken[][] = [];
    const loader = createTokenLoader({
      load: async () => {
        nomor += 1;
        return { tokens: [token(`--a${nomor}`, "1")], mtime: nomor };
      },
      onTokens: (tokens) => dimuat.push(tokens),
      onError: () => {},
    });

    await loader.reload();
    await loader.reload();
    expect(dimuat.map((daftar) => daftar[0]?.name)).toEqual(["--a1", "--a2"]);
  });
});

describe("tokenErrorMessage", () => {
  test("galat 409 memakai pesan konflik khusus", () => {
    expect(tokenErrorMessage(new ApiError("Token berubah sejak dibaca; muat ulang.", 409))).toBe(
      TOKEN_CONFLICT_MESSAGE,
    );
  });

  test("galat lain memakai pesan server", () => {
    expect(tokenErrorMessage(new ApiError("Sesi tidak ditemukan.", 404))).toBe(
      "Sesi tidak ditemukan.",
    );
  });

  test("galat biasa memakai pesan Error", () => {
    expect(tokenErrorMessage(new Error("jaringan putus"))).toBe("jaringan putus");
  });

  test("galat tak dikenal memakai pesan bawaan", () => {
    expect(tokenErrorMessage("bukan galat")).toBe("token tidak dapat dimuat");
  });
});
