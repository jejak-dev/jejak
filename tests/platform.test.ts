import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { isWindows, nullDevice, pathApi, toSlash } from "../src/server/platform";

describe("isWindows", () => {
  test("hanya win32 yang dianggap Windows", () => {
    expect(isWindows("win32")).toBe(true);
    expect(isWindows("darwin")).toBe(false);
    expect(isWindows("linux")).toBe(false);
  });

  test("bawaan mengikuti platform proses", () => {
    expect(isWindows()).toBe(process.platform === "win32");
  });
});

describe("nullDevice", () => {
  test("NUL di Windows dan /dev/null di POSIX", () => {
    expect(nullDevice("win32")).toBe("NUL");
    expect(nullDevice("darwin")).toBe("/dev/null");
    expect(nullDevice("linux")).toBe("/dev/null");
  });

  test("bawaan mengikuti platform proses", () => {
    expect(nullDevice()).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
  });
});

describe("pathApi", () => {
  test("mengembalikan modul path sesuai platform", () => {
    expect(pathApi("win32")).toBe(win32);
    expect(pathApi("darwin")).toBe(posix);
    expect(pathApi("linux")).toBe(posix);
  });

  test("bawaan mengikuti platform proses", () => {
    expect(pathApi()).toBe(process.platform === "win32" ? win32 : posix);
  });
});

describe("toSlash", () => {
  test("pemisah Windows menjadi garis miring, POSIX tak berubah", () => {
    expect(toSlash("C:\\Users\\x\\proj")).toBe("C:/Users/x/proj");
    expect(toSlash("\\\\server\\share\\berkas")).toBe("//server/share/berkas");
    expect(toSlash("/Users/x/proj")).toBe("/Users/x/proj");
    expect(toSlash("")).toBe("");
  });
});
