import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIDECAR_NAME,
  parseStageArgs,
  planStage,
  sidecarFileName,
  stageSidecar,
  tripleForBuildTarget,
} from "../scripts/stage-sidecar";

describe("tripleForBuildTarget", () => {
  test("memetakan target build ke triple Rust", () => {
    expect(tripleForBuildTarget("bun-darwin-arm64")).toBe("aarch64-apple-darwin");
    expect(tripleForBuildTarget("bun-darwin-x64")).toBe("x86_64-apple-darwin");
    expect(tripleForBuildTarget("bun-windows-x64")).toBe(
      "x86_64-pc-windows-msvc",
    );
  });

  test("target lain galat dengan pesan jelas", () => {
    expect(() => tripleForBuildTarget("bun-linux-arm64")).toThrow(
      /Target tidak dikenal/,
    );
    expect(() => tripleForBuildTarget("")).toThrow(/Target tidak dikenal/);
  });
});

describe("sidecarFileName", () => {
  test("memakai nama dasar dan triple", () => {
    expect(sidecarFileName("bun-darwin-arm64")).toBe(
      "jejak-aarch64-apple-darwin",
    );
    expect(sidecarFileName("bun-darwin-x64")).toBe("jejak-x86_64-apple-darwin");
  });

  test("windows memakai akhiran .exe", () => {
    expect(sidecarFileName("bun-windows-x64")).toBe(
      "jejak-x86_64-pc-windows-msvc.exe",
    );
  });
});

describe("planStage", () => {
  test("sumber dari keluaran build dan tujuan di folder binaries", () => {
    const rencana = planStage("bun-darwin-arm64", "/tmp/bin");
    expect(rencana.source.endsWith("jejak-darwin-arm64")).toBe(true);
    expect(rencana.destination).toBe("/tmp/bin/jejak-aarch64-apple-darwin");
  });
});

describe("parseStageArgs", () => {
  test("tanpa argumen memakai target bawaan", () => {
    const parsed = parseStageArgs([], "bun-darwin-arm64");
    expect(parsed.error).toBeUndefined();
    expect(parsed.targets).toEqual(["bun-darwin-arm64"]);
  });

  test("--target menerima nilai dan bentuk sama", () => {
    expect(parseStageArgs(["--target", "bun-windows-x64"], "bun-darwin-arm64").targets).toEqual([
      "bun-windows-x64",
    ]);
    expect(parseStageArgs(["--target=bun-windows-x64"], "bun-darwin-arm64").targets).toEqual([
      "bun-windows-x64",
    ]);
  });

  test("--all memakai semua target sah", () => {
    const parsed = parseStageArgs(["--all"], "bun-darwin-arm64");
    expect(parsed.error).toBeUndefined();
    expect(parsed.targets).toHaveLength(3);
  });

  test("argumen tak sah memberi pesan jelas", () => {
    expect(parseStageArgs(["--target"], "bun-darwin-arm64").error).toBe(
      "--target butuh nilai.",
    );
    expect(parseStageArgs(["--target", "bun-linux"], "bun-darwin-arm64").error).toContain(
      "Target tidak dikenal",
    );
    expect(parseStageArgs(["--salah"], "bun-darwin-arm64").error).toBe(
      "Argumen tidak dikenal: --salah",
    );
    expect(parseStageArgs(["--all", "--target", "bun-darwin-arm64"], null).error).toContain(
      "tak boleh dipakai bersamaan",
    );
  });

  test("tanpa target bawaan galat", () => {
    expect(parseStageArgs([], null).error).toContain("tak punya target sah");
  });
});

describe("stageSidecar", () => {
  test("menyalin binary dan memberi izin eksekusi", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jejak-stage-"));
    try {
      const source = join(dir, "jejak-darwin-arm64");
      await Bun.write(source, "#!/bin/sh\necho halo\n");
      const tujuan = await stageSidecar("bun-darwin-arm64", {
        sourcePath: source,
        destDir: join(dir, "bin"),
      });
      expect(tujuan.endsWith(`${SIDECAR_NAME}-aarch64-apple-darwin`)).toBe(true);
      expect(await readFile(tujuan, "utf8")).toContain("halo");
      const mode = (await stat(tujuan)).mode & 0o777;
      expect(mode).toBe(0o755);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("binary yang belum dibangun memberi pesan jelas", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jejak-stage-"));
    try {
      const promise = stageSidecar("bun-darwin-arm64", {
        sourcePath: join(dir, "tidak-ada"),
        destDir: join(dir, "bin"),
      });
      await expect(promise).rejects.toThrow(/belum dibangun/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("target tak dikenal dilempar sebelum menyentuh berkas", () => {
    expect(stageSidecar("bun-linux-arm64")).rejects.toThrow(/Target tidak dikenal/);
  });
});
