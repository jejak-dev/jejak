import { describe, expect, test } from "bun:test";
import { chromeArgs } from "../src/server/browser/browser-manager";

describe("chromeArgs", () => {
  test("mematikan HTTPS upgrade agar situs http tetap terbuka", () => {
    const fitur = chromeArgs("/tmp/p").find((a) => a.startsWith("--disable-features="));
    expect(fitur).toContain("HttpsUpgrades");
    expect(fitur).toContain("HttpsFirstBalancedModeAutoEnable");
  });
  test("tetap headless dengan profil terpisah", () => {
    const args = chromeArgs("/tmp/p");
    expect(args).toContain("--headless=new");
    expect(args).toContain("--user-data-dir=/tmp/p");
  });
});
