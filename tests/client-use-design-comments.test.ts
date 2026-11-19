import { describe, expect, test } from "bun:test";
import { ApiError, type DesignComment } from "../src/client/lib/api";
import { createCommentLoader } from "../src/client/lib/use-design-comments";

/** Tunggu seluruh rantai promise yang tertunda selesai. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function komentar(id: string): DesignComment {
  return {
    id,
    slug: "beranda",
    selector: '[id="judul"]',
    text: "x",
    status: "open",
    createdAt: 1,
  };
}

describe("createCommentLoader", () => {
  test("reload memanggil onComments dengan hasil", async () => {
    const dimuat: DesignComment[][] = [];
    const loader = createCommentLoader({
      load: async () => ({ comments: [komentar("c_1")], mtime: 1 }),
      onComments: (comments) => dimuat.push(comments),
      onError: () => {},
    });

    await loader.reload();
    expect(dimuat).toEqual([[komentar("c_1")]]);
  });

  test("hasil lama diabaikan setelah invalidate", async () => {
    const dimuat: DesignComment[][] = [];
    let release: (() => void) | undefined;
    const loader = createCommentLoader({
      load: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { comments: [komentar("c_lama")], mtime: 1 };
      },
      onComments: (comments) => dimuat.push(comments),
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
    const loader = createCommentLoader({
      load: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new ApiError("gagal", 500);
      },
      onComments: () => {},
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
    const loader = createCommentLoader({
      load: async () => {
        throw new ApiError("Sesi tidak ditemukan.", 404);
      },
      onComments: () => {},
      onError: (message) => galat.push(message),
    });

    await loader.reload();
    expect(galat).toEqual(["Sesi tidak ditemukan."]);
  });

  test("reload kedua memakai hasil terbaru", async () => {
    let nomor = 0;
    const dimuat: DesignComment[][] = [];
    const loader = createCommentLoader({
      load: async () => {
        nomor += 1;
        return { comments: [komentar(`c_${nomor}`)], mtime: nomor };
      },
      onComments: (comments) => dimuat.push(comments),
      onError: () => {},
    });

    await loader.reload();
    await loader.reload();
    expect(dimuat.map((daftar) => daftar[0]?.id)).toEqual(["c_1", "c_2"]);
  });
});
