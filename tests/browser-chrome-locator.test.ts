import { describe, expect, test } from "bun:test";
import { locateChrome } from "../src/server/browser/chrome-locator";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_CHROMIUM = "/Applications/Chromium.app/Contents/MacOS/Chromium";
const MAC_EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const MAC_BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

describe("locateChrome", () => {
  test("JEJAK_CHROME_PATH menang bila berkasnya ada", () => {
    const found = locateChrome({ JEJAK_CHROME_PATH: "/custom/chrome" }, "linux", (path) =>
      path === "/custom/chrome",
    );
    expect(found).toBe("/custom/chrome");
  });

  test("JEJAK_CHROME_PATH diabaikan bila berkasnya tak ada", () => {
    const found = locateChrome({ JEJAK_CHROME_PATH: "/custom/chrome" }, "darwin", () => false);
    expect(found).toBeUndefined();
  });

  test("macOS memakai urutan Google Chrome, Chromium, Edge, Brave", () => {
    expect(locateChrome({}, "darwin", () => true)).toBe(MAC_CHROME);
    expect(locateChrome({}, "darwin", (path) => path === MAC_CHROMIUM)).toBe(MAC_CHROMIUM);
    expect(locateChrome({}, "darwin", (path) => path === MAC_EDGE)).toBe(MAC_EDGE);
    expect(locateChrome({}, "darwin", (path) => path === MAC_BRAVE)).toBe(MAC_BRAVE);
  });

  test("Linux mencari nama di PATH lalu /usr/bin", () => {
    const env = { PATH: "/opt/bin:/usr/local/bin" };
    expect(locateChrome(env, "linux", (path) => path === "/opt/bin/google-chrome")).toBe(
      "/opt/bin/google-chrome",
    );
    expect(locateChrome(env, "linux", (path) => path === "/usr/bin/chromium")).toBe(
      "/usr/bin/chromium",
    );
    expect(locateChrome(env, "linux", (path) => path === "/usr/bin/microsoft-edge")).toBe(
      "/usr/bin/microsoft-edge",
    );
  });

  test("Linux memprioritaskan nama lebih awal walau di /usr/bin", () => {
    const env = { PATH: "/opt/bin" };
    const found = locateChrome(
      env,
      "linux",
      (path) => path === "/opt/bin/chromium" || path === "/usr/bin/google-chrome",
    );
    expect(found).toBe("/usr/bin/google-chrome");
  });

  test("Windows memakai Program Files, Program Files (x86), lalu LocalAppData", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\uji\\AppData\\Local",
    };
    expect(
      locateChrome(
        env,
        "win32",
        (path) => path === "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      ),
    ).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(
      locateChrome(
        env,
        "win32",
        (path) => path === "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ),
    ).toBe("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
    expect(
      locateChrome(
        env,
        "win32",
        (path) => path === "C:\\Users\\uji\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      ),
    ).toBe("C:\\Users\\uji\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
    expect(
      locateChrome(
        env,
        "win32",
        (path) => path === "C:\\Users\\uji\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
      ),
    ).toBe("C:\\Users\\uji\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe");
  });

  test("tak ada Chrome sama sekali -> undefined", () => {
    expect(locateChrome({}, "darwin", () => false)).toBeUndefined();
    expect(locateChrome({ PATH: "/opt/bin" }, "linux", () => false)).toBeUndefined();
    expect(locateChrome({}, "win32", () => false)).toBeUndefined();
  });
});
