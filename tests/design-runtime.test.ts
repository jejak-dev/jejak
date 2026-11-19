import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePage } from "../src/server/design/assemble";
import {
  RUNTIME_SOURCE,
  buildRuntimeSource,
  frameRuntimeScript,
} from "../src/server/design/runtime";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-runtime-"));
  await mkdir(join(dir, "design", "pages"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("frameRuntimeScript", () => {
  test("membungkus sumber dengan tag skrip bertanda", () => {
    const hasil = frameRuntimeScript("beranda");
    expect(hasil.startsWith("<script data-jejak-design-runtime>")).toBe(true);
    expect(hasil.endsWith("</script>")).toBe(true);
    expect(hasil).toContain('"beranda"');
  });

  test("sumber tidak memuat teks penutup skrip", () => {
    expect(RUNTIME_SOURCE.includes("</script")).toBe(false);
    expect(buildRuntimeSource("beranda").includes("</script")).toBe(false);
  });

  test("sumber dapat dikompilasi tanpa dijalankan", () => {
    const sumber = buildRuntimeSource("beranda");
    expect(() => new Function(sumber)).not.toThrow();
  });

  test("cabang capture dan pesan shot ada di sumber", () => {
    const sumber = buildRuntimeSource("beranda");
    expect(sumber).toContain('data.type === "capture"');
    expect(sumber).toContain('"shot-error"');
    expect(sumber).toContain('type: "shot"');
    expect(() => new Function(sumber)).not.toThrow();
  });

  test("cabang pins dan gambarPin ada di sumber", () => {
    const sumber = buildRuntimeSource("beranda");
    expect(sumber).toContain('data.type === "pins"');
    expect(sumber).toContain("function gambarPin()");
    expect(sumber).toContain('data-jejak-pin');
    expect(sumber).toContain('type: "pin"');
    expect(() => new Function(sumber)).not.toThrow();
  });

  test("slug aneh ter-escape dan tidak menutup tag skrip", () => {
    const jahat = '</script><b>"  ';
    const sumber = buildRuntimeSource(jahat);
    expect(sumber.includes("</script")).toBe(false);
    expect(sumber.includes(" ")).toBe(false);
    expect(sumber.includes(" ")).toBe(false);
    expect(() => new Function(sumber)).not.toThrow();
    const skrip = frameRuntimeScript(jahat);
    expect(skrip.split("</script").length - 1).toBe(1);
  });
});

describe("assemblePage menyisipkan runtime", () => {
  test("skrip runtime bersama slug tepat sebelum </body>", async () => {
    await writeFile(
      join(dir, "design", "pages", "beranda.html"),
      "<html><body><p>x</p></body></html>",
      "utf8",
    );
    const hasil = await assemblePage(dir, "beranda");
    const skrip = frameRuntimeScript("beranda");
    expect(hasil.html).toContain(`${skrip}</body>`);
  });
});
