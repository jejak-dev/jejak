import { afterAll, beforeAll, expect, test } from "bun:test";
import { h } from "preact";
import { invalidateCommands, useCommands } from "../src/client/hooks";
import type { ApiClient, CommandListResult } from "../src/client/lib/api";
import { flushEffects, installDom, mount } from "./helpers/dom";

let bersihkan: (() => void) | undefined;
beforeAll(() => {
  bersihkan = installDom();
});
afterAll(() => {
  bersihkan?.();
});

function Probe({ api }: { api: ApiClient }) {
  useCommands(api, "/tmp/proyek", true);
  return h("div", {});
}

test("daftar perintah dimuat ulang setelah cache dibuang", async () => {
  let panggilan = 0;
  const api = {
    listCommands: async (): Promise<CommandListResult> => {
      panggilan += 1;
      return { commands: [], source: "sdk" };
    },
  } as unknown as ApiClient;

  mount(h(Probe, { api }));
  await flushEffects();
  expect(panggilan).toBe(1);

  mount(h(Probe, { api }));
  await flushEffects();
  expect(panggilan).toBe(1); // dari cache

  invalidateCommands(api);
  mount(h(Probe, { api }));
  await flushEffects();
  expect(panggilan).toBe(2);
});
