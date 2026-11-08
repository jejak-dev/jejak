import { describe, expect, test } from "bun:test";
import {
  BYPASS_WARNING,
  canSubmitMode,
  showsBypassMarker,
  storableMode,
  storedModeFrom,
} from "../src/client/lib/permission-mode";

describe("canSubmitMode", () => {
  test("mode bypass butuh centang, mode lain tidak", () => {
    expect(canSubmitMode("bypassPermissions", false)).toBe(false);
    expect(canSubmitMode("bypassPermissions", true)).toBe(true);
    expect(canSubmitMode("default", false)).toBe(true);
    expect(canSubmitMode("acceptEdits", false)).toBe(true);
    expect(canSubmitMode("plan", false)).toBe(true);
  });
});

describe("storableMode", () => {
  test("bypass tidak pernah disimpan, mode lain tersimpan apa adanya", () => {
    expect(storableMode("bypassPermissions")).toBeUndefined();
    expect(storableMode("default")).toBe("default");
    expect(storableMode("acceptEdits")).toBe("acceptEdits");
    expect(storableMode("plan")).toBe("plan");
  });
});

describe("storedModeFrom", () => {
  test("bypass dan nilai asing dibaca sebagai default", () => {
    expect(storedModeFrom("bypassPermissions")).toBe("default");
    expect(storedModeFrom(null)).toBe("default");
    expect(storedModeFrom(undefined)).toBe("default");
    expect(storedModeFrom("")).toBe("default");
    expect(storedModeFrom("aneh")).toBe("default");
    expect(storedModeFrom("acceptEdits")).toBe("acceptEdits");
    expect(storedModeFrom("plan")).toBe("plan");
  });
});

describe("showsBypassMarker", () => {
  test("hanya sesi bermode bypass yang diberi penanda", () => {
    expect(showsBypassMarker("bypassPermissions")).toBe(true);
    expect(showsBypassMarker("default")).toBe(false);
    expect(showsBypassMarker(undefined)).toBe(false);
  });
});

describe("BYPASS_WARNING", () => {
  test("teks peringatan persis dari desain", () => {
    expect(BYPASS_WARNING).toBe(
      "Agent akan menjalankan perintah dan mengubah berkas tanpa bertanya, dengan hak akses akunmu. Instruksi tersembunyi di berkas atau halaman web bisa ikut dijalankan.",
    );
  });
});

