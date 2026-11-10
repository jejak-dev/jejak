import { describe, expect, test } from "bun:test";
import { instruksiHash, parseHashRoute } from "../src/client/lib/format";

describe("rute instruksi", () => {
  test("hash dan parsing", () => {
    expect(instruksiHash()).toBe("#/instruksi");
    expect(parseHashRoute(instruksiHash())).toEqual({ view: "instruksi" });
    expect(parseHashRoute("#/instruksi")).toEqual({ view: "instruksi" });
    expect(parseHashRoute("#/instruksi/")).toEqual({});
    expect(parseHashRoute("#/instruksix")).toEqual({});
  });
});
