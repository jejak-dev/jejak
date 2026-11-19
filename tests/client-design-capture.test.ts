import { describe, expect, test } from "bun:test";
import {
  MAX_PARALLEL_CAPTURES,
  MAX_SEEN_CAPTURES,
  createCaptureRunner,
  type CaptureFn,
  type CaptureOutcome,
} from "../src/client/lib/design-capture";
import type { DesignCaptureRequest } from "../src/client/lib/api";

/** Tunggu rantai promise tertunda selesai. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Tunggu sampai kondisi benar; antar-antrean butuh giliran timer nyata. */
async function tungguSampai(kondisi: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (kondisi()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function req(id: string, slug = "beranda", scale: 1 | 2 = 1): DesignCaptureRequest {
  return { id, slug, scale };
}

/** Pelaksana dengan pengunggah yang mencatat hasil. */
function runnerDengan(
  capture: () => CaptureFn | undefined,
  options: { timeoutMs?: number } = {},
) {
  const unggahan: Array<{ requestId: string; body: CaptureOutcome }> = [];
  const runner = createCaptureRunner({
    capture,
    upload: async (requestId, body) => {
      unggahan.push({ requestId, body });
    },
    ...options,
  });
  return { runner, unggahan };
}

describe("createCaptureRunner", () => {
  test("setiap id diproses sekali walau muncul di beberapa putaran", async () => {
    const panggilan: string[] = [];
    const { runner, unggahan } = runnerDengan(() => async (slug, scale, requestId) => {
      panggilan.push(requestId);
      return { dataUrl: "data:image/png;base64,AAAA" };
    });

    runner.handle([req("k_1")]);
    runner.handle([req("k_1"), req("k_2")]);
    await flush();

    expect(panggilan).toEqual(["k_1", "k_2"]);
    expect(unggahan.map((item) => item.requestId)).toEqual(["k_1", "k_2"]);
  });

  test("capture undefined mengunggah no-frame", async () => {
    const { runner, unggahan } = runnerDengan(() => undefined);

    runner.handle([req("k_1")]);
    await flush();

    expect(unggahan).toEqual([{ requestId: "k_1", body: { error: "no-frame" } }]);
  });

  test("timeout mengunggah failed dan hasil terlambat diabaikan", async () => {
    let lepas: ((outcome: CaptureOutcome) => void) | undefined;
    const { runner, unggahan } = runnerDengan(
      () => () =>
        new Promise<CaptureOutcome>((resolve) => {
          lepas = resolve;
        }),
      { timeoutMs: 5 },
    );

    runner.handle([req("k_1")]);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(unggahan).toEqual([{ requestId: "k_1", body: { error: "failed" } }]);

    lepas?.({ dataUrl: "data:image/png;base64,AAAA" });
    await flush();
    expect(unggahan).toHaveLength(1);
  });

  test("promise yang menolak menjadi failed", async () => {
    const { runner, unggahan } = runnerDengan(() => async () => {
      throw new Error("kanvas rusak");
    });

    runner.handle([req("k_1")]);
    await flush();

    expect(unggahan).toEqual([{ requestId: "k_1", body: { error: "failed" } }]);
  });

  test("galat unggah ditelan tanpa melempar", async () => {
    const runner = createCaptureRunner({
      capture: () => async () => ({ dataUrl: "data:image/png;base64,AAAA" }),
      upload: async () => {
        throw new Error("server mati");
      },
    });

    expect(() => runner.handle([req("k_1")])).not.toThrow();
    await flush();
  });

  test("paling banyak tiga tangkapan berjalan serentak", async () => {
    let berjalan = 0;
    let puncak = 0;
    const pelepas: Array<() => void> = [];
    const { runner, unggahan } = runnerDengan(() => async () => {
      berjalan += 1;
      puncak = Math.max(puncak, berjalan);
      await new Promise<void>((resolve) => {
        pelepas.push(resolve);
      });
      berjalan -= 1;
      return { dataUrl: "data:image/png;base64,AAAA" };
    });

    runner.handle([req("k_1"), req("k_2"), req("k_3"), req("k_4"), req("k_5")]);
    await flush();
    expect(puncak).toBe(MAX_PARALLEL_CAPTURES);
    expect(unggahan).toHaveLength(0);

    while (pelepas.length > 0) {
      pelepas.shift()?.();
      await flush();
    }
    expect(unggahan.map((item) => item.requestId).sort()).toEqual([
      "k_1",
      "k_2",
      "k_3",
      "k_4",
      "k_5",
    ]);
    expect(puncak).toBeLessThanOrEqual(MAX_PARALLEL_CAPTURES);
  });

  test("ingatan id dibatasi; id tertua boleh diproses lagi", async () => {
    const panggilan: string[] = [];
    const { runner } = runnerDengan(() => async (slug, scale, requestId) => {
      panggilan.push(requestId);
      return { dataUrl: "data:image/png;base64,AAAA" };
    });

    const awal = Array.from({ length: MAX_SEEN_CAPTURES }, (_, i) => req(`k_${i}`));
    runner.handle(awal);
    await tungguSampai(() => panggilan.length === MAX_SEEN_CAPTURES);
    expect(panggilan).toHaveLength(MAX_SEEN_CAPTURES);
    runner.handle([req("k_0")]);
    await flush();
    expect(panggilan).toHaveLength(MAX_SEEN_CAPTURES);

    runner.handle([req("k_baru")]);
    await tungguSampai(() => panggilan.includes("k_baru"));
    runner.handle([req("k_0")]);
    await tungguSampai(() => panggilan.filter((id) => id === "k_0").length === 2);
    expect(panggilan.filter((id) => id === "k_0")).toHaveLength(2);
  });
});
