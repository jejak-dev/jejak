import { expect, test } from "bun:test";
import { createApp } from "../src/server";
import { VERSION } from "../src/shared/version";

const POLA_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

test("VERSION sama dengan versi di package.json", async () => {
  const isi = await Bun.file(new URL("../package.json", import.meta.url)).text();
  const pkg = JSON.parse(isi) as { version?: string };
  expect(pkg.version).toBeDefined();
  expect(VERSION).toBe(pkg.version as string);
});

test("VERSION cocok pola semver", () => {
  expect(VERSION).toMatch(POLA_SEMVER);
});

test("GET /api/health memuat VERSION", async () => {
  const res = await createApp().handle(new Request("http://localhost/api/health"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; name: string; version: string };
  expect(body.version).toBe(VERSION);
});
