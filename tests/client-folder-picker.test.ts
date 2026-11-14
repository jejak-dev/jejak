import { describe, expect, test } from "bun:test";
import { shortenPath } from "../src/client/lib/folder-picker";

describe("shortenPath", () => {
  test("path pendek tidak berubah", () => {
    expect(shortenPath("/tmp", 20)).toBe("/tmp");
    expect(shortenPath("/Users/boy/Developer", 20)).toBe("/Users/boy/Developer");
    expect(shortenPath("/Users/boy", 10)).toBe("/Users/boy");
  });

  test("path panjang dipotong dengan … dan nama folder terakhir tetap", () => {
    const path = "/Users/boy/Developer/kantor/alpha/service-backend";
    const short = shortenPath(path, 24);

    expect(short.length).toBeLessThanOrEqual(24);
    expect(short).toContain("…");
    expect(short.endsWith("service-backend")).toBe(true);
    expect(short).not.toContain("/kantor/");
  });

  test("path akar dan path satu segmen", () => {
    expect(shortenPath("/", 10)).toBe("/");
    expect(shortenPath("/", 1)).toBe("/");
    expect(shortenPath("/sangat-panjang-sekali", 8)).toBe("…-sekali");
  });

  test("max kecil tetap menghasilkan elipsis dan ekor nama", () => {
    expect(shortenPath("/a/b/cdefghij", 6)).toBe("…fghij");
    expect(shortenPath("/a/b/cdefghij", 1)).toBe("…");
    expect(shortenPath("/a/b/cdefghij", 0)).toBe("");
  });
});
