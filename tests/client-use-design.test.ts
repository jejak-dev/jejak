import { describe, expect, test } from "bun:test";
import type { DesignResult } from "../src/client/lib/api";
import {
  DESIGN_POLL_MS,
  createDesignPoller,
  type DesignTimers,
} from "../src/client/lib/use-design";

const DESIGN: DesignResult = {
  exists: true,
  pages: [],
  tokens: { mtime: null },
  warnings: [],
};

/** Timer palsu: interval disimpan dan dipicu manual. */
function fakeTimers() {
  const callbacks: Array<() => void> = [];
  const cleared: unknown[] = [];
  const timers: DesignTimers = {
    setInterval(callback) {
      callbacks.push(callback);
      return callbacks.length;
    },
    clearInterval(handle) {
      cleared.push(handle);
    },
  };
  return {
    timers,
    cleared,
    get count(): number {
      return callbacks.length;
    },
    tick(): void {
      for (const callback of callbacks) callback();
    },
  };
}

/** Tunggu seluruh rantai promise yang tertunda selesai. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("createDesignPoller", () => {
  test("start memuat sekali lalu memasang interval", async () => {
    const jam = fakeTimers();
    const dimuat: DesignResult[] = [];
    const poller = createDesignPoller({
      load: async () => DESIGN,
      stamp: async () => "s1",
      onDesign: (design) => dimuat.push(design),
      onError: () => {},
      timers: jam.timers,
    });

    expect(poller.start()).toBe(true);
    await flush();
    expect(dimuat).toEqual([DESIGN]);
    expect(jam.count).toBe(1);
    expect(DESIGN_POLL_MS).toBe(1500);
  });

  test("start kedua tidak memasang interval baru", async () => {
    const jam = fakeTimers();
    const poller = createDesignPoller({
      load: async () => DESIGN,
      stamp: async () => "s1",
      onDesign: () => {},
      onError: () => {},
      timers: jam.timers,
    });

    poller.start();
    expect(poller.start()).toBe(false);
    await flush();
    expect(jam.count).toBe(1);
  });

  test("cap berubah memicu muat ulang penuh", async () => {
    const jam = fakeTimers();
    let stamp = "s1";
    let loads = 0;
    const poller = createDesignPoller({
      load: async () => {
        loads += 1;
        return DESIGN;
      },
      stamp: async () => stamp,
      onDesign: () => {},
      onError: () => {},
      timers: jam.timers,
    });

    poller.start();
    await flush();
    expect(loads).toBe(1);

    jam.tick();
    await flush();
    expect(loads).toBe(1);

    stamp = "s2";
    jam.tick();
    await flush();
    expect(loads).toBe(2);
  });

  test("putaran dilewati bila putaran sebelumnya belum selesai", async () => {
    const jam = fakeTimers();
    let stampCalls = 0;
    let release: (() => void) | undefined;
    const poller = createDesignPoller({
      load: async () => DESIGN,
      stamp: async () => {
        stampCalls += 1;
        if (stampCalls === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return "s1";
      },
      onDesign: () => {},
      onError: () => {},
      timers: jam.timers,
    });

    poller.start();
    await flush();
    expect(stampCalls).toBe(1);

    jam.tick();
    jam.tick();
    await flush();
    expect(stampCalls).toBe(2);

    release?.();
    await flush();
    jam.tick();
    await flush();
    expect(stampCalls).toBe(3);
  });

  test("galat jaringan menjadi onError tanpa menghentikan polling", async () => {
    const jam = fakeTimers();
    const galat: string[] = [];
    let stampCalls = 0;
    const poller = createDesignPoller({
      load: async () => DESIGN,
      stamp: async () => {
        stampCalls += 1;
        if (stampCalls === 2) throw new Error("jaringan putus");
        return "s1";
      },
      onDesign: () => {},
      onError: (message) => galat.push(message),
      timers: jam.timers,
    });

    poller.start();
    await flush();
    jam.tick();
    await flush();
    expect(galat).toEqual(["jaringan putus"]);

    jam.tick();
    await flush();
    expect(stampCalls).toBe(3);
  });

  test("stop menghentikan timer dan mengabaikan hasil yang datang", async () => {
    const jam = fakeTimers();
    const dimuat: DesignResult[] = [];
    let release: (() => void) | undefined;
    const poller = createDesignPoller({
      load: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return DESIGN;
      },
      stamp: async () => "s1",
      onDesign: (design) => dimuat.push(design),
      onError: () => {},
      timers: jam.timers,
    });

    poller.start();
    poller.stop();
    release?.();
    await flush();

    expect(dimuat).toEqual([]);
    expect(jam.cleared).toEqual([1]);
  });

  test("refresh memuat ulang walau cap sama", async () => {
    const jam = fakeTimers();
    let loads = 0;
    const poller = createDesignPoller({
      load: async () => {
        loads += 1;
        return DESIGN;
      },
      stamp: async () => "s1",
      onDesign: () => {},
      onError: () => {},
      timers: jam.timers,
    });

    poller.start();
    await flush();
    await poller.refresh();
    expect(loads).toBe(2);
  });

  test("onCaptures dipanggil tiap putaran walau stamp tak berubah", async () => {
    const jam = fakeTimers();
    const permintaan: string[][] = [];
    const poller = createDesignPoller({
      load: async () => DESIGN,
      stamp: async () => ({
        stamp: "s1",
        captures: [{ id: "k_1", slug: "beranda", scale: 1 }],
      }),
      onDesign: () => {},
      onError: () => {},
      onCaptures: (requests) => permintaan.push(requests.map((item) => item.id)),
      timers: jam.timers,
    });

    poller.start();
    await flush();
    jam.tick();
    await flush();
    jam.tick();
    await flush();

    // Putaran pertama hanya terjadi lewat interval: `start` memakai refresh.
    expect(permintaan).toEqual([["k_1"], ["k_1"]]);
  });

  test("onCaptures tidak dipanggil saat permintaan kosong", async () => {
    const jam = fakeTimers();
    let panggilan = 0;
    const poller = createDesignPoller({
      load: async () => DESIGN,
      stamp: async () => ({ stamp: "s1", captures: [] }),
      onDesign: () => {},
      onError: () => {},
      onCaptures: () => {
        panggilan += 1;
      },
      timers: jam.timers,
    });

    poller.start();
    await flush();
    jam.tick();
    await flush();

    expect(panggilan).toBe(0);
  });

  test("stamp berbentuk string lama tetap bekerja", async () => {
    const jam = fakeTimers();
    const dimuat: DesignResult[] = [];
    const permintaan: unknown[] = [];
    const poller = createDesignPoller({
      load: async () => DESIGN,
      stamp: async () => "s1",
      onDesign: (design) => dimuat.push(design),
      onError: () => {},
      onCaptures: (requests) => permintaan.push(requests),
      timers: jam.timers,
    });

    poller.start();
    await flush();
    jam.tick();
    await flush();

    expect(dimuat).toEqual([DESIGN]);
    expect(permintaan).toEqual([]);
    expect(jam.count).toBe(1);
  });
});
