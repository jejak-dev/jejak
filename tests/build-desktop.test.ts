import { describe, expect, test } from "bun:test";
import {
  bundlesForTarget,
  buildSteps,
  parseDesktopArgs,
  tauriArgs,
} from "../scripts/build-desktop";

describe("bundlesForTarget", () => {
  test("macOS menghasilkan app dan dmg", () => {
    expect(bundlesForTarget("bun-darwin-arm64")).toEqual(["app", "dmg"]);
    expect(bundlesForTarget("bun-darwin-x64")).toEqual(["app", "dmg"]);
  });

  test("Windows menghasilkan nsis", () => {
    expect(bundlesForTarget("bun-windows-x64")).toEqual(["nsis"]);
  });

  test("Linux menghasilkan deb", () => {
    expect(bundlesForTarget("bun-linux-x64")).toEqual(["deb"]);
  });

  test("target tak dikenal ditolak", () => {
    expect(() => bundlesForTarget("bun-freebsd-x64")).toThrow(/Target tidak dikenal/);
  });
});

describe("tauriArgs", () => {
  test("argumen build untuk macOS arm64", () => {
    expect(tauriArgs("bun-darwin-arm64")).toEqual([
      "build",
      "--bundles",
      "app,dmg",
      "--target",
      "aarch64-apple-darwin",
    ]);
  });

  test("mode debug menambah --debug", () => {
    expect(tauriArgs("bun-darwin-arm64", { debug: true })).toEqual([
      "build",
      "--debug",
      "--bundles",
      "app,dmg",
      "--target",
      "aarch64-apple-darwin",
    ]);
  });

  test("windows memakai nsis dan triple windows", () => {
    expect(tauriArgs("bun-windows-x64")).toEqual([
      "build",
      "--bundles",
      "nsis",
      "--target",
      "x86_64-pc-windows-msvc",
    ]);
  });
});

describe("parseDesktopArgs", () => {
  test("tanpa argumen dipakai target bawaan", () => {
    const parsed = parseDesktopArgs([], "bun-darwin-arm64");
    expect(parsed.target).toBe("bun-darwin-arm64");
    expect(parsed.debug).toBe(false);
    expect(parsed.error).toBeUndefined();
  });

  test("--target dibaca", () => {
    const parsed = parseDesktopArgs(["--target", "bun-windows-x64"], null);
    expect(parsed.target).toBe("bun-windows-x64");
    expect(parsed.error).toBeUndefined();
  });

  test("--target= dituliskan", () => {
    const parsed = parseDesktopArgs(["--target=bun-darwin-x64"], null);
    expect(parsed.target).toBe("bun-darwin-x64");
  });

  test("--debug dibaca", () => {
    const parsed = parseDesktopArgs(["--debug"], "bun-darwin-arm64");
    expect(parsed.debug).toBe(true);
    expect(parsed.target).toBe("bun-darwin-arm64");
  });

  test("target tak dikenal ditolak", () => {
    const parsed = parseDesktopArgs(["--target", "bun-freebsd-x64"], null);
    expect(parsed.target).toBeNull();
    expect(parsed.error).toMatch(/Target tidak dikenal/);
  });

  test("--target tanpa nilai ditolak", () => {
    const parsed = parseDesktopArgs(["--target"], null);
    expect(parsed.target).toBeNull();
    expect(parsed.error).toBe("--target butuh nilai.");
  });

  test("argumen tak dikenal ditolak", () => {
    const parsed = parseDesktopArgs(["--wat"], "bun-darwin-arm64");
    expect(parsed.target).toBeNull();
    expect(parsed.error).toMatch(/Argumen tidak dikenal/);
  });

  test("platform tanpa target sah ditolak", () => {
    const parsed = parseDesktopArgs([], null);
    expect(parsed.target).toBeNull();
    expect(parsed.error).toMatch(/tak punya target sah/);
  });
});

describe("buildSteps", () => {
  test("urutan: binary, sidecar, bundel", () => {
    const langkah = buildSteps("bun-darwin-arm64");
    expect(langkah).toHaveLength(3);
    expect(langkah[0]?.command).toEqual([
      "bun",
      "run",
      "build:binary",
      "--target",
      "bun-darwin-arm64",
    ]);
    expect(langkah[1]?.command).toEqual([
      "bun",
      "run",
      "stage:sidecar",
      "--target",
      "bun-darwin-arm64",
    ]);
    expect(langkah[2]?.command).toEqual([
      "bunx",
      "tauri",
      "build",
      "--bundles",
      "app,dmg",
      "--target",
      "aarch64-apple-darwin",
    ]);
  });
});
