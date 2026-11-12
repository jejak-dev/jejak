import { describe, expect, test } from "bun:test";
import {
  SERVICE_WORKER_PATH,
  isServiceWorkerDisabled,
  registerServiceWorker,
  type NavigatorLike,
  type WindowLike,
} from "../src/client/lib/pwa";

interface FakeWindow extends WindowLike {
  listeners: Map<string, () => void>;
  search: string;
}

function buatWindow(search = ""): FakeWindow {
  const listeners = new Map<string, () => void>();
  return {
    listeners,
    search,
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener);
    },
    location: { get search() {
      return search;
    } },
  } as FakeWindow;
}

describe("pendaftaran service worker", () => {
  test("tanpa dukungan service worker tidak melempar dan tidak mendaftar", () => {
    const win = buatWindow();
    const nav = {} as NavigatorLike;
    expect(() => registerServiceWorker(nav, win)).not.toThrow();
    expect(win.listeners.size).toBe(0);
  });

  test("mendaftarkan /sw.js sesudah event load", async () => {
    const calls: string[] = [];
    const nav: NavigatorLike = {
      serviceWorker: {
        register(path: string) {
          calls.push(path);
          return Promise.resolve({});
        },
      },
    };
    const win = buatWindow();
    registerServiceWorker(nav, win);
    expect(calls).toEqual([]);
    win.listeners.get("load")?.();
    await Bun.sleep(1);
    expect(calls).toEqual([SERVICE_WORKER_PATH]);
    expect(calls[0]).toBe("/sw.js");
  });

  test("galat pendaftaran ditelan dan tidak melempar", async () => {
    const nav: NavigatorLike = {
      serviceWorker: {
        register() {
          throw new Error("ditolak");
        },
      },
    };
    const win = buatWindow();
    expect(() => registerServiceWorker(nav, win)).not.toThrow();
    expect(() => win.listeners.get("load")?.()).not.toThrow();

    const navGagal: NavigatorLike = {
      serviceWorker: {
        register() {
          return Promise.reject(new Error("ditolak"));
        },
      },
    };
    const winGagal = buatWindow();
    expect(() => registerServiceWorker(navGagal, winGagal)).not.toThrow();
    expect(() => winGagal.listeners.get("load")?.()).not.toThrow();
    await Bun.sleep(10);
  });

  test("?nosw=1 mematikan pendaftaran", () => {
    const calls: string[] = [];
    const nav: NavigatorLike = {
      serviceWorker: {
        register(path: string) {
          calls.push(path);
          return Promise.resolve({});
        },
      },
    };
    const win = buatWindow("?nosw=1");
    expect(isServiceWorkerDisabled(win)).toBe(true);
    registerServiceWorker(nav, win);
    expect(win.listeners.size).toBe(0);
    expect(calls).toEqual([]);
  });

  test("tanpa parameter ?nosw pendaftaran tetap jalan", () => {
    const win = buatWindow("");
    expect(isServiceWorkerDisabled(win)).toBe(false);
    expect(isServiceWorkerDisabled(undefined)).toBe(false);
  });
});
