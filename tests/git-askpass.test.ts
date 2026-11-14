import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POSIX_ASKPASS,
  WINDOWS_ASKPASS,
  askpassFile,
  writeAskpass,
} from "../src/server/git/askpass";

/** Isi askpass POSIX yang harus persis sama dengan versi lama. */
const POSIX_SKRIP = '#!/bin/sh\ncase "$1" in\n  Username*) echo oauth2 ;;\n  *) echo "$JEJAK_GIT_TOKEN" ;;\nesac\n';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-askpass-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("askpass POSIX memakai askpass.sh dengan isi tetap", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const file = askpassFile(platform);
    expect(file.name).toBe("askpass.sh");
    expect(file.content).toBe(POSIX_ASKPASS);
    expect(file.content).toBe(POSIX_SKRIP);
    expect(file.mode).toBe(0o700);
  }
});

test("askpass Windows memakai askpass.cmd dengan akhiran CRLF", () => {
  const file = askpassFile("win32");
  expect(file.name).toBe("askpass.cmd");
  expect(file.content).toBe(WINDOWS_ASKPASS);
  // Semua baris diakhiri CRLF; tidak ada baris LF telanjang.
  expect(file.content).toContain("\r\n");
  expect(file.content.replace(/\r\n/g, "")).not.toContain("\n");
  expect(file.content).toContain("JEJAK_GIT_TOKEN");
  expect(file.content).toContain("oauth2");
});

test("writeAskpass menulis berkas, idempoten, dan memperbaiki isi berbeda", async () => {
  const path = writeAskpass(dir, "darwin");
  expect(path).toBe(join(dir, "askpass.sh"));
  expect(await readFile(path, "utf8")).toBe(POSIX_SKRIP);

  // Panggilan kedua tidak menulis ulang berkas (isi sudah sama).
  const mtimeAwal = (await stat(path)).mtimeMs;
  await Bun.sleep(20);
  expect(writeAskpass(dir, "darwin")).toBe(path);
  expect((await stat(path)).mtimeMs).toBe(mtimeAwal);
  expect(await readFile(path, "utf8")).toBe(POSIX_SKRIP);

  // Isi yang berbeda diperbaiki kembali.
  await writeFile(path, "isi rusak", "utf8");
  writeAskpass(dir, "darwin");
  expect(await readFile(path, "utf8")).toBe(POSIX_SKRIP);
});

test("writeAskpass di POSIX memberi izin 0700", async () => {
  const path = writeAskpass(dir, "linux");
  const info = await stat(path);
  expect(info.mode & 0o777).toBe(0o700);
});

test("writeAskpass di Windows menulis askpass.cmd dengan CRLF", async () => {
  const path = writeAskpass(dir, "win32");
  expect(path).toBe(join(dir, "askpass.cmd"));
  const content = await readFile(path, "utf8");
  expect(content).toBe(WINDOWS_ASKPASS);
  expect(content).toContain("\r\n");
  expect(content.replace(/\r\n/g, "")).not.toContain("\n");
});
